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
use Slim\Routing\RouteCollectorProxy;

final class ShareRoutes
{
    public static function mount(App $app): void
    {
        // Owner endpoints
        $app->group('/api/shares', function (RouteCollectorProxy $g) {
            $g->get('',         [self::class, 'list']);
            $g->post('',        [self::class, 'create']);
            $g->patch('/{id}',  [self::class, 'update']);
            $g->delete('/{id}', [self::class, 'delete']);
            $g->get('/{id}/events', [self::class, 'events']);
        })->add(new AuthMiddleware());

        // Public (no auth) endpoints
        $app->post('/api/s/{token}/unlock',  [self::class, 'unlock']);
        $app->get('/api/s/{token}',          [self::class, 'show']);
        $app->get('/api/s/{token}/zip',      [self::class, 'downloadZip']);
        $app->get('/api/s/{token}/file/{id}',[self::class, 'downloadFile']);
        $app->get('/api/s/{token}/file/{id}/thumb', [self::class, 'fileThumb']);
        $app->get('/api/s/{token}/file/{id}/comments',  [self::class, 'fileComments']);
        $app->post('/api/s/{token}/file/{id}/comments', [self::class, 'addFileComment']);
        $app->post('/api/s/{token}/file/{id}/label', [self::class, 'setFileLabel']);
    }

    /** Verify a file is reachable through this share; returns the share or null. */
    private static function shareForFile(string $token, int $fileId, Request $req): ?array
    {
        $share = self::loadByToken($token);
        if (!$share) return null;
        if (self::gate($share, $req)) return null;
        if ($share['file_id'] && (int)$share['file_id'] === $fileId) return $share;
        if ($share['folder_id']) {
            $chk = Database::pdo()->prepare('SELECT 1 FROM files WHERE id = ? AND folder_id = ? AND deleted_at IS NULL');
            $chk->execute([$fileId, (int)$share['folder_id']]);
            if ($chk->fetch()) return $share;
        }
        return null;
    }

    public static function fileThumb(Request $req, Response $res, array $args): Response
    {
        $share = self::shareForFile($args['token'], (int)$args['id'], $req);
        if (!$share) return Json::err($res, 'Not found', 404);
        $stmt = Database::pdo()->prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL');
        $stmt->execute([(int)$args['id']]);
        $f = $stmt->fetch();
        if (!$f) return Json::err($res, 'Not found', 404);
        return FileRoutes::serveThumb($res, $f);
    }

    public static function fileComments(Request $req, Response $res, array $args): Response
    {
        $share = self::shareForFile($args['token'], (int)$args['id'], $req);
        if (!$share) return Json::err($res, 'Not found', 404);
        return Json::ok($res, ['comments' => FileRoutes::listComments((int)$args['id'])]);
    }

    public static function setFileLabel(Request $req, Response $res, array $args): Response
    {
        if (!\Nyza\RateLimiter::allowReq($req, 'share_label', 60, 300, $args['token'])) {
            return Json::err($res, 'Zu viele Anfragen', 429, 'rate_limited');
        }
        $share = self::shareForFile($args['token'], (int)$args['id'], $req);
        if (!$share) return Json::err($res, 'Not found', 404);
        $b = (array) $req->getParsedBody();
        $allowed = [null, 'red', 'yellow', 'green'];
        $label = array_key_exists('label', $b) ? ($b['label'] === '' || $b['label'] === null ? null : (string)$b['label']) : null;
        if (!in_array($label, $allowed, true)) return Json::err($res, 'Invalid label', 422);
        Database::pdo()->prepare('UPDATE files SET label = ? WHERE id = ?')
            ->execute([$label, (int)$args['id']]);
        return Json::ok($res, ['ok' => true, 'label' => $label]);
    }

