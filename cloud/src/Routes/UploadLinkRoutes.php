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
use Slim\Routing\RouteCollectorProxy;

final class UploadLinkRoutes
{
    public static function mount(App $app): void
    {
        // Owner: manage upload-links
        $app->group('/api/upload-links', function (RouteCollectorProxy $g) {
            $g->get('',         [self::class, 'list']);
            $g->post('',        [self::class, 'create']);
            $g->delete('/{id}', [self::class, 'delete']);
        })->add(new AuthMiddleware());

        // Public: client uploads
        $app->post('/api/u/{token}/unlock', [self::class, 'unlock']);
        $app->get('/api/u/{token}',         [self::class, 'show']);
        $app->post('/api/u/{token}/upload', [self::class, 'upload']);

        // Chunked upload (resumable)
        $app->post('/api/u/{token}/chunk/init',     [self::class, 'chunkInit']);
        $app->post('/api/u/{token}/chunk/{sid}',    [self::class, 'chunkAppend']);
        $app->post('/api/u/{token}/chunk/{sid}/finalize', [self::class, 'chunkFinalize']);
        $app->get('/api/u/{token}/chunk/{sid}',     [self::class, 'chunkStatus']);
    }

    public static function list(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $stmt = Database::pdo()->prepare(
            'SELECT ul.*, f.name as folder_name FROM upload_links ul '
            . 'LEFT JOIN folders f ON f.id = ul.folder_id '
            . 'WHERE ul.user_id = ? ORDER BY ul.created_at DESC'
        );
        $stmt->execute([$uid]);
        $rows = $stmt->fetchAll();
        foreach ($rows as &$r) {
            $r['has_password'] = !empty($r['password_hash']);
            unset($r['password_hash']);
        }
        return Json::ok($res, ['upload_links' => $rows]);
    }

    public static function create(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        $folderId = (int)($b['folder_id'] ?? 0);
        $title = trim((string)($b['title'] ?? ''));
        if (!$folderId || $title === '') return Json::err($res, 'folder_id and title required', 422);

        // verify folder belongs to user
        $check = Database::pdo()->prepare('SELECT 1 FROM folders WHERE id = ? AND user_id = ?');
        $check->execute([$folderId, $uid]);
        if (!$check->fetch()) return Json::err($res, 'Folder not found', 404);

        $token = Auth::randomToken(32);
        $passwordHash = !empty($b['password']) ? password_hash((string)$b['password'], PASSWORD_BCRYPT) : null;
        $expires = !empty($b['expires_at']) ? (string)$b['expires_at'] : null;
        $maxFiles = isset($b['max_files']) ? (int)$b['max_files'] : null;
        $maxSize = isset($b['max_file_size']) ? (int)$b['max_file_size'] : null;
        $notify = isset($b['notify_email']) ? (int)(bool)$b['notify_email'] : 1;
        $reqName = isset($b['require_uploader_name']) ? (int)(bool)$b['require_uploader_name'] : 0;

        $ins = Database::pdo()->prepare(
            'INSERT INTO upload_links '
            . '(user_id, folder_id, token, title, description, password_hash, expires_at, max_files, max_file_size, notify_email, require_uploader_name) '
            . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $ins->execute([
            $uid, $folderId, $token, $title, $b['description'] ?? null,
            $passwordHash, $expires, $maxFiles, $maxSize, $notify, $reqName,
        ]);
        $id = (int)Database::pdo()->lastInsertId();

        Database::pdo()->prepare("INSERT INTO activity (user_id, kind, payload) VALUES (?, 'upload_link_created', ?)")
            ->execute([$uid, json_encode(['link_id' => $id, 'token' => $token])]);

        return Json::ok($res, [
            'upload_link' => [
                'id' => $id, 'token' => $token, 'folder_id' => $folderId, 'title' => $title,
                'expires_at' => $expires, 'max_files' => $maxFiles, 'max_file_size' => $maxSize,
                'has_password' => $passwordHash !== null,
            ],
        ], 201);
    }

    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        Database::pdo()->prepare('DELETE FROM upload_links WHERE id = ? AND user_id = ?')
            ->execute([(int)$args['id'], $uid]);
        return Json::ok($res, ['ok' => true]);
    }

