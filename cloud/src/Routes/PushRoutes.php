<?php
declare(strict_types=1);

namespace Nyza\Routes;

use Nyza\Auth;
use Nyza\Config;
use Nyza\Database;
use Nyza\Json;
use Nyza\Middleware\AuthMiddleware;
use Minishlink\WebPush\Subscription;
use Minishlink\WebPush\VAPID;
use Minishlink\WebPush\WebPush;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;
use Slim\Routing\RouteCollectorProxy;

/**
 * Web Push (VAPID). Per-user, opt-in browser push notifications.
 *
 *  - /api/push/*  (auth): subscribe / unsubscribe / key / test.
 *  - /api/cron    (public, token-guarded): the reminder scheduler a server
 *    cron hits every few minutes. It checks each user's prefs (app_settings
 *    ns 'notifications') and pushes due reminders, deduping via push_sent.
 *
 * The VAPID keypair is generated once on first use and stored in app_kv, so it
 * stays stable across requests (subscriptions are tied to the public key).
 */
final class PushRoutes
{
    /** Notification reminder prefs live under settings ns 'notifications'. */
    private const PREF_NS = 'notifications';
    /** Safety cap: how many users to process per cron run. */
    private const MAX_USERS = 500;

    public static function mount(App $app): void
    {
        $app->group('/api/push', function (RouteCollectorProxy $g) {
            $g->get('/key',          [self::class, 'key']);
            $g->post('/subscribe',   [self::class, 'subscribe']);
            $g->post('/unsubscribe', [self::class, 'unsubscribe']);
            $g->post('/test',        [self::class, 'test']);
        })->add(new AuthMiddleware());

        // Public scheduler entrypoint — NO AuthMiddleware; guarded by ?token=.
        $app->get('/api/cron', [self::class, 'cron']);
    }

    // ───── Authed routes ───────────────────────────────────────────────────────
    public static function key(Request $req, Response $res): Response
    {
        $v = self::vapid();
        return Json::ok($res, ['public_key' => $v['publicKey']]);
    }

    public static function subscribe(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        $endpoint = trim((string)($b['endpoint'] ?? ''));
        $keys = (array)($b['keys'] ?? []);
        $p256dh = trim((string)($keys['p256dh'] ?? ''));
        $auth = trim((string)($keys['auth'] ?? ''));
        if ($endpoint === '' || $p256dh === '' || $auth === '') {
            return Json::err($res, 'Ungültige Subscription', 422);
        }
        if (mb_strlen($endpoint) > 500) $endpoint = mb_substr($endpoint, 0, 500);

        // Upsert by endpoint: re-claim it for this user and refresh the keys.
        Database::pdo()->prepare(
            'INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?) '
            . 'ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), p256dh = VALUES(p256dh), auth = VALUES(auth)'
        )->execute([$uid, $endpoint, $p256dh, $auth]);
        return Json::ok($res, ['ok' => true]);
    }

    public static function unsubscribe(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        $endpoint = trim((string)($b['endpoint'] ?? ''));
        if ($endpoint !== '') {
            Database::pdo()->prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
                ->execute([$uid, $endpoint]);
        }
        return Json::ok($res, ['ok' => true]);
    }

    public static function test(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $r = self::sendToUser($uid, ['title' => 'Nyza Cloud', 'body' => 'Test-Benachrichtigung ✓', 'url' => '/']);
        if (($r['subscriptions'] ?? 0) === 0) return Json::err($res, 'Kein aktives Push-Abo auf diesem Gerät — bitte Benachrichtigungen erneut aktivieren.', 422);
        if (($r['sent'] ?? 0) === 0) return Json::err($res, 'Push abgelehnt: ' . ($r['error'] ?? 'unbekannt'), 502);
        return Json::ok($res, ['ok' => true, 'sent' => $r['sent']]);
    }