    public static function addFileComment(Request $req, Response $res, array $args): Response
    {
        if (!\Nyza\RateLimiter::allowReq($req, 'comment', 20, 600, $args['token'])) {
            return Json::err($res, 'Zu viele Kommentare — bitte später', 429, 'rate_limited');
        }
        $share = self::shareForFile($args['token'], (int)$args['id'], $req);
        if (!$share) return Json::err($res, 'Not found', 404);
        $b = (array) $req->getParsedBody();
        $name = trim((string)($b['author_name'] ?? '')) ?: 'Gast';
        $body = trim((string)($b['body'] ?? ''));
        if ($body === '') return Json::err($res, 'Kommentar leer', 422);
        $name = mb_substr($name, 0, 120);
        $body = mb_substr($body, 0, 5000);
        Database::pdo()->prepare("INSERT INTO comments (file_id, user_id, author_name, body, source) VALUES (?, NULL, ?, ?, 'guest')")
            ->execute([(int)$args['id'], $name, $body]);
        // notify owner by mail (best-effort)
        try {
            $o = Database::pdo()->prepare('SELECT u.email, u.name, f.name AS fname FROM files f JOIN users u ON u.id = f.user_id WHERE f.id = ?');
            $o->execute([(int)$args['id']]);
            if ($row = $o->fetch()) {
                \Nyza\Mailer::send($row['email'], 'Neues Feedback: ' . $row['fname'],
                    "$name hat die Datei \"{$row['fname']}\" kommentiert:\n\n$body\n\n— Nyza Cloud");
            }
        } catch (\Throwable $e) {}
        return Json::ok($res, ['comments' => FileRoutes::listComments((int)$args['id'])], 201);
    }

    public static function list(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        // Include the shared item's NAME so the list shows what's shared, not just
        // the opaque token.
        $stmt = Database::pdo()->prepare(
            'SELECT s.*, '
            . '  (SELECT name FROM folders WHERE id = s.folder_id) AS folder_name, '
            . '  (SELECT name FROM files   WHERE id = s.file_id)   AS file_name '
            . 'FROM share_links s WHERE s.user_id = ? ORDER BY s.created_at DESC'
        );
        $stmt->execute([$uid]);
        return Json::ok($res, ['shares' => $stmt->fetchAll()]);
    }

