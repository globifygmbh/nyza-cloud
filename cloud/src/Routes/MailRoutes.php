<?php
declare(strict_types=1);

namespace Nyza\Routes;

use Nyza\CompanyContext;
use Nyza\Crypto;
use Nyza\Database;
use Nyza\Json;
use Nyza\Mail;
use Nyza\Ocr;
use Nyza\Storage;
use Nyza\Middleware\AuthMiddleware;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;
use Slim\Routing\RouteCollectorProxy;

/**
 * Mail accounts: manage mailboxes (encrypted IMAP/SMTP credentials), read the
 * inbox + attachments (php-imap), send via SMTP (PHPMailer), and import the
 * "Belege" mailbox — new PDF/image attachments are filed into a DMS folder and
 * booked as open expenses (OCR-prefilled when available).
 */
final class MailRoutes
{
    public static function mount(App $app): void
    {
        $app->group('/api/mail', function (RouteCollectorProxy $g) {
            $g->get('/mailboxes',                 [self::class, 'list']);
            $g->post('/mailboxes',                [self::class, 'create']);
            $g->patch('/mailboxes/{id}',          [self::class, 'update']);
            $g->delete('/mailboxes/{id}',         [self::class, 'delete']);
            $g->get('/mailboxes/{id}/messages',   [self::class, 'messages']);
            $g->get('/mailboxes/{id}/messages/{uid}', [self::class, 'read']);
            $g->get('/mailboxes/{id}/messages/{uid}/attachment', [self::class, 'attachment']);
            $g->post('/mailboxes/{id}/send',      [self::class, 'send']);
            $g->post('/mailboxes/{id}/fetch-belege', [self::class, 'fetchBelege']);
        })->add(new AuthMiddleware());
    }

    public static function list(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $s = Database::pdo()->prepare('SELECT * FROM mailboxes WHERE user_id = ? ORDER BY name');
        $s->execute([$uid]);
        return Json::ok($res, [
            'imap_available' => Mail::imapAvailable(),
            'mailboxes' => array_map([self::class, 'shape'], $s->fetchAll()),
        ]);
    }