    // ───── Helpers ─────────────────────────────────────────────────────────────
    /**
     * Load (or lazily generate + persist) the VAPID keypair. Returns the auth
     * array shape that WebPush expects under auth['VAPID']. The subject must be a
     * valid https URL or mailto: — push services (esp. Apple) reject invalid ones.
     */
    public static function vapid(): array
    {
        $pub = self::kvGet('vapid_public');
        $priv = self::kvGet('vapid_private');
        if ($pub === null || $priv === null || $pub === '' || $priv === '') {
            $keys = VAPID::createVapidKeys();
            $pub = $keys['publicKey'];
            $priv = $keys['privateKey'];
            self::kvSet('vapid_public', $pub);
            self::kvSet('vapid_private', $priv);
        }
        $host = (string)($_SERVER['HTTP_HOST'] ?? '');
        $subject = $host !== '' ? 'https://' . preg_replace('/[^a-zA-Z0-9.\-:]/', '', $host) : 'mailto:admin@nyza-studio.at';
        return [
            'publicKey'  => $pub,
            'privateKey' => $priv,
            'subject'    => $subject,
        ];
    }

    /**
     * Push a payload to every subscription of one user. Expired/gone endpoints
     * (404/410) are pruned. Never throws — returns a small result summary
     * {subscriptions, sent, failed, error} so callers can report status.
     */
    public static function sendToUser(int $uid, array $payload): array
    {
        $out = ['subscriptions' => 0, 'sent' => 0, 'failed' => 0, 'error' => null];
        try {
            $pdo = Database::pdo();
            $s = $pdo->prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?');
            $s->execute([$uid]);
            $subs = $s->fetchAll();
            $out['subscriptions'] = count($subs);
            if (!$subs) return $out;

            $webPush = new WebPush(['VAPID' => self::vapid()]);
            $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

            foreach ($subs as $row) {
                $sub = Subscription::create([
                    'endpoint' => $row['endpoint'],
                    'keys'     => ['p256dh' => $row['p256dh'], 'auth' => $row['auth']],
                ]);
                $webPush->queueNotification($sub, $json);
            }

            $del = $pdo->prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
            foreach ($webPush->flush() as $report) {
                if ($report->isSuccess()) { $out['sent']++; }
                else {
                    $out['failed']++;
                    $out['error'] = $report->getReason() ?: 'rejected';
                    if ($report->isSubscriptionExpired()) $del->execute([$report->getEndpoint()]);
                }
            }
        } catch (\Throwable $e) {
            $out['error'] = $e->getMessage();
        }
        return $out;
    }

    // ───── Cron scheduler ──────────────────────────────────────────────────────
    public static function cron(Request $req, Response $res): Response
    {
        if (!self::cronAuthorized($req)) {
            return Json::err($res, 'Forbidden', 403);
        }
        $result = self::runCron();
        return Json::ok($res, $result);
    }

    /**
     * Authorize the cron call. Accepts, in order:
     *  1. config 'cron_token' (if set) matched against ?token=.
     *  2. otherwise an auto-generated token persisted in app_kv (k='cron_token'),
     *     matched against ?token= — printed once below if you query the DB.
     *  3. a valid admin bearer token (same model the Updater uses) as a fallback.
     */
    /** The effective cron token (config override, else a stable auto-generated one). */
    public static function effectiveCronToken(): string
    {
        $configured = Config::get('cron_token');
        if (is_string($configured) && $configured !== '') return $configured;
        $auto = self::kvGet('cron_token');
        if ($auto === null || $auto === '') {
            $auto = bin2hex(random_bytes(24));
            self::kvSet('cron_token', $auto);
        }
        return (string)$auto;
    }

    private static function cronAuthorized(Request $req): bool
    {
        $given = (string)($req->getQueryParams()['token'] ?? '');

        $configured = Config::get('cron_token');
        if (is_string($configured) && $configured !== '') {
            if (hash_equals($configured, $given)) return true;
        } else {
            // No configured token → use a stable auto-generated one from app_kv.
            $auto = self::kvGet('cron_token');
            if ($auto === null || $auto === '') {
                $auto = bin2hex(random_bytes(24));
                self::kvSet('cron_token', $auto);
            }
            if ($given !== '' && hash_equals($auto, $given)) return true;
        }

        // Fallback: a logged-in admin's bearer token also authorizes the run.
        $p = Auth::fromRequest($req);
        if ($p && !empty($p['sub'])) {
            try {
                $s = Database::pdo()->prepare('SELECT 1 FROM users WHERE id = ? AND active = 1');
                $s->execute([(int)$p['sub']]);
                if ($s->fetch()) return true;
            } catch (\Throwable $e) {
                // fall through
            }
        }
        return false;
    }