    public static function create(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        $folder = isset($b['folder_id']) ? (int)$b['folder_id'] : null;
        $file = isset($b['file_id']) ? (int)$b['file_id'] : null;
        if (!$folder && !$file) return Json::err($res, 'folder_id or file_id required', 422);

        $token = Auth::randomToken(24);
        $passwordHash = !empty($b['password']) ? password_hash((string)$b['password'], PASSWORD_BCRYPT) : null;
        $expires = !empty($b['expires_at']) ? (string)$b['expires_at'] : null;
        $allowDownload = isset($b['allow_download']) ? (int)(bool)$b['allow_download'] : 1;
        // Gallery view only makes sense for a shared folder.
        $gallery = ($folder && !empty($b['gallery'])) ? 1 : 0;

        $ins = Database::pdo()->prepare(
            'INSERT INTO share_links (user_id, folder_id, file_id, token, password_hash, expires_at, allow_download, gallery) '
            . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $ins->execute([$uid, $folder, $file, $token, $passwordHash, $expires, $allowDownload, $gallery]);
        $id = (int)Database::pdo()->lastInsertId();

        // Optional: invite people by email. The frontend passes the fully-built
        // share URL (it knows origin + base path) plus a recipient list.
        $emails = array_values(array_filter(array_map(
            fn($e) => filter_var(trim((string)$e), FILTER_VALIDATE_EMAIL) ?: null,
            (array)($b['emails'] ?? [])
        )));
        // Frontend passes its origin+base (it can't know the token); we append.
        $base = rtrim((string)($b['share_base'] ?? ''), '/');
        $shareUrl = $base !== '' ? $base . '/s/' . $token : '';
        $sent = 0;
        if ($emails && $shareUrl) {
            $sent = self::sendInvites($uid, $emails, $shareUrl, (string)($b['message'] ?? ''), $passwordHash !== null ? (string)($b['password'] ?? '') : null);
        }

        Database::pdo()->prepare("INSERT INTO activity (user_id, kind, payload) VALUES (?, 'share_created', ?)")
            ->execute([$uid, json_encode(['share_id' => $id, 'token' => $token, 'invited' => $sent])]);

        return Json::ok($res, [
            'share' => [
                'id' => $id, 'token' => $token,
                'folder_id' => $folder, 'file_id' => $file,
                'expires_at' => $expires, 'allow_download' => (bool)$allowDownload,
                'has_password' => $passwordHash !== null, 'gallery' => (bool)$gallery,
                'invited' => $sent,
            ],
        ], 201);
    }

    private static function sendInvites(int $uid, array $emails, string $url, string $message, ?string $password): int
    {
        $owner = Database::pdo()->prepare('SELECT name, email FROM users WHERE id = ?');
        $owner->execute([$uid]);
        $o = $owner->fetch() ?: ['name' => 'Jemand', 'email' => getenv('MAIL_FROM') ?: 'no-reply@nyza.cloud'];
        $from = getenv('MAIL_FROM') ?: 'no-reply@nyza.cloud';
        $sent = 0;
        foreach ($emails as $to) {
            $body = "Hallo,\n\n{$o['name']} hat Dateien mit dir geteilt.\n\n"
                  . ($message !== '' ? trim($message) . "\n\n" : '')
                  . "Hier ansehen / herunterladen:\n$url\n\n"
                  . ($password ? "Passwort: $password\n\n" : '')
                  . "— gesendet via Nyza Cloud";
            if (\Nyza\Mailer::send($to, "{$o['name']} hat Dateien mit dir geteilt", $body, $o['email'], $o['name'])) $sent++;
        }
        return $sent;
    }

    /** Edit an existing link's settings (download, gallery, password, expiry). */
    public static function update(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $pdo = Database::pdo();
        $stmt = $pdo->prepare('SELECT * FROM share_links WHERE id = ? AND user_id = ?');
        $stmt->execute([$id, $uid]);
        $share = $stmt->fetch();
        if (!$share) return Json::err($res, 'Not found', 404);

        $b = (array) $req->getParsedBody();
        $sets = []; $params = [];
        if (array_key_exists('allow_download', $b)) { $sets[] = 'allow_download = ?'; $params[] = (int)(bool)$b['allow_download']; }
        if (array_key_exists('gallery', $b)) { $sets[] = 'gallery = ?'; $params[] = ($share['folder_id'] && !empty($b['gallery'])) ? 1 : 0; }
        if (array_key_exists('expires_at', $b)) { $sets[] = 'expires_at = ?'; $params[] = !empty($b['expires_at']) ? (string)$b['expires_at'] : null; }
        if (!empty($b['clear_password'])) { $sets[] = 'password_hash = ?'; $params[] = null; }
        elseif (array_key_exists('password', $b) && (string)$b['password'] !== '') { $sets[] = 'password_hash = ?'; $params[] = password_hash((string)$b['password'], PASSWORD_BCRYPT); }

        if ($sets) {
            $params[] = $id; $params[] = $uid;
            $pdo->prepare('UPDATE share_links SET ' . implode(', ', $sets) . ' WHERE id = ? AND user_id = ?')->execute($params);
        }
        $stmt->execute([$id, $uid]);
        $row = $stmt->fetch();
        $row['has_password'] = !empty($row['password_hash']);
        return Json::ok($res, ['share' => $row]);
    }

    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        Database::pdo()->prepare('DELETE FROM share_links WHERE id = ? AND user_id = ?')->execute([$id, $uid]);
        return Json::ok($res, ['ok' => true]);
    }

    /** Record a per-share activity event (link opened, file/zip downloaded). */
    private static function logEvent(int $shareId, string $type, ?int $fileId = null, ?string $fileName = null, ?Request $req = null): void
    {
        $ip = null; $ua = null;
        if ($req) {
            $ip = mb_substr(\Nyza\RateLimiter::clientIp($req), 0, 64);
            $line = $req->getHeaderLine('User-Agent');
            $ua = $line !== '' ? mb_substr($line, 0, 255) : null;
        }
        if ($fileName !== null) $fileName = mb_substr($fileName, 0, 255);
        try {
            Database::pdo()->prepare(
                'INSERT INTO share_events (share_id, type, file_id, file_name, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)'
            )->execute([$shareId, mb_substr($type, 0, 16), $fileId, $fileName, $ip, $ua]);
        } catch (\Throwable $e) {}
    }