    private static function loadByToken(string $token): ?array
    {
        $stmt = Database::pdo()->prepare('SELECT * FROM upload_links WHERE token = ?');
        $stmt->execute([$token]);
        $r = $stmt->fetch();
        return $r ?: null;
    }

    private static function gate(array $link, ?string $password): ?array
    {
        if ($link['expires_at'] && strtotime($link['expires_at']) < time()) {
            return ['error' => 'expired', 'status' => 410];
        }
        if ($link['password_hash']) {
            if (!$password || !password_verify($password, $link['password_hash'])) {
                return ['error' => 'password_required', 'status' => 401];
            }
        }
        if ($link['max_files'] !== null && (int)$link['upload_count'] >= (int)$link['max_files']) {
            return ['error' => 'limit_reached', 'status' => 429];
        }
        return null;
    }

    public static function unlock(Request $req, Response $res, array $args): Response
    {
        if (!\Nyza\RateLimiter::allowReq($req, 'uplink_unlock', 10, 300, $args['token'])) {
            return Json::err($res, 'Zu viele Versuche — bitte später erneut', 429, 'rate_limited');
        }
        $link = self::loadByToken($args['token']);
        if (!$link) return Json::err($res, 'Not found', 404);
        $b = (array) $req->getParsedBody();
        $err = self::gate($link, $b['password'] ?? null);
        if ($err) return Json::err($res, $err['error'], $err['status']);
        return Json::ok($res, ['ok' => true]);
    }

    public static function show(Request $req, Response $res, array $args): Response
    {
        $link = self::loadByToken($args['token']);
        if (!$link) return Json::err($res, 'Not found', 404);

        $owner = Database::pdo()->prepare('SELECT id, name, accent, logo_path FROM users WHERE id = ?');
        $owner->execute([(int)$link['user_id']]);
        $ownerRow = $owner->fetch();

        return Json::ok($res, [
            'token' => $link['token'],
            'title' => $link['title'],
            'description' => $link['description'],
            'requires_password' => !empty($link['password_hash']),
            'requires_uploader_name' => (bool)$link['require_uploader_name'],
            'expires_at' => $link['expires_at'],
            'max_files' => $link['max_files'] !== null ? (int)$link['max_files'] : null,
            'max_file_size' => $link['max_file_size'] !== null ? (int)$link['max_file_size'] : null,
            'remaining' => $link['max_files'] !== null
                ? max(0, (int)$link['max_files'] - (int)$link['upload_count'])
                : null,
            'owner' => $ownerRow ? [
                'id' => (int)$ownerRow['id'], 'name' => $ownerRow['name'],
                'accent' => $ownerRow['accent'] ?? null, 'has_logo' => !empty($ownerRow['logo_path']),
            ] : null,
        ]);
    }

    public static function upload(Request $req, Response $res, array $args): Response
    {
        $link = self::loadByToken($args['token']);
        if (!$link) return Json::err($res, 'Not found', 404);

        $b = (array) $req->getParsedBody();
        $err = self::gate($link, $b['password'] ?? null);
        if ($err) return Json::err($res, $err['error'], $err['status']);

        $files = $req->getUploadedFiles()['file'] ?? null;
        if (!$files) return Json::err($res, 'No file', 422);
        if (is_array($files)) $files = $files[0];
        if ($files->getError() !== UPLOAD_ERR_OK) return Json::err($res, 'Upload failed', 400);

        $size = (int)$files->getSize();
        $name = $files->getClientFilename() ?: 'upload.bin';
        $mime = $files->getClientMediaType() ?: 'application/octet-stream';

        if (Storage::isDangerous($name)) {
            return Json::err($res, 'Dieser Dateityp ist aus Sicherheitsgründen nicht erlaubt', 415, 'blocked_type');
        }
        if ($link['max_file_size'] && $size > (int)$link['max_file_size']) {
            return Json::err($res, 'file_too_large', 413);
        }

        $rel = Storage::relPath((int)$link['user_id'], $name);
        $files->moveTo(Storage::abs($rel));

        return self::recordFile($link, $rel, $name, $mime, $size, $b['uploader_name'] ?? null, $res);
    }

