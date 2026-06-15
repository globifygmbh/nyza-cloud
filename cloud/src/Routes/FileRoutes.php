<?php
declare(strict_types=1);

namespace Nyza\Routes;

use Nyza\Database;
use Nyza\Json;
use Nyza\Middleware\AuthMiddleware;
use Nyza\Storage;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;
use Slim\Psr7\Stream;
use Slim\Routing\RouteCollectorProxy;

final class FileRoutes
{
    public static function mount(App $app): void
    {
        $app->group('/api/files', function (RouteCollectorProxy $g) {
            $g->get('',           [self::class, 'list']);
            $g->post('',          [self::class, 'upload']);
            $g->get('/{id}',      [self::class, 'show']);
            $g->get('/{id}/raw',  [self::class, 'raw']);
            $g->delete('/{id}',   [self::class, 'delete']);
        })->add(new AuthMiddleware());

        $app->post('/api/files/zip', [self::class, 'zip'])->add(new AuthMiddleware());
    }

    public static function list(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $q = $req->getQueryParams();
        $folder = isset($q['folder_id']) ? (int)$q['folder_id'] : null;
        $limit = min(200, max(1, (int)($q['limit'] ?? 50)));

        $pdo = Database::pdo();
        // $limit is inlined (already cast + clamped to an int above). Binding it
        // as a parameter would break on MySQL with emulated prepares off —
        // `LIMIT ?` receives the value as a string ('50') which is a syntax error.
        if ($folder === null) {
            $stmt = $pdo->prepare("SELECT * FROM files WHERE user_id = ? ORDER BY created_at DESC LIMIT $limit");
            $stmt->execute([$uid]);
        } else {
            $stmt = $pdo->prepare("SELECT * FROM files WHERE user_id = ? AND folder_id = ? ORDER BY created_at DESC LIMIT $limit");
            $stmt->execute([$uid, $folder]);
        }
        return Json::ok($res, ['files' => $stmt->fetchAll()]);
    }

    public static function upload(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        $folder = isset($b['folder_id']) ? (int)$b['folder_id'] : null;

        $files = $req->getUploadedFiles()['file'] ?? null;
        if (!$files) return Json::err($res, 'No file uploaded', 422);
        if (is_array($files)) $files = $files[0];

        if ($files->getError() !== UPLOAD_ERR_OK) {
            return Json::err($res, 'Upload failed (code ' . $files->getError() . ')', 400);
        }

        $size = (int)$files->getSize();
        $name = $files->getClientFilename() ?: 'upload.bin';
        $mime = $files->getClientMediaType() ?: 'application/octet-stream';

        // quota check
        $u = Database::pdo()->prepare('SELECT storage_quota, storage_used FROM users WHERE id = ?');
        $u->execute([$uid]);
        $row = $u->fetch();
        if ($row && (int)$row['storage_used'] + $size > (int)$row['storage_quota']) {
            return Json::err($res, 'Storage quota exceeded', 413, 'quota_exceeded');
        }

        $rel = Storage::relPath($uid, $name);
        $files->moveTo(Storage::abs($rel));

        $kind = Storage::kindFromMime($mime);
        $hue = (crc32($name) % 360);

        $ins = Database::pdo()->prepare(
            'INSERT INTO files (user_id, folder_id, name, storage_path, mime_type, size, kind, hue) '
            . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $ins->execute([$uid, $folder, $name, $rel, $mime, $size, $kind, $hue]);
        $id = (int)Database::pdo()->lastInsertId();

        Database::pdo()->prepare('UPDATE users SET storage_used = storage_used + ? WHERE id = ?')
            ->execute([$size, $uid]);

        Database::pdo()->prepare(
            "INSERT INTO activity (user_id, kind, payload) VALUES (?, 'file_uploaded', ?)"
        )->execute([$uid, json_encode(['file_id' => $id, 'name' => $name, 'size' => $size])]);

        return Json::ok($res, ['file' => self::fetchOne($uid, $id)], 201);
    }

    public static function show(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $f = self::fetchOne($uid, (int)$args['id']);
        if (!$f) return Json::err($res, 'Not found', 404);
        return Json::ok($res, ['file' => $f]);
    }

    public static function raw(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $f = self::fetchOne($uid, (int)$args['id']);
        if (!$f) return Json::err($res, 'Not found', 404);
        return self::stream($res, $f);
    }

    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $f = self::fetchOne($uid, $id);
        if (!$f) return Json::err($res, 'Not found', 404);

        Database::pdo()->prepare('DELETE FROM files WHERE id = ? AND user_id = ?')->execute([$id, $uid]);
        Database::pdo()->prepare('UPDATE users SET storage_used = MAX(0, storage_used - ?) WHERE id = ?')
            ->execute([(int)$f['size'], $uid]);
        Storage::deleteRel($f['storage_path']);
        return Json::ok($res, ['ok' => true]);
    }

