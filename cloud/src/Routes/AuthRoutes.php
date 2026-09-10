<?php
declare(strict_types=1);

namespace Nyza\Routes;

use Nyza\Auth;
use Nyza\Database;
use Nyza\Json;
use Nyza\Middleware\AuthMiddleware;
use Nyza\Storage;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;
use Slim\Psr7\Stream;

/**
 * Single-user model — no public registration. The admin account is created
 * exactly once by the SetupWizard. Adding more users would mean either:
 *   (a) re-running the wizard (currently bails if a user exists), or
 *   (b) adding a /api/admin/users endpoint behind auth.
 */
final class AuthRoutes
{
    public static function mount(App $app): void
    {
        $app->post('/api/auth/login',           [self::class, 'login']);
        $app->post('/api/auth/2fa/login',       [self::class, 'twoFactorLogin']);
        $app->get('/api/auth/me',               [self::class, 'me']);
        $app->post('/api/auth/change-password', [self::class, 'changePassword'])->add(new AuthMiddleware());
        $app->patch('/api/auth/profile',        [self::class, 'updateProfile'])->add(new AuthMiddleware());
        $app->post('/api/auth/logo',            [self::class, 'uploadLogo'])->add(new AuthMiddleware());
        $app->delete('/api/auth/logo',          [self::class, 'deleteLogo'])->add(new AuthMiddleware());
        $app->post('/api/auth/2fa/setup',       [self::class, 'twoFactorSetup'])->add(new AuthMiddleware());
        $app->post('/api/auth/2fa/enable',      [self::class, 'twoFactorEnable'])->add(new AuthMiddleware());
        $app->post('/api/auth/2fa/disable',     [self::class, 'twoFactorDisable'])->add(new AuthMiddleware());
        $app->post('/api/auth/2fa/recovery-codes', [self::class, 'twoFactorRecoveryCodes'])->add(new AuthMiddleware());
        $app->get('/api/auth/logins',           [self::class, 'loginHistory'])->add(new AuthMiddleware());
        $app->get('/api/users',                 [self::class, 'workspaceUsers'])->add(new AuthMiddleware());
        // Public: serve a user's logo for share/upload-page branding.
        $app->get('/api/branding/logo/{uid}',   [self::class, 'serveLogo']);
        $app->get('/api/branding',              [self::class, 'branding']);
        $app->put('/api/branding',              [self::class, 'saveBranding'])->add(new AuthMiddleware());
    }

    /**
     * Member list for assignment/filter dropdowns — the caller's own
     * Kontogruppe only, so one team never sees another team's employees.
     */
    public static function workspaceUsers(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $stmt = Database::pdo()->prepare(
            'SELECT id, name, email FROM users WHERE active = 1 AND workspace_id = ? ORDER BY name ASC, email ASC'
        );
        $stmt->execute([\Nyza\WorkspaceContext::of($uid)]);
        $users = array_map(static fn($u) => ['id' => (int)$u['id'], 'name' => $u['name'], 'email' => $u['email']], $stmt->fetchAll());
        return Json::ok($res, ['users' => $users]);
    }

    private static function logLogin(Request $req, ?int $uid, string $email, bool $ok, string $reason): void
    {
        try {
            $sp = $req->getServerParams();
            $ip = \Nyza\RateLimiter::clientIp($req);
            $ua = substr((string)($sp['HTTP_USER_AGENT'] ?? ''), 0, 255);
            Database::pdo()->prepare('INSERT INTO login_events (user_id, email, ip, user_agent, ok, reason) VALUES (?, ?, ?, ?, ?, ?)')
                ->execute([$uid, $email !== '' ? $email : null, $ip, $ua, $ok ? 1 : 0, $reason]);
        } catch (\Throwable $e) { /* best-effort */ }
    }

    /** Public user payload — id/email/name/accent/role/active + whether a logo exists. */
    public static function publicUser(array $u): array
    {
        // logo_v changes whenever the file is replaced, so the client can bust
        // its cache for a URL that is otherwise identical for every upload.
        $logoV = null;
        if (!empty($u['logo_path'])) {
            $abs = Storage::abs((string)$u['logo_path']);
            $logoV = is_file($abs) ? (string)@filemtime($abs) : null;
        }
        return [
            'id' => (int)$u['id'], 'email' => $u['email'], 'name' => $u['name'],
            'accent' => $u['accent'] ?? null,
            'has_logo' => !empty($u['logo_path']),
            'logo_v' => $logoV,
            'role' => $u['role'] ?? 'user',
            'active' => isset($u['active']) ? (int)$u['active'] : 1,
            'is_primary' => !empty($u['is_primary']),
        ];
    }