    public static function create(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $b = (array)$req->getParsedBody();
        $email = trim((string)($b['email'] ?? ''));
        if ($email === '') return Json::err($res, 'E-Mail erforderlich', 422);
        $name = trim((string)($b['name'] ?? '')) ?: $email;
        $pdo = Database::pdo();
        $pdo->prepare(
            'INSERT INTO mailboxes (user_id, company_id, name, email, imap_host, imap_port, imap_user, imap_pass_enc, imap_ssl, '
            . 'smtp_host, smtp_port, smtp_user, smtp_pass_enc, smtp_secure, from_name) '
            . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([
            $uid, $cid, mb_substr($name, 0, 120), mb_substr($email, 0, 255),
            self::str($b['imap_host'] ?? null, 255), (int)($b['imap_port'] ?? 993) ?: 993,
            self::str($b['imap_user'] ?? null, 255) ?? $email, Crypto::encrypt((string)($b['imap_pass'] ?? '')), !empty($b['imap_ssl']) || !isset($b['imap_ssl']) ? 1 : 0,
            self::str($b['smtp_host'] ?? null, 255), (int)($b['smtp_port'] ?? 465) ?: 465,
            self::str($b['smtp_user'] ?? null, 255) ?? $email, Crypto::encrypt((string)($b['smtp_pass'] ?? '')),
            in_array($b['smtp_secure'] ?? 'ssl', ['ssl', 'tls', 'none'], true) ? $b['smtp_secure'] : 'ssl',
            self::str($b['from_name'] ?? null, 120) ?? $name,
        ]);
        return Json::ok($res, ['mailbox' => self::shape(self::fetch($uid, (int)$pdo->lastInsertId()))], 201);
    }

    public static function update(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetch($uid, $id)) return Json::err($res, 'Not found', 404);
        $b = (array)$req->getParsedBody();
        $map = [
            'name' => fn($v) => mb_substr(trim((string)$v), 0, 120),
            'email' => fn($v) => mb_substr(trim((string)$v), 0, 255),
            'imap_host' => fn($v) => self::str($v, 255), 'imap_port' => fn($v) => (int)$v ?: 993,
            'imap_user' => fn($v) => self::str($v, 255), 'imap_ssl' => fn($v) => !empty($v) ? 1 : 0,
            'smtp_host' => fn($v) => self::str($v, 255), 'smtp_port' => fn($v) => (int)$v ?: 465,
            'smtp_user' => fn($v) => self::str($v, 255), 'smtp_secure' => fn($v) => in_array($v, ['ssl', 'tls', 'none'], true) ? $v : 'ssl',
            'from_name' => fn($v) => self::str($v, 120),
            'is_belege' => fn($v) => !empty($v) ? 1 : 0,
            'belege_folder_id' => fn($v) => ($v !== null && (int)$v > 0) ? (int)$v : null,
        ];
        $sets = []; $vals = [];
        foreach ($map as $k => $fn) { if (array_key_exists($k, $b)) { $sets[] = "$k = ?"; $vals[] = $fn($b[$k]); } }
        if (array_key_exists('imap_pass', $b) && $b['imap_pass'] !== '') { $sets[] = 'imap_pass_enc = ?'; $vals[] = Crypto::encrypt((string)$b['imap_pass']); }
        if (array_key_exists('smtp_pass', $b) && $b['smtp_pass'] !== '') { $sets[] = 'smtp_pass_enc = ?'; $vals[] = Crypto::encrypt((string)$b['smtp_pass']); }
        // Only one Belege mailbox at a time.
        if (!empty($b['is_belege'])) Database::pdo()->prepare('UPDATE mailboxes SET is_belege = 0 WHERE user_id = ?')->execute([$uid]);
        if (!$sets) return Json::err($res, 'Nichts zu ändern', 422);
        $vals[] = $id; $vals[] = $uid;
        Database::pdo()->prepare('UPDATE mailboxes SET ' . implode(', ', $sets) . ' WHERE id = ? AND user_id = ?')->execute($vals);
        return Json::ok($res, ['mailbox' => self::shape(self::fetch($uid, $id))]);
    }

    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        Database::pdo()->prepare('DELETE FROM mailboxes WHERE id = ? AND user_id = ?')->execute([(int)$args['id'], $uid]);
        return Json::ok($res, ['ok' => true]);
    }

    public static function messages(Request $req, Response $res, array $args): Response
    {
        $mb = self::need($req, $args, $res); if ($mb instanceof Response) return $mb;
        try { return Json::ok($res, ['messages' => Mail::listMessages($mb, 40)]); }
        catch (\Throwable $e) { return Json::err($res, $e->getMessage(), $e->getCode() >= 400 ? (int)$e->getCode() : 502); }
    }

    public static function read(Request $req, Response $res, array $args): Response
    {
        $mb = self::need($req, $args, $res); if ($mb instanceof Response) return $mb;
        try { return Json::ok($res, ['message' => Mail::readMessage($mb, (int)$args['uid'])]); }
        catch (\Throwable $e) { return Json::err($res, $e->getMessage(), $e->getCode() >= 400 ? (int)$e->getCode() : 502); }
    }

    public static function attachment(Request $req, Response $res, array $args): Response
    {
        $mb = self::need($req, $args, $res); if ($mb instanceof Response) return $mb;
        $part = (string)($req->getQueryParams()['part'] ?? '');
        try {
            $a = Mail::fetchAttachment($mb, (int)$args['uid'], $part);
            if (!$a) return Json::err($res, 'Anhang nicht gefunden', 404);
            $res->getBody()->write($a['data']);
            return $res->withHeader('Content-Type', $a['mime'] ?: 'application/octet-stream')
                ->withHeader('Content-Disposition', 'inline; filename="' . addslashes($a['name']) . '"')
                ->withHeader('X-Content-Type-Options', 'nosniff')->withStatus(200);
        } catch (\Throwable $e) { return Json::err($res, $e->getMessage(), 502); }
    }

    public static function send(Request $req, Response $res, array $args): Response
    {
        $mb = self::need($req, $args, $res); if ($mb instanceof Response) return $mb;
        $b = (array)$req->getParsedBody();
        if (trim((string)($b['to'] ?? '')) === '') return Json::err($res, 'Empfänger fehlt', 422);
        try { Mail::send($mb, $b); return Json::ok($res, ['ok' => true], 201); }
        catch (\Throwable $e) { return Json::err($res, 'Senden fehlgeschlagen: ' . $e->getMessage(), 502); }
    }

    /** Import new receipt attachments → DMS folder + open expenses. */
    public static function fetchBelege(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $mb = self::fetch($uid, (int)$args['id']);
        if (!$mb) return Json::err($res, 'Not found', 404);
        if (!$mb['belege_folder_id']) return Json::err($res, 'Kein Belege-Ordner gewählt', 422);
        try { $r = Mail::fetchBelegeAttachments($mb); }
        catch (\Throwable $e) { return Json::err($res, $e->getMessage(), $e->getCode() >= 400 ? (int)$e->getCode() : 502); }

        $cid = (int)($mb['company_id'] ?: 0) ?: CompanyContext::active($req, $uid);
        $folderId = (int)$mb['belege_folder_id'];
        $imported = 0;
        foreach ($r['attachments'] as $a) {
            try { self::importReceipt($uid, $cid, $folderId, $a); $imported++; } catch (\Throwable $e) { /* skip one bad attachment */ }
        }
        if (($r['max_uid'] ?? 0) > (int)$mb['belege_seen_uid']) {
            Database::pdo()->prepare('UPDATE mailboxes SET belege_seen_uid = ? WHERE id = ? AND user_id = ?')
                ->execute([(int)$r['max_uid'], (int)$mb['id'], $uid]);
        }
        return Json::ok($res, ['imported' => $imported]);
    }

    /** Cron entry: import new Belege attachments for every flagged mailbox. */
    public static function cronImport(): int
    {
        if (!Mail::imapAvailable()) return 0;
        $rows = Database::pdo()->query('SELECT * FROM mailboxes WHERE is_belege = 1 AND belege_folder_id IS NOT NULL')->fetchAll();
        $total = 0;
        foreach ($rows as $mb) {
            try {
                $r = Mail::fetchBelegeAttachments($mb);
                $uid = (int)$mb['user_id'];
                $cid = (int)($mb['company_id'] ?: 0);
                $folderId = (int)$mb['belege_folder_id'];
                foreach ($r['attachments'] as $a) {
                    try { self::importReceipt($uid, $cid, $folderId, $a); $total++; } catch (\Throwable $e) {}
                }
                if (($r['max_uid'] ?? 0) > (int)$mb['belege_seen_uid']) {
                    Database::pdo()->prepare('UPDATE mailboxes SET belege_seen_uid = ? WHERE id = ?')->execute([(int)$r['max_uid'], (int)$mb['id']]);
                }
            } catch (\Throwable $e) { /* skip mailbox */ }
        }
        return $total;
    }

    private static function importReceipt(int $uid, int $cid, int $folderId, array $a): void
    {
        // 1) File the attachment into the DMS Belege folder.
        $tmp = Storage::temp() . '/mail_' . bin2hex(random_bytes(6));
        file_put_contents($tmp, $a['data']);
        FileRoutes::ingestPath($uid, $folderId, $a['name'], $tmp, $a['mime']);

        // 2) Store a receipt copy for the expense + OCR-prefill.
        $rel = Storage::relPath($uid, $a['name']);
        file_put_contents(Storage::abs($rel), $a['data']);
        $gross = 0.0; $rate = 20.0; $date = date('Y-m-d'); $vendor = $a['from'] ?: '';
        if (Ocr::available()) {
            $text = Ocr::extractText(Storage::abs($rel), $a['mime']);
            if (trim($text) !== '') {
                $sug = Ocr::parse($text);
                if ($sug['gross'] !== null) $gross = (float)$sug['gross'];
                if ($sug['tax_rate'] !== null) $rate = (float)$sug['tax_rate'];
                if ($sug['date']) $date = $sug['date'];
                if (!empty($sug['vendor'])) $vendor = $sug['vendor'];
            }
        }
        $net = $rate > 0 ? round($gross / (1 + $rate / 100), 2) : $gross;
        $tax = round($gross - $net, 2);
        Database::pdo()->prepare(
            'INSERT INTO expenses (user_id, company_id, exp_date, vendor, description, category, net, tax_rate, tax, gross, deductible, paid_at, receipt_path, receipt_name, receipt_mime) '
            . "VALUES (?, ?, ?, ?, ?, 'E-Mail', ?, ?, ?, ?, 1, NULL, ?, ?, ?)"
        )->execute([
            $uid, $cid, $date, mb_substr($vendor, 0, 255), mb_substr('Per Mail: ' . $a['name'], 0, 500),
            $net, $rate, $tax, $gross, $rel, mb_substr($a['name'], 0, 255), mb_substr($a['mime'], 0, 100),
        ]);
    }

    // ───── helpers ──────────────────────────────────────────────────────────────
    private static function need(Request $req, array $args, Response $res)
    {
        $uid = (int)$req->getAttribute('uid');
        $mb = self::fetch($uid, (int)$args['id']);
        if (!$mb) return Json::err($res, 'Not found', 404);
        return $mb;
    }

    private static function fetch(int $uid, int $id): ?array
    {
        $s = Database::pdo()->prepare('SELECT * FROM mailboxes WHERE id = ? AND user_id = ?');
        $s->execute([$id, $uid]);
        return $s->fetch() ?: null;
    }

    private static function shape(array $m): array
    {
        return [
            'id' => (int)$m['id'], 'name' => $m['name'], 'email' => $m['email'],
            'imap_host' => $m['imap_host'], 'imap_port' => (int)$m['imap_port'], 'imap_user' => $m['imap_user'], 'imap_ssl' => (int)$m['imap_ssl'],
            'smtp_host' => $m['smtp_host'], 'smtp_port' => (int)$m['smtp_port'], 'smtp_user' => $m['smtp_user'], 'smtp_secure' => $m['smtp_secure'],
            'from_name' => $m['from_name'],
            'is_belege' => (int)$m['is_belege'], 'belege_folder_id' => $m['belege_folder_id'] !== null ? (int)$m['belege_folder_id'] : null,
            'has_imap_pass' => !empty($m['imap_pass_enc']), 'has_smtp_pass' => !empty($m['smtp_pass_enc']),
        ];
    }

    private static function str($v, int $max): ?string
    {
        if ($v === null) return null;
        $v = trim((string)$v);
        return $v === '' ? null : mb_substr($v, 0, $max);
    }
}