    /**
     * Scan all active users and push any due reminders, gated per-user by the
     * 'notifications' prefs (calendar / task_due / invoices / expenses booleans,
     * missing = off). Each send is recorded in push_sent so it fires only once.
     */
    public static function runCron(): array
    {
        $pdo = Database::pdo();
        $now = date('Y-m-d H:i:s');
        $today = date('Y-m-d');

        // Active users that have at least one subscription — no point checking others.
        $s = $pdo->query(
            'SELECT DISTINCT u.id FROM users u '
            . 'JOIN push_subscriptions ps ON ps.user_id = u.id '
            . 'WHERE u.active = 1 LIMIT ' . self::MAX_USERS
        );
        $userIds = array_map(static fn($r) => (int)$r['id'], $s->fetchAll());

        $checked = 0;
        $sent = 0;
        foreach ($userIds as $uid) {
            $checked++;
            $prefs = self::prefs($uid);

            if (!empty($prefs['calendar'])) {
                $sent += self::checkCalendar($uid, $now);
            }
            if (!empty($prefs['task_due'])) {
                $sent += self::checkTasks($uid, $now, $today);
            }
            if (!empty($prefs['invoices'])) {
                $sent += self::checkInvoices($uid, $today);
            }
            if (!empty($prefs['expenses'])) {
                $sent += self::checkExpenses($uid, $today);
            }
        }

        // Auto-import Belege from flagged mailboxes (best-effort; needs php-imap).
        $belege = 0;
        try { $belege = \Nyza\Routes\MailRoutes::cronImport(); } catch (\Throwable $e) {}

        return ['checked_users' => $checked, 'sent' => $sent, 'belege_imported' => $belege];
    }

    /** Timed events starting within the next 15 minutes → reminder. */
    private static function checkCalendar(int $uid, string $now): int
    {
        $pdo = Database::pdo();
        $until = date('Y-m-d H:i:s', strtotime($now) + 15 * 60);
        $s = $pdo->prepare(
            'SELECT id, title, starts_at FROM calendar_events '
            . 'WHERE user_id = ? AND all_day = 0 AND starts_at >= ? AND starts_at <= ?'
        );
        $s->execute([$uid, $now, $until]);
        $n = 0;
        foreach ($s->fetchAll() as $e) {
            $key = 'cal:' . (int)$e['id'];
            if (!self::claim($uid, $key)) continue;
            $time = date('H:i', strtotime((string)$e['starts_at']));
            self::sendToUser($uid, [
                'title' => 'Termin in Kürze',
                'body'  => 'Termin in Kürze: ' . $e['title'] . ' um ' . $time,
                'url'   => '/',
            ]);
            $n++;
        }
        return $n;
    }

    /** Open tasks whose due date/time has been reached. */
    private static function checkTasks(int $uid, string $now, string $today): int
    {
        $pdo = Database::pdo();
        // Due reached: past day, or today with no time / a time that has passed.
        $s = $pdo->prepare(
            'SELECT id, title, due_date, due_time FROM tasks '
            . 'WHERE user_id = ? AND done_at IS NULL AND archived_at IS NULL AND due_date IS NOT NULL '
            . 'AND ('
            . '  due_date < ? '
            . '  OR (due_date = ? AND (due_time IS NULL OR CONCAT(due_date, " ", due_time) <= ?))'
            . ')'
        );
        $s->execute([$uid, $today, $today, $now]);
        $n = 0;
        foreach ($s->fetchAll() as $t) {
            $key = 'task:' . (int)$t['id'] . ':' . (string)$t['due_date'];
            if (!self::claim($uid, $key)) continue;
            self::sendToUser($uid, [
                'title' => 'Aufgabe fällig',
                'body'  => 'Aufgabe fällig: ' . $t['title'],
                'url'   => '/',
            ]);
            $n++;
        }
        return $n;
    }