    /**
     * Guarantee the install has exactly one owner. An installation set up on a
     * fresh database ended up with no admin at all: migrations 029/057 grant
     * admin + is_primary to existing rows, but on a new database they run
     * before the setup wizard creates the first account, so nobody got them.
     *
     * Only ever fires when NO primary admin exists, so a healthy install (and
     * one where the owner deliberately demoted others) is left untouched.
     */
    private static function ensurePrimaryAdmin(\PDO $pdo): void
    {
        $row = $pdo->query('SELECT COUNT(*) AS c FROM users WHERE is_primary = 1')->fetch();
        if ((int)($row['c'] ?? 0) > 0) return;
        $first = $pdo->query('SELECT MIN(id) AS id FROM users')->fetch();
        if (!$first || $first['id'] === null) return;
        $pdo->prepare("UPDATE users SET is_primary = 1, role = 'admin', active = 1 WHERE id = ?")
            ->execute([(int)$first['id']]);
    }

    public static function login(Request $req, Response $res): Response
    {
        // Brute-force guard: 10 attempts / 5 min per IP.
        if (!\Nyza\RateLimiter::allowReq($req, 'login', 10, 300)) {
            return Json::err($res, 'Zu viele Login-Versuche — bitte später erneut', 429, 'rate_limited');
        }
        $b = (array) $req->getParsedBody();
        $email = trim((string)($b['email'] ?? ''));
        $password = (string)($b['password'] ?? '');

        $pdo = Database::pdo();
        self::ensurePrimaryAdmin($pdo);
        $stmt = $pdo->prepare('SELECT id, email, password_hash, name, accent, logo_path, totp_enabled, role, active, is_primary FROM users WHERE email = ?');
        $stmt->execute([$email]);
        $u = $stmt->fetch();
        if (!$u || !password_verify($password, $u['password_hash'])) {
            self::logLogin($req, $u ? (int)$u['id'] : null, $email, false, 'bad_password');
            return Json::err($res, 'Invalid credentials', 401, 'invalid_credentials');
        }
        // Deactivated accounts can't log in — reject before any token / 2FA challenge.
        if (empty($u['active'])) {
            self::logLogin($req, (int)$u['id'], $email, false, 'inactive');
            return Json::err($res, 'Konto deaktiviert', 403, 'account_disabled');
        }
        // Second factor required → hand back a short-lived challenge instead of a token.
        if (!empty($u['totp_enabled'])) {
            return Json::ok($res, ['requires_2fa' => true, 'challenge' => Auth::issuePending((int)$u['id'], $u['email'])]);
        }
        self::logLogin($req, (int)$u['id'], $email, true, 'password');
        $token = Auth::issue((int)$u['id'], $u['email']);
        return Json::ok($res, ['token' => $token, 'user' => self::publicUser($u)]);
    }

    public static function twoFactorLogin(Request $req, Response $res): Response
    {
        if (!\Nyza\RateLimiter::allowReq($req, '2fa_login', 10, 300)) {
            return Json::err($res, 'Zu viele Versuche — bitte später erneut', 429, 'rate_limited');
        }
        $b = (array) $req->getParsedBody();
        $uid = Auth::pendingUserId((string)($b['challenge'] ?? ''));
        if (!$uid) return Json::err($res, 'Challenge abgelaufen — bitte erneut anmelden', 401, 'challenge_expired');

        $pdo = Database::pdo();
        $stmt = $pdo->prepare('SELECT id, email, name, accent, logo_path, totp_secret, totp_enabled, twofa_recovery, role, active, is_primary FROM users WHERE id = ?');
        $stmt->execute([$uid]);
        $u = $stmt->fetch();
        $code = (string)($b['code'] ?? '');
        // Accept EITHER a valid TOTP code OR a single-use recovery code. Recovery
        // codes are consumed (removed) on success so they can't be reused.
        $okTotp = $u && !empty($u['totp_enabled']) && \Nyza\Totp::verify($code, (string)$u['totp_secret']);
        $usedRecovery = false;
        if (!$okTotp && $u && !empty($u['totp_enabled'])) {
            $usedRecovery = self::consumeRecoveryCode($uid, $u['twofa_recovery'] ?? null, $code);
        }
        if (!$u || empty($u['totp_enabled']) || (!$okTotp && !$usedRecovery)) {
            self::logLogin($req, $uid, (string)($u['email'] ?? ''), false, 'bad_2fa');
            return Json::err($res, 'Code ungültig', 401, 'bad_code');
        }
        self::logLogin($req, $uid, $u['email'], true, $usedRecovery ? '2fa_recovery' : '2fa');
        return Json::ok($res, ['token' => Auth::issue((int)$u['id'], $u['email']), 'user' => self::publicUser($u)]);
    }