    /** Owner: per-share activity history + summary counts. */
    public static function events(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $pdo = Database::pdo();
        $own = $pdo->prepare('SELECT id FROM share_links WHERE id = ? AND user_id = ?');
        $own->execute([$id, $uid]);
        if (!$own->fetch()) return Json::err($res, 'Not found', 404);

        $stmt = $pdo->prepare(
            'SELECT id, type, file_name, ip, created_at FROM share_events '
            . 'WHERE share_id = ? ORDER BY created_at DESC LIMIT 200'
        );
        $stmt->execute([$id]);
        $events = $stmt->fetchAll();

        $sum = $pdo->prepare(
            "SELECT "
            . "SUM(type = 'view') AS views, "
            . "SUM(type IN ('download', 'zip')) AS downloads "
            . 'FROM share_events WHERE share_id = ?'
        );
        $sum->execute([$id]);
        $s = $sum->fetch() ?: [];

        return Json::ok($res, [
            'events' => $events,
            'summary' => [
                'views' => (int)($s['views'] ?? 0),
                'downloads' => (int)($s['downloads'] ?? 0),
            ],
        ]);
    }

    private static function loadByToken(string $token): ?array
    {
        $stmt = Database::pdo()->prepare('SELECT * FROM share_links WHERE token = ?');
        $stmt->execute([$token]);
        $s = $stmt->fetch();
        return $s ?: null;
    }

    private static function gate(array $share, Request $req): ?array
    {
        if ($share['expires_at'] && strtotime($share['expires_at']) < time()) {
            return ['error' => 'expired', 'status' => 410];
        }
        if ($share['password_hash']) {
            $pw = $req->getQueryParams()['p'] ?? null;
            if (!$pw) {
                $body = (array) $req->getParsedBody();
                $pw = $body['password'] ?? null;
            }
            if (!$pw || !password_verify((string)$pw, $share['password_hash'])) {
                return ['error' => 'password_required', 'status' => 401];
            }
        }
        return null;
    }

    public static function unlock(Request $req, Response $res, array $args): Response
    {
        // Brute-force guard: 10 password attempts / 5 min per token+IP.
        if (!\Nyza\RateLimiter::allowReq($req, 'share_unlock', 10, 300, $args['token'])) {
            return Json::err($res, 'Zu viele Versuche — bitte später erneut', 429, 'rate_limited');
        }
        $share = self::loadByToken($args['token']);
        if (!$share) return Json::err($res, 'Not found', 404);
        $err = self::gate($share, $req);
        if ($err) return Json::err($res, $err['error'], $err['status']);
        return Json::ok($res, ['ok' => true]);
    }