    public static function chunkInit(Request $req, Response $res, array $args): Response
    {
        $link = self::loadByToken($args['token']);
        if (!$link) return Json::err($res, 'Not found', 404);

        $b = (array) $req->getParsedBody();
        $err = self::gate($link, $b['password'] ?? null);
        if ($err) return Json::err($res, $err['error'], $err['status']);

        $name = (string)($b['file_name'] ?? '');
        $size = (int)($b['total_size'] ?? 0);
        $chunkSize = (int)($b['chunk_size'] ?? (10 * 1024 * 1024));
        if ($name === '' || $size <= 0) return Json::err($res, 'file_name + total_size required', 422);
        if (Storage::isDangerous($name)) return Json::err($res, 'Dieser Dateityp ist nicht erlaubt', 415, 'blocked_type');

        if ($link['max_file_size'] && $size > (int)$link['max_file_size']) {
            return Json::err($res, 'file_too_large', 413);
        }

        $sid = bin2hex(random_bytes(12));
        $tempPath = Storage::temp() . '/' . $sid . '.part';
        touch($tempPath);

        Database::pdo()->prepare(
            'INSERT INTO upload_sessions (id, upload_link_id, user_id, folder_id, file_name, total_size, chunk_size, temp_path, uploader_name) '
            . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([
            $sid, (int)$link['id'], (int)$link['user_id'], (int)$link['folder_id'],
            $name, $size, $chunkSize, $tempPath, $b['uploader_name'] ?? null,
        ]);

        return Json::ok($res, ['session_id' => $sid, 'received' => 0, 'chunk_size' => $chunkSize], 201);
    }

    public static function chunkAppend(Request $req, Response $res, array $args): Response
    {
        $link = self::loadByToken($args['token']);
        if (!$link) return Json::err($res, 'Not found', 404);

        $sid = $args['sid'];
        $stmt = Database::pdo()->prepare('SELECT * FROM upload_sessions WHERE id = ? AND upload_link_id = ?');
        $stmt->execute([$sid, (int)$link['id']]);
        $s = $stmt->fetch();
        if (!$s) return Json::err($res, 'Session not found', 404);
        if ($s['status'] !== 'open') return Json::err($res, 'Session closed', 409);

        $body = (string) $req->getBody();
        if ($body === '') {
            // multipart fallback
            $files = $req->getUploadedFiles()['chunk'] ?? null;
            if ($files) {
                if (is_array($files)) $files = $files[0];
                $body = (string) $files->getStream();
            }
        }
        if ($body === '') return Json::err($res, 'Empty chunk', 400);

        $fp = fopen($s['temp_path'], 'ab');
        fwrite($fp, $body);
        fclose($fp);

        $received = (int)$s['received'] + strlen($body);
        Database::pdo()->prepare('UPDATE upload_sessions SET received = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            ->execute([$received, $sid]);

        return Json::ok($res, ['received' => $received, 'total' => (int)$s['total_size']]);
    }

    public static function chunkStatus(Request $req, Response $res, array $args): Response
    {
        $stmt = Database::pdo()->prepare('SELECT received, total_size, status FROM upload_sessions WHERE id = ?');
        $stmt->execute([$args['sid']]);
        $s = $stmt->fetch();
        if (!$s) return Json::err($res, 'Not found', 404);
        return Json::ok($res, ['received' => (int)$s['received'], 'total' => (int)$s['total_size'], 'status' => $s['status']]);
    }

    public static function chunkFinalize(Request $req, Response $res, array $args): Response
    {
        $link = self::loadByToken($args['token']);
        if (!$link) return Json::err($res, 'Not found', 404);

        $sid = $args['sid'];
        $stmt = Database::pdo()->prepare('SELECT * FROM upload_sessions WHERE id = ? AND upload_link_id = ?');
        $stmt->execute([$sid, (int)$link['id']]);
        $s = $stmt->fetch();
        if (!$s) return Json::err($res, 'Session not found', 404);
        if ($s['status'] !== 'open') return Json::err($res, 'Already finalized', 409);
        if ((int)$s['received'] < (int)$s['total_size']) {
            return Json::err($res, 'Incomplete: received ' . $s['received'] . ' / ' . $s['total_size'], 400);
        }

        // move temp file into storage
        $rel = Storage::relPath((int)$s['user_id'], $s['file_name']);
        $abs = Storage::abs($rel);
        if (!@rename($s['temp_path'], $abs)) {
            // fallback to copy + unlink across filesystems
            if (!@copy($s['temp_path'], $abs)) {
                return Json::err($res, 'Move failed', 500);
            }
            @unlink($s['temp_path']);
        }

        $size = (int)$s['total_size'];
        $name = $s['file_name'];
        $mime = mime_content_type($abs) ?: 'application/octet-stream';

        Database::pdo()->prepare("UPDATE upload_sessions SET status = 'finalized' WHERE id = ?")->execute([$sid]);

        return self::recordFile($link, $rel, $name, $mime, $size, $s['uploader_name'], $res);
    }

    private static function recordFile(array $link, string $rel, string $name, string $mime, int $size, ?string $uploaderName, Response $res): Response
    {
        $kind = Storage::kindFromMime($mime);
        $hue = (crc32($name) % 360);

        $pdo = Database::pdo();
        $ins = $pdo->prepare(
            'INSERT INTO files (user_id, folder_id, name, storage_path, mime_type, size, kind, hue, upload_link_id, uploader_name) '
            . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $ins->execute([
            (int)$link['user_id'], (int)$link['folder_id'],
            $name, $rel, $mime, $size, $kind, $hue,
            (int)$link['id'], $uploaderName,
        ]);
        $id = (int)$pdo->lastInsertId();

        $pdo->prepare('UPDATE users SET storage_used = storage_used + ? WHERE id = ?')
            ->execute([$size, (int)$link['user_id']]);
        $pdo->prepare('UPDATE upload_links SET upload_count = upload_count + 1 WHERE id = ?')
            ->execute([(int)$link['id']]);
        $pdo->prepare("INSERT INTO activity (user_id, kind, payload) VALUES (?, 'external_upload', ?)")
            ->execute([(int)$link['user_id'], json_encode([
                'file_id' => $id, 'name' => $name, 'size' => $size,
                'upload_link_id' => (int)$link['id'], 'uploader_name' => $uploaderName,
            ])]);

        // notification (best-effort, no-op if SMTP not configured)
        if ((int)$link['notify_email']) {
            self::notifyOwner((int)$link['user_id'], $link['title'], $name, $size, $uploaderName);
        }

        return Json::ok($res, [
            'file' => [
                'id' => $id, 'name' => $name, 'size' => $size,
                'kind' => $kind, 'mime_type' => $mime,
                'uploader_name' => $uploaderName,
            ],
        ], 201);
    }

    private static function notifyOwner(int $userId, string $linkTitle, string $fileName, int $size, ?string $uploader): void
    {
        $stmt = Database::pdo()->prepare('SELECT email, name FROM users WHERE id = ?');
        $stmt->execute([$userId]);
        $u = $stmt->fetch();
        if (!$u) return;

        $body = "Hi {$u['name']},\n\nNeue Datei wurde via Upload-Link \"$linkTitle\" hochgeladen:\n\n"
              . "  Datei: $fileName\n"
              . "  Größe: " . Storage::humanSize($size) . "\n"
              . ($uploader ? "  Von: $uploader\n" : '')
              . "\n— Nyza Cloud";
        \Nyza\Mailer::send($u['email'], 'Neue Datei: ' . $linkTitle, $body);
    }
}