    /**
     * Generate N fresh single-use recovery codes. Returns [plaintext[], hashed[]].
     * Plaintext is shown to the user exactly once; only the hashes are persisted.
     * Format: XXXX-XXXX (10 chars from an unambiguous alphabet) — easy to read/type.
     */
    private static function makeRecoveryCodes(int $n = 8): array
    {
        $alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I
        $plain = [];
        $hashed = [];
        for ($i = 0; $i < $n; $i++) {
            $raw = '';
            for ($j = 0; $j < 8; $j++) {
                $raw .= $alphabet[random_int(0, strlen($alphabet) - 1)];
            }
            $code = substr($raw, 0, 4) . '-' . substr($raw, 4, 4);
            $plain[] = $code;
            $hashed[] = self::hashRecoveryCode($code);
        }
        return [$plain, $hashed];
    }

    /** Hash a recovery code for storage/comparison (case-insensitive, dash-insensitive). */
    private static function hashRecoveryCode(string $code): string
    {
        $norm = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', $code));
        return hash('sha256', $norm);
    }

    /**
     * Try to consume one recovery code. Returns true if $code matched a stored
     * (hashed) code, removing it so it can't be reused. No-op false otherwise.
     * $stored is the raw twofa_recovery TEXT column value (JSON array or null).
     */
    private static function consumeRecoveryCode(int $uid, ?string $stored, string $code): bool
    {
        $code = trim($code);
        if ($code === '' || $stored === null || $stored === '') return false;
        $codes = json_decode($stored, true);
        if (!is_array($codes) || !$codes) return false;
        $target = self::hashRecoveryCode($code);
        $matched = false;
        $remaining = [];
        foreach ($codes as $h) {
            if (!$matched && is_string($h) && hash_equals($h, $target)) {
                $matched = true; // drop this one
                continue;
            }
            $remaining[] = $h;
        }
        if (!$matched) return false;
        Database::pdo()->prepare('UPDATE users SET twofa_recovery = ? WHERE id = ?')
            ->execute([json_encode(array_values($remaining)), $uid]);
        return true;
    }

    public static function twoFactorRecoveryCodes(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $pdo = Database::pdo();
        $stmt = $pdo->prepare('SELECT totp_enabled FROM users WHERE id = ?');
        $stmt->execute([$uid]);
        $u = $stmt->fetch();
        if (!$u || empty($u['totp_enabled'])) return Json::err($res, '2FA ist nicht aktiv', 409, 'twofa_inactive');
        [$plain, $hashed] = self::makeRecoveryCodes();
        $pdo->prepare('UPDATE users SET twofa_recovery = ? WHERE id = ?')->execute([json_encode($hashed), $uid]);
        return Json::ok($res, ['recovery_codes' => $plain]);
    }

    public static function twoFactorSetup(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $pdo = Database::pdo();
        $stmt = $pdo->prepare('SELECT email, totp_secret, totp_enabled FROM users WHERE id = ?');
        $stmt->execute([$uid]);
        $u = $stmt->fetch();
        if (!empty($u['totp_enabled'])) return Json::err($res, '2FA ist bereits aktiv', 409);
        // (Re)generate a secret each time setup is opened, until confirmed.
        $secret = \Nyza\Totp::secret();
        $pdo->prepare('UPDATE users SET totp_secret = ? WHERE id = ?')->execute([$secret, $uid]);
        return Json::ok($res, ['secret' => $secret, 'uri' => \Nyza\Totp::uri($secret, (string)$u['email'])]);
    }