    public static function zip(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        $ids = array_filter(array_map('intval', (array)($b['file_ids'] ?? [])));
        $folderId = isset($b['folder_id']) ? (int)$b['folder_id'] : null;

        if (!$ids && !$folderId) return Json::err($res, 'No files specified', 422);

        $pdo = Database::pdo();
        $files = [];
        if ($folderId) {
            $stmt = $pdo->prepare('SELECT * FROM files WHERE user_id = ? AND folder_id = ?');
            $stmt->execute([$uid, $folderId]);
            $files = $stmt->fetchAll();
        } else {
            $place = implode(',', array_fill(0, count($ids), '?'));
            $stmt = $pdo->prepare("SELECT * FROM files WHERE user_id = ? AND id IN ($place)");
            $stmt->execute(array_merge([$uid], $ids));
            $files = $stmt->fetchAll();
        }
        if (!$files) return Json::err($res, 'No files found', 404);

        $zipPath = Storage::temp() . '/zip_' . bin2hex(random_bytes(8)) . '.zip';
        $zip = new \ZipArchive();
        if ($zip->open($zipPath, \ZipArchive::CREATE) !== true) {
            return Json::err($res, 'Could not create archive', 500);
        }
        $used = [];
        foreach ($files as $f) {
            $abs = Storage::abs($f['storage_path']);
            if (!is_file($abs)) continue;
            $base = $f['name'];
            $i = 1;
            while (isset($used[$base])) {
                $info = pathinfo($f['name']);
                $base = $info['filename'] . " ($i)" . (isset($info['extension']) ? '.' . $info['extension'] : '');
                $i++;
            }
            $used[$base] = true;
            $zip->addFile($abs, $base);
        }
        $zip->close();

        $size = filesize($zipPath);
        $stream = fopen($zipPath, 'rb');
        $body = new Stream($stream);

        // Best-effort: delete after request. PHP closes the stream on script end.
        register_shutdown_function(static function () use ($zipPath) {
            @unlink($zipPath);
        });

        $name = 'nyza-' . date('Ymd-His') . '.zip';
        return $res
            ->withHeader('Content-Type', 'application/zip')
            ->withHeader('Content-Disposition', 'attachment; filename="' . $name . '"')
            ->withHeader('Content-Length', (string)$size)
            ->withBody($body);
    }

    public static function fetchOne(int $uid, int $id): ?array
    {
        $stmt = Database::pdo()->prepare('SELECT * FROM files WHERE id = ? AND user_id = ?');
        $stmt->execute([$id, $uid]);
        $f = $stmt->fetch();
        return $f ?: null;
    }

    public static function stream(Response $res, array $file, bool $download = false): Response
    {
        $abs = Storage::abs($file['storage_path']);
        if (!is_file($abs)) {
            return Json::err($res, 'File missing on disk', 410);
        }
        $stream = fopen($abs, 'rb');
        $body = new Stream($stream);
        $disp = ($download ? 'attachment' : 'inline') . '; filename="' . addslashes($file['name']) . '"';
        return $res
            ->withHeader('Content-Type', $file['mime_type'] ?: 'application/octet-stream')
            ->withHeader('Content-Disposition', $disp)
            ->withHeader('Content-Length', (string)$file['size'])
            ->withHeader('Cache-Control', 'private, max-age=600')
            ->withBody($body);
    }
}