    public static function show(Request $req, Response $res, array $args): Response
    {
        $share = self::loadByToken($args['token']);
        if (!$share) return Json::err($res, 'Not found', 404);

        if ($share['password_hash']) {
            $err = self::gate($share, $req);
            if ($err) {
                // surface only the public meta fields
                return Json::ok($res, [
                    'requires_password' => true,
                    'expires_at' => $share['expires_at'],
                ], 401);
            }
        } else {
            if ($share['expires_at'] && strtotime($share['expires_at']) < time()) {
                return Json::err($res, 'expired', 410);
            }
        }

        $pdo = Database::pdo();
        $owner = $pdo->prepare('SELECT id, name, email, accent, logo_path FROM users WHERE id = ?');
        $owner->execute([(int)$share['user_id']]);
        $ownerRow = $owner->fetch();

        $payload = [
            'token' => $share['token'],
            'allow_download' => (bool)$share['allow_download'],
            'gallery' => !empty($share['gallery']),
            'expires_at' => $share['expires_at'],
            'owner' => $ownerRow ? [
                'id' => (int)$ownerRow['id'], 'name' => $ownerRow['name'], 'email' => $ownerRow['email'],
                'accent' => $ownerRow['accent'] ?? null, 'has_logo' => !empty($ownerRow['logo_path']),
            ] : null,
        ];

        if ($share['folder_id']) {
            $f = $pdo->prepare('SELECT id, name, kind FROM folders WHERE id = ?');
            $f->execute([(int)$share['folder_id']]);
            $folder = $f->fetch();
            $files = $pdo->prepare('SELECT id, name, kind, size, mime_type, hue FROM files WHERE folder_id = ? AND deleted_at IS NULL ORDER BY created_at DESC');
            $files->execute([(int)$share['folder_id']]);
            $payload['folder'] = $folder ?: null;
            $payload['files'] = $files->fetchAll();
            $payload['total_size'] = array_sum(array_map(fn($r) => (int)$r['size'], $payload['files']));
        } elseif ($share['file_id']) {
            $f = $pdo->prepare('SELECT id, name, kind, size, mime_type, hue FROM files WHERE id = ?');
            $f->execute([(int)$share['file_id']]);
            $payload['file'] = $f->fetch() ?: null;
        }

        $pdo->prepare('UPDATE share_links SET view_count = view_count + 1 WHERE id = ?')->execute([(int)$share['id']]);
        self::logEvent((int)$share['id'], 'view', null, null, $req);
        return Json::ok($res, $payload);
    }

    public static function downloadZip(Request $req, Response $res, array $args): Response
    {
        $share = self::loadByToken($args['token']);
        if (!$share) return Json::err($res, 'Not found', 404);
        if (!$share['allow_download']) return Json::err($res, 'Download disabled', 403);
        $err = self::gate($share, $req);
        if ($err) return Json::err($res, $err['error'], $err['status']);
        if (!$share['folder_id']) return Json::err($res, 'Single file — use file endpoint', 400);

        $files = Database::pdo()->prepare('SELECT * FROM files WHERE folder_id = ? AND deleted_at IS NULL');
        $files->execute([(int)$share['folder_id']]);
        $rows = $files->fetchAll();
        if (!$rows) return Json::err($res, 'No files', 404);

        $members = [];
        foreach ($rows as $r) {
            $members[] = ['path' => Storage::abs($r['storage_path']), 'name' => $r['name']];
        }
        self::logEvent((int)$share['id'], 'zip', null, null, $req);
        \Nyza\ZipStreamer::emit($members, 'share-' . substr($share['token'], 0, 8) . '.zip');
        return $res; // unreachable — emit() exits after streaming
    }

    public static function downloadFile(Request $req, Response $res, array $args): Response
    {
        $share = self::loadByToken($args['token']);
        if (!$share) return Json::err($res, 'Not found', 404);
        if (!$share['allow_download']) return Json::err($res, 'Download disabled', 403);
        $err = self::gate($share, $req);
        if ($err) return Json::err($res, $err['error'], $err['status']);

        $fileId = (int)$args['id'];
        $pdo = Database::pdo();

        if ($share['file_id'] && (int)$share['file_id'] !== $fileId) {
            return Json::err($res, 'Forbidden', 403);
        }
        if ($share['folder_id']) {
            $check = $pdo->prepare('SELECT 1 FROM files WHERE id = ? AND folder_id = ?');
            $check->execute([$fileId, (int)$share['folder_id']]);
            if (!$check->fetch()) return Json::err($res, 'Forbidden', 403);
        }

        $stmt = $pdo->prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL');
        $stmt->execute([$fileId]);
        $file = $stmt->fetch();
        if (!$file) return Json::err($res, 'Not found', 404);

        self::logEvent((int)$share['id'], 'download', $fileId, (string)$file['name'], $req);

        // Inline by default so the MediaViewer can preview images/video/PDF in
        // place; force a download only when ?dl=1 is present (the explicit
        // "Download" buttons append it).
        $download = isset($req->getQueryParams()['dl']);
        return FileRoutes::stream($res, $file, $download);
    }
}