    public static function twoFactorEnable(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        $pdo = Database::pdo();
        $stmt = $pdo->prepare('SELECT totp_secret FROM users WHERE id = ?');
        $stmt->execute([$uid]);
        $u = $stmt->fetch();
        if (!$u || !$u['totp_secret']) return Json::err($res, 'Bitte zuerst Setup starten', 400);
        if (!\Nyza\Totp::verify((string)($b['code'] ?? ''), (string)$u['totp_secret'])) {
            return Json::err($res, 'Code ungültig — bitte erneut versuchen', 422, 'bad_code');
        }
        // Generate single-use recovery codes for authenticator-loss recovery.
        // Store hashed; hand the plaintext back ONCE so the UI can display them.
        [$plain, $hashed] = self::makeRecoveryCodes();
        $pdo->prepare('UPDATE users SET totp_enabled = 1, twofa_recovery = ? WHERE id = ?')
            ->execute([json_encode($hashed), $uid]);
        return Json::ok($res, ['ok' => true, 'enabled' => true, 'recovery_codes' => $plain]);
    }

    public static function twoFactorDisable(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        $pdo = Database::pdo();
        $stmt = $pdo->prepare('SELECT password_hash, totp_secret FROM users WHERE id = ?');
        $stmt->execute([$uid]);
        $u = $stmt->fetch();
        if (!$u) return Json::err($res, 'Not found', 404);
        // Require current password AND a valid code to turn it off.
        if (!password_verify((string)($b['password'] ?? ''), $u['password_hash'])) {
            return Json::err($res, 'Passwort falsch', 401, 'wrong_password');
        }
        if (!\Nyza\Totp::verify((string)($b['code'] ?? ''), (string)$u['totp_secret'])) {
            return Json::err($res, 'Code ungültig', 422, 'bad_code');
        }
        $pdo->prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, twofa_recovery = NULL WHERE id = ?')->execute([$uid]);
        return Json::ok($res, ['ok' => true, 'enabled' => false]);
    }

    public static function loginHistory(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $stmt = Database::pdo()->prepare('SELECT ip, user_agent, ok, reason, created_at FROM login_events WHERE user_id = ? ORDER BY id DESC LIMIT 50');
        $stmt->execute([$uid]);
        return Json::ok($res, ['logins' => $stmt->fetchAll()]);
    }

    public static function me(Request $req, Response $res): Response
    {
        $uid = Auth::userId($req);
        if (!$uid) return Json::err($res, 'Unauthorized', 401);
        $stmt = Database::pdo()->prepare('SELECT id, email, name, storage_quota, storage_used, accent, logo_path, totp_enabled, role, active, is_primary, created_at FROM users WHERE id = ?');
        $stmt->execute([$uid]);
        $u = $stmt->fetch();
        if (!$u) return Json::err($res, 'Not found', 404);
        return Json::ok($res, ['user' => self::publicUser($u) + [
            'storage_quota' => (int)$u['storage_quota'],
            'storage_used' => (int)$u['storage_used'],
            'twofa' => !empty($u['totp_enabled']),
            'created_at' => $u['created_at'],
        ]]);
    }

    public static function updateProfile(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        $pdo = Database::pdo();

        if (isset($b['email'])) {
            $email = trim((string)$b['email']);
            if (!filter_var($email, FILTER_VALIDATE_EMAIL)) return Json::err($res, 'Ungültige E-Mail', 422);
            $chk = $pdo->prepare('SELECT 1 FROM users WHERE email = ? AND id <> ?');
            $chk->execute([$email, $uid]);
            if ($chk->fetch()) return Json::err($res, 'E-Mail bereits vergeben', 409);
        }
        $accent = null;
        if (isset($b['accent'])) {
            $accent = preg_replace('/[^a-z0-9]/', '', strtolower((string)$b['accent'])) ?: null;
        }
        // Storage quota (bytes). Self-hosted single-user → admin sets their own;
        // floored at 1 GB and at the bytes already in use.
        $quota = null;
        if (isset($b['storage_quota'])) {
            $quota = max(1024 * 1024 * 1024, (int)$b['storage_quota']);
            $used = (int)($pdo->query("SELECT storage_used FROM users WHERE id = $uid")->fetch()['storage_used'] ?? 0);
            if ($quota < $used) $quota = $used;
        }
        $pdo->prepare('UPDATE users SET name = COALESCE(?, name), email = COALESCE(?, email), accent = COALESCE(?, accent), storage_quota = COALESCE(?, storage_quota) WHERE id = ?')
            ->execute([
                isset($b['name']) ? trim((string)$b['name']) : null,
                isset($b['email']) ? trim((string)$b['email']) : null,
                $accent,
                $quota,
                $uid,
            ]);
        $stmt = $pdo->prepare('SELECT id, email, name, accent, logo_path, totp_enabled, role, active, is_primary, storage_quota, storage_used FROM users WHERE id = ?');
        $stmt->execute([$uid]);
        $row = $stmt->fetch();
        return Json::ok($res, ['user' => self::publicUser($row) + ['storage_quota' => (int)$row['storage_quota'], 'storage_used' => (int)$row['storage_used']]]);
    }