    /** Unpaid invoices past their due date (doc_date + payment term). */
    private static function checkInvoices(int $uid, string $today): int
    {
        $pdo = Database::pdo();
        $term = self::paymentTermDays($uid);
        $s = $pdo->prepare(
            "SELECT id, number FROM documents "
            . "WHERE user_id = ? AND type = 'invoice' AND paid_at IS NULL "
            . 'AND DATE_ADD(doc_date, INTERVAL ? DAY) < ?'
        );
        $s->execute([$uid, $term, $today]);
        $n = 0;
        foreach ($s->fetchAll() as $d) {
            $key = 'inv:' . (int)$d['id'];
            if (!self::claim($uid, $key)) continue;
            self::sendToUser($uid, [
                'title' => 'Rechnung überfällig',
                'body'  => 'Rechnung überfällig: ' . $d['number'],
                'url'   => '/',
            ]);
            $n++;
        }
        return $n;
    }

    /** Unpaid expenses older than 7 days. */
    private static function checkExpenses(int $uid, string $today): int
    {
        $pdo = Database::pdo();
        $s = $pdo->prepare(
            'SELECT id, vendor FROM expenses '
            . 'WHERE user_id = ? AND paid_at IS NULL AND exp_date < DATE_SUB(?, INTERVAL 7 DAY)'
        );
        $s->execute([$uid, $today]);
        $n = 0;
        foreach ($s->fetchAll() as $e) {
            $key = 'exp:' . (int)$e['id'];
            if (!self::claim($uid, $key)) continue;
            self::sendToUser($uid, [
                'title' => 'Offener Beleg',
                'body'  => 'Offener Beleg: ' . ($e['vendor'] ?: 'Beleg'),
                'url'   => '/',
            ]);
            $n++;
        }
        return $n;
    }

    /**
     * Try to record a (user, dedup_key) send. Returns true if this is the first
     * time (caller should send), false if it was already recorded (skip). The
     * UNIQUE key makes this atomic — a duplicate INSERT affects 0 rows.
     */
    private static function claim(int $uid, string $key): bool
    {
        try {
            $stmt = Database::pdo()->prepare(
                'INSERT IGNORE INTO push_sent (user_id, dedup_key) VALUES (?, ?)'
            );
            $stmt->execute([$uid, mb_substr($key, 0, 191)]);
            return $stmt->rowCount() > 0;
        } catch (\Throwable $e) {
            return false;
        }
    }

    /** Read a user's notification prefs (booleans). Missing ns → empty (all off). */
    private static function prefs(int $uid): array
    {
        $s = Database::pdo()->prepare('SELECT data FROM app_settings WHERE user_id = ? AND ns = ?');
        $s->execute([$uid, self::PREF_NS]);
        $row = $s->fetch();
        if (!$row || $row['data'] === null) return [];
        $d = json_decode((string)$row['data'], true);
        return is_array($d) ? $d : [];
    }

    /** Company payment term in days (default 14), used for invoice due dates. */
    private static function paymentTermDays(int $uid): int
    {
        $s = Database::pdo()->prepare('SELECT data FROM app_settings WHERE user_id = ? AND ns = ?');
        $s->execute([$uid, 'company']);
        $row = $s->fetch();
        if (!$row || $row['data'] === null) return 14;
        $d = json_decode((string)$row['data'], true);
        $v = is_array($d) ? ($d['payment_term_days'] ?? null) : null;
        if ($v === null || $v === '' || (int)$v <= 0) return 14;
        return (int)$v;
    }

    // ───── app_kv helpers ──────────────────────────────────────────────────────
    private static function kvGet(string $k): ?string
    {
        $s = Database::pdo()->prepare('SELECT v FROM app_kv WHERE k = ?');
        $s->execute([$k]);
        $row = $s->fetch();
        return $row ? ($row['v'] ?? null) : null;
    }

    private static function kvSet(string $k, string $v): void
    {
        Database::pdo()->prepare(
            'INSERT INTO app_kv (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)'
        )->execute([$k, $v]);
    }
}
