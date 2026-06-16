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
            $g->delete('/{id}', [self::class, 'delete']);
        })->add(new AuthMiddleware());

        // Public (no auth) endpoints
        $app->post('/api/s/{token}/unlock',  [self::class, 'unlock']);
        $app->get('/api/s/{token}',          [self::class, 'show']);
        $app->get('/api/s/{token}/zip',      [self::class, 'downloadZip']);
        $app->get('/api/s/{token}/file/{id}',[self::class, 'downloadFile']);
    }

    public static function list(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $stmt = Database::pdo()->prepare('SELECT * FROM share_links WHERE user_id = ? ORDER BY created_at DESC');
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

        $ins = Database::pdo()->prepare(
            'INSERT INTO share_links (user_id, folder_id, file_id, token, password_hash, expires_at, allow_download) '
            . 'VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        $ins->execute([$uid, $folder, $file, $token, $passwordHash, $expires, $allowDownload]);
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
                'has_password' => $passwordHash !== null,
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

    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        Database::pdo()->prepare('DELETE FROM share_links WHERE id = ? AND user_id = ?')->execute([$id, $uid]);
        return Json::ok($res, ['ok' => true]);
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
        $owner = $pdo->prepare('SELECT name, email FROM users WHERE id = ?');
        $owner->execute([(int)$share['user_id']]);
        $ownerRow = $owner->fetch();

        $payload = [
            'token' => $share['token'],
            'allow_download' => (bool)$share['allow_download'],
            'expires_at' => $share['expires_at'],
            'owner' => $ownerRow ? ['name' => $ownerRow['name'], 'email' => $ownerRow['email']] : null,
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

        $zipPath = Storage::temp() . '/share_' . bin2hex(random_bytes(8)) . '.zip';
        $zip = new \ZipArchive();
        $zip->open($zipPath, \ZipArchive::CREATE);
        foreach ($rows as $r) {
            $abs = Storage::abs($r['storage_path']);
            if (is_file($abs)) $zip->addFile($abs, $r['name']);
        }
        $zip->close();

        $stream = fopen($zipPath, 'rb');
        register_shutdown_function(static fn() => @unlink($zipPath));
        $name = 'share-' . substr($share['token'], 0, 8) . '.zip';
        return $res
            ->withHeader('Content-Type', 'application/zip')
            ->withHeader('Content-Disposition', 'attachment; filename="' . $name . '"')
            ->withHeader('Content-Length', (string)filesize($zipPath))
            ->withBody(new Stream($stream));
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

        // Inline by default so the MediaViewer can preview images/video/PDF in
        // place; force a download only when ?dl=1 is present (the explicit
        // "Download" buttons append it).
        $download = isset($req->getQueryParams()['dl']);
        return FileRoutes::stream($res, $file, $download);
    }
}