    public static function uploadLogo(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $file = $req->getUploadedFiles()['file'] ?? null;
        if (is_array($file)) $file = $file[0];
        if (!$file || $file->getError() !== UPLOAD_ERR_OK) return Json::err($res, 'Kein Bild hochgeladen', 422);
        $mime = $file->getClientMediaType() ?: '';
        if (!in_array($mime, ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/gif'], true)) {
            return Json::err($res, 'Nur Bilddateien (PNG, JPG, WebP, SVG)', 415);
        }
        if ((int)$file->getSize() > 2 * 1024 * 1024) return Json::err($res, 'Logo zu groß (max 2 MB)', 413);

        $ext = ['image/png' => 'png', 'image/jpeg' => 'jpg', 'image/webp' => 'webp', 'image/svg+xml' => 'svg', 'image/gif' => 'gif'][$mime];
        $dir = Storage::root() . '/branding';
        if (!is_dir($dir)) @mkdir($dir, 0775, true);
        // remove any previous logo file for this user
        foreach (glob($dir . '/' . $uid . '.*') ?: [] as $old) @unlink($old);
        $rel = 'branding/' . $uid . '.' . $ext;
        $file->moveTo(Storage::abs($rel));
        Database::pdo()->prepare('UPDATE users SET logo_path = ? WHERE id = ?')->execute([$rel, $uid]);
        return Json::ok($res, ['ok' => true, 'has_logo' => true]);
    }

    public static function deleteLogo(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $pdo = Database::pdo();
        $stmt = $pdo->prepare('SELECT logo_path FROM users WHERE id = ?');
        $stmt->execute([$uid]);
        $u = $stmt->fetch();
        if ($u && $u['logo_path']) Storage::deleteRel($u['logo_path']);
        $pdo->prepare('UPDATE users SET logo_path = NULL WHERE id = ?')->execute([$uid]);
        return Json::ok($res, ['ok' => true]);
    }

    /**
     * Public branding for pages nobody is logged in on — the login screen, the
     * password prompts on share/portal/content-plan links, and so on. Answers
     * with the install owner's logo (the Hauptadmin, falling back to the oldest
     * account), or a specific user's via ?u= when the page knows whose link it
     * is showing.
     */
    public static function branding(Request $req, Response $res): Response
    {
        $pdo = Database::pdo();
        $uid = (int)($req->getQueryParams()['u'] ?? 0);

        $row = null;
        if ($uid > 0) {
            $s = $pdo->prepare('SELECT id, name, logo_path FROM users WHERE id = ? AND active = 1');
            $s->execute([$uid]);
            $row = $s->fetch() ?: null;
        }
        if (!$row) {
            $row = $pdo->query(
                'SELECT id, name, logo_path FROM users WHERE active = 1 '
                . 'ORDER BY is_primary DESC, id ASC LIMIT 1'
            )->fetch() ?: null;
        }
        if (!$row) {
            return Json::ok($res, [
                'has_logo' => false, 'user_id' => null, 'name' => null, 'logo_v' => null,
                'site_name' => \Nyza\Brand::name(), 'description' => \Nyza\Brand::description(),
            ]);
        }

        $logoV = null;
        if (!empty($row['logo_path'])) {
            $abs = Storage::abs((string)$row['logo_path']);
            $logoV = is_file($abs) ? (string)@filemtime($abs) : null;
        }
        return Json::ok($res, [
            'user_id'     => (int)$row['id'],
            'name'        => $row['name'],
            'has_logo'    => $logoV !== null,
            'logo_v'      => $logoV,
            'site_name'   => \Nyza\Brand::name(),
            'description' => \Nyza\Brand::description(),
            'is_default'  => \Nyza\Brand::name() === \Nyza\Brand::DEFAULT_NAME,
        ]);
    }

    /**
     * Change the installation's name/description — what a WhatsApp link preview
     * and the browser tab show. Installation-wide, so Hauptadmin only; it is
     * stored on the owner's app_settings row, which is where Brand reads it.
     */
    public static function saveBranding(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        if (!\Nyza\WorkspaceContext::isPrimary($uid)) {
            return Json::err($res, 'Nur der Hauptadmin kann die Marke ändern', 403, 'forbidden');
        }
        $owner = \Nyza\Brand::ownerId();
        if ($owner === null) return Json::err($res, 'Kein Inhaber gefunden', 404);

        $b = (array)$req->getParsedBody();
        $clean = static function ($v, int $max): string {
            $v = trim((string)$v);
            return mb_substr(preg_replace('/\s+/u', ' ', $v) ?? '', 0, $max);
        };
        $data = [
            'site_name'   => $clean($b['site_name'] ?? '', 60),
            'short_name'  => $clean($b['short_name'] ?? '', 30),
            'description' => $clean($b['description'] ?? '', 200),
        ];
        Database::pdo()->prepare(
            'INSERT INTO app_settings (user_id, ns, data) VALUES (?, ?, ?) '
            . 'ON DUPLICATE KEY UPDATE data = VALUES(data)'
        )->execute([$owner, 'branding', json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)]);

        return Json::ok($res, ['branding' => $data]);
    }

    public static function serveLogo(Request $req, Response $res, array $args): Response
    {
        $stmt = Database::pdo()->prepare('SELECT logo_path FROM users WHERE id = ?');
        $stmt->execute([(int)$args['uid']]);
        $u = $stmt->fetch();
        if (!$u || !$u['logo_path']) return Json::err($res, 'No logo', 404);
        $abs = Storage::abs($u['logo_path']);
        if (!is_file($abs)) return Json::err($res, 'Missing', 410);
        $ext = strtolower(pathinfo($abs, PATHINFO_EXTENSION));
        $mime = ['png' => 'image/png', 'jpg' => 'image/jpeg', 'webp' => 'image/webp', 'svg' => 'image/svg+xml', 'gif' => 'image/gif'][$ext] ?? 'application/octet-stream';
        // The URL is the same for every upload (branding/{uid}.{ext}), so a
        // plain max-age served the PREVIOUS logo for up to an hour after it was
        // replaced. Revalidate instead: an unchanged logo still costs only a
        // 304, a replaced one is picked up immediately.
        $etag = '"' . md5((string)@filemtime($abs) . '-' . (string)@filesize($abs)) . '"';
        if (trim((string)$req->getHeaderLine('If-None-Match')) === $etag) {
            return $res->withStatus(304)
                ->withHeader('ETag', $etag)
                ->withHeader('Cache-Control', 'no-cache, must-revalidate');
        }
        return $res
            ->withHeader('Content-Type', $mime)
            ->withHeader('Cache-Control', 'no-cache, must-revalidate')
            ->withHeader('ETag', $etag)
            ->withHeader('X-Content-Type-Options', 'nosniff')
            ->withBody(new Stream(fopen($abs, 'rb')));
    }

    public static function changePassword(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        $current = (string)($b['current_password'] ?? '');
        $new     = (string)($b['new_password'] ?? '');

        if (strlen($new) < 10) {
            return Json::err($res, 'Neues Passwort muss mindestens 10 Zeichen haben', 422, 'weak_password');
        }

        $pdo = Database::pdo();
        $stmt = $pdo->prepare('SELECT password_hash FROM users WHERE id = ?');
        $stmt->execute([$uid]);
        $u = $stmt->fetch();
        if (!$u || !password_verify($current, $u['password_hash'])) {
            return Json::err($res, 'Aktuelles Passwort ist falsch', 401, 'wrong_password');
        }

        $pdo->prepare('UPDATE users SET password_hash = ? WHERE id = ?')
            ->execute([password_hash($new, PASSWORD_BCRYPT), $uid]);
        return Json::ok($res, ['ok' => true]);
    }
}
