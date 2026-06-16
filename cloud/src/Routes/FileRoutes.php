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
            $g->get('',                       [self::class, 'list']);
            $g->get('/search',                [self::class, 'search']);
            $g->get('/recent',                [self::class, 'recent']);
            $g->post('',                      [self::class, 'upload']);
            $g->post('/text',                 [self::class, 'createText']);
            $g->post('/move',                 [self::class, 'moveBulk']);
            // Resumable chunked upload for large owner files.
            $g->post('/chunk/init',           [self::class, 'chunkInit']);
            $g->post('/chunk/{sid}',          [self::class, 'chunkAppend']);
            $g->get('/chunk/{sid}',           [self::class, 'chunkStatus']);
            $g->post('/chunk/{sid}/finalize', [self::class, 'chunkFinalize']);
            $g->get('/{id}',                  [self::class, 'show']);
            $g->get('/{id}/raw',              [self::class, 'raw']);
            $g->get('/{id}/thumb',            [self::class, 'thumb']);
            $g->post('/{id}/star',            [self::class, 'star']);
            $g->patch('/{id}',                [self::class, 'move']);
            $g->put('/{id}/content',          [self::class, 'saveContent']);
            $g->get('/{id}/versions',         [self::class, 'versions']);
            $g->get('/{id}/versions/{vid}',   [self::class, 'versionContent']);
            $g->post('/{id}/versions/{vid}/restore', [self::class, 'restoreVersion']);
            $g->post('/{id}/restore',         [self::class, 'restore']);
            $g->delete('/{id}/permanent',     [self::class, 'permanent']);
            $g->delete('/{id}',               [self::class, 'delete']);
        })->add(new AuthMiddleware());

        $app->post('/api/files/zip',  [self::class, 'zip'])->add(new AuthMiddleware());
        $app->get('/api/trash',       [self::class, 'trashList'])->add(new AuthMiddleware());
        $app->post('/api/trash/empty',[self::class, 'trashEmpty'])->add(new AuthMiddleware());
    }

    public static function list(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $q = $req->getQueryParams();
        $folder = isset($q['folder_id']) ? (int)$q['folder_id'] : null;
        $limit = min(200, max(1, (int)($q['limit'] ?? 50)));

        $starred = isset($q['starred']);
        $pdo = Database::pdo();
        if ($starred) {
            $stmt = $pdo->prepare("SELECT * FROM files WHERE user_id = ? AND deleted_at IS NULL AND starred = 1 ORDER BY created_at DESC LIMIT $limit");
            $stmt->execute([$uid]);
        } elseif ($folder === null) {
            $stmt = $pdo->prepare("SELECT * FROM files WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT $limit");
            $stmt->execute([$uid]);
        } else {
            $stmt = $pdo->prepare("SELECT * FROM files WHERE user_id = ? AND folder_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT $limit");
            $stmt->execute([$uid, $folder]);
        }
        return Json::ok($res, ['files' => $stmt->fetchAll()]);
    }

    // Recently OPENED files (opened_at bumped on raw view/download).
    public static function recent(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $stmt = Database::pdo()->prepare('SELECT * FROM files WHERE user_id = ? AND deleted_at IS NULL AND opened_at IS NOT NULL ORDER BY opened_at DESC LIMIT 18');
        $stmt->execute([$uid]);
        return Json::ok($res, ['files' => $stmt->fetchAll()]);
    }

    public static function star(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        $on = !empty($b['starred']) ? 1 : 0;
        Database::pdo()->prepare('UPDATE files SET starred = ? WHERE id = ? AND user_id = ?')
            ->execute([$on, (int)$args['id'], $uid]);
        return Json::ok($res, ['ok' => true, 'starred' => (bool)$on]);
    }

    // Server-side search across ALL of the user's live files + folders.
    public static function search(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $q = trim((string)($req->getQueryParams()['q'] ?? ''));
        if ($q === '') return Json::ok($res, ['files' => [], 'folders' => []]);
        $like = '%' . str_replace(['%', '_'], ['\%', '\_'], $q) . '%';
        $pdo = Database::pdo();

        $f = $pdo->prepare("SELECT * FROM files WHERE user_id = ? AND deleted_at IS NULL AND name LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 100");
        $f->execute([$uid, $like]);
        $folders = $pdo->prepare("SELECT id, name, kind, tone, parent_id FROM folders WHERE user_id = ? AND name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 50");
        $folders->execute([$uid, $like]);
        return Json::ok($res, ['files' => $f->fetchAll(), 'folders' => $folders->fetchAll()]);
    }

    // Move a single file to another folder (or to root when folder_id is null).
    public static function move(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $f = self::fetchOne($uid, (int)$args['id']);
        if (!$f) return Json::err($res, 'Not found', 404);
        $b = (array) $req->getParsedBody();
        $target = array_key_exists('folder_id', $b) && $b['folder_id'] !== null ? (int)$b['folder_id'] : null;
        if ($target !== null && !self::folderOwned($uid, $target)) {
            return Json::err($res, 'Zielordner nicht gefunden', 404);
        }
        Database::pdo()->prepare('UPDATE files SET folder_id = ? WHERE id = ? AND user_id = ?')
            ->execute([$target, (int)$f['id'], $uid]);
        return Json::ok($res, ['file' => self::fetchOne($uid, (int)$f['id'])]);
    }

    public static function moveBulk(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        $ids = array_values(array_filter(array_map('intval', (array)($b['file_ids'] ?? []))));
        $target = array_key_exists('folder_id', $b) && $b['folder_id'] !== null ? (int)$b['folder_id'] : null;
        if (!$ids) return Json::err($res, 'No files specified', 422);
        if ($target !== null && !self::folderOwned($uid, $target)) {
            return Json::err($res, 'Zielordner nicht gefunden', 404);
        }
        $place = implode(',', array_fill(0, count($ids), '?'));
        Database::pdo()->prepare("UPDATE files SET folder_id = ? WHERE user_id = ? AND id IN ($place)")
            ->execute(array_merge([$target, $uid], $ids));
        return Json::ok($res, ['ok' => true, 'moved' => count($ids)]);
    }

    private static function folderOwned(int $uid, int $fid): bool
    {
        $s = Database::pdo()->prepare('SELECT 1 FROM folders WHERE id = ? AND user_id = ?');
        $s->execute([$fid, $uid]);
        return (bool)$s->fetch();
    }

    // On-demand image thumbnail (max 400px), cached under storage/thumbs/.
    // Falls back to streaming the original when GD is unavailable or the file
    // isn't a raster image — the frontend can always use this URL for images.
    public static function thumb(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $f = self::fetchOne($uid, (int)$args['id']);
        if (!$f) return Json::err($res, 'Not found', 404);

        $src = Storage::abs($f['storage_path']);
        if (!is_file($src)) return Json::err($res, 'File missing on disk', 410);

        $mime = strtolower($f['mime_type'] ?? '');
        $canThumb = extension_loaded('gd') && in_array($mime, ['image/jpeg', 'image/png', 'image/gif', 'image/webp'], true);
        if (!$canThumb) {
            return self::stream($res, $f); // graceful fallback (e.g. svg/no-GD)
        }

        $thumbDir = Storage::root() . '/thumbs';
        if (!is_dir($thumbDir)) @mkdir($thumbDir, 0775, true);
        $thumbPath = $thumbDir . '/' . (int)$f['id'] . '.jpg';

        if (!is_file($thumbPath) || filemtime($thumbPath) < filemtime($src)) {
            if (!self::makeThumb($src, $thumbPath, $mime, 400)) {
                return self::stream($res, $f);
            }
        }
        $stream = fopen($thumbPath, 'rb');
        return $res
            ->withHeader('Content-Type', 'image/jpeg')
            ->withHeader('Content-Length', (string)filesize($thumbPath))
            ->withHeader('Cache-Control', 'private, max-age=86400')
            ->withHeader('X-Content-Type-Options', 'nosniff')
            ->withBody(new Stream($stream));
    }

    private static function makeThumb(string $src, string $dst, string $mime, int $max): bool
    {
        try {
            $img = match ($mime) {
                'image/jpeg' => @imagecreatefromjpeg($src),
                'image/png'  => @imagecreatefrompng($src),
                'image/gif'  => @imagecreatefromgif($src),
                'image/webp' => @imagecreatefromwebp($src),
                default      => false,
            };
            if (!$img) return false;
            $w = imagesx($img); $h = imagesy($img);
            $scale = min(1, $max / max($w, $h));
            $nw = max(1, (int)round($w * $scale)); $nh = max(1, (int)round($h * $scale));
            $thumb = imagecreatetruecolor($nw, $nh);
            // flatten transparency onto white (JPEG has no alpha)
            $white = imagecolorallocate($thumb, 255, 255, 255);
            imagefilledrectangle($thumb, 0, 0, $nw, $nh, $white);
            imagecopyresampled($thumb, $img, 0, 0, 0, 0, $nw, $nh, $w, $h);
            $ok = imagejpeg($thumb, $dst, 82);
            imagedestroy($img); imagedestroy($thumb);
            return $ok;
        } catch (\Throwable $e) {
            return false;
        }
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

        if (Storage::isDangerous($name)) {
            return Json::err($res, 'Dieser Dateityp ist aus Sicherheitsgründen nicht erlaubt', 415, 'blocked_type');
        }
        if (!self::quotaOk($uid, $size)) {
            return Json::err($res, 'Storage quota exceeded', 413, 'quota_exceeded');
        }

        $rel = Storage::relPath($uid, $name);
        $files->moveTo(Storage::abs($rel));

        $id = self::insertFile($uid, $folder, $name, $rel, $mime, $size, null, null);
        return Json::ok($res, ['file' => self::fetchOne($uid, $id)], 201);
    }

    // Max bytes accepted via the JSON text endpoints (create/save).
    private const TEXT_MAX = 2 * 1024 * 1024; // 2 MB

    public static function createText(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        $folder = isset($b['folder_id']) ? (int)$b['folder_id'] : null;
        $name = trim((string)($b['name'] ?? ''));
        $content = (string)($b['content'] ?? '');

        if ($name === '') $name = 'Neue Notiz.txt';
        if (!preg_match('/\.[A-Za-z0-9]{1,8}$/', $name)) $name .= '.txt';
        if (Storage::isDangerous($name)) {
            return Json::err($res, 'Dieser Dateityp ist nicht erlaubt', 415, 'blocked_type');
        }
        $size = strlen($content);
        if ($size > self::TEXT_MAX) return Json::err($res, 'Text zu groß (max 2 MB)', 413);
        if (!self::quotaOk($uid, $size)) return Json::err($res, 'Storage quota exceeded', 413, 'quota_exceeded');

        $rel = Storage::relPath($uid, $name);
        file_put_contents(Storage::abs($rel), $content);
        $mime = str_ends_with(strtolower($name), '.md') ? 'text/markdown' : 'text/plain';
        $id = self::insertFile($uid, $folder, $name, $rel, $mime, $size, null, null);
        return Json::ok($res, ['file' => self::fetchOne($uid, $id)], 201);
    }

    public static function saveContent(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $f = self::fetchOne($uid, (int)$args['id']);
        if (!$f) return Json::err($res, 'Not found', 404);

        $b = (array) $req->getParsedBody();
        if (!array_key_exists('content', $b)) return Json::err($res, 'content required', 422);
        $content = (string) $b['content'];
        $newSize = strlen($content);
        if ($newSize > self::TEXT_MAX) return Json::err($res, 'Text zu groß (max 2 MB)', 413);

        $delta = $newSize - (int)$f['size'];
        if ($delta > 0 && !self::quotaOk($uid, $delta)) {
            return Json::err($res, 'Storage quota exceeded', 413, 'quota_exceeded');
        }

        // Snapshot the PREVIOUS content into history before overwriting.
        self::snapshot($uid, $f);

        if (file_put_contents(Storage::abs($f['storage_path']), $content) === false) {
            return Json::err($res, 'Speichern fehlgeschlagen', 500);
        }
        $pdo = Database::pdo();
        $pdo->prepare('UPDATE files SET size = ? WHERE id = ? AND user_id = ?')->execute([$newSize, (int)$f['id'], $uid]);
        $pdo->prepare('UPDATE users SET storage_used = MAX(0, storage_used + ?) WHERE id = ?')->execute([$delta, $uid]);
        return Json::ok($res, ['file' => self::fetchOne($uid, (int)$f['id'])]);
    }

    // Save the current on-disk content as a history entry; keep the last 50.
    private static function snapshot(int $uid, array $f): void
    {
        $abs = Storage::abs($f['storage_path']);
        if (!is_file($abs)) return;
        $cur = (string) file_get_contents($abs);
        $pdo = Database::pdo();
        $ins = $pdo->prepare('INSERT INTO file_versions (file_id, user_id, content, size) VALUES (?, ?, ?, ?)');
        $ins->bindValue(1, (int)$f['id'], \PDO::PARAM_INT);
        $ins->bindValue(2, $uid, \PDO::PARAM_INT);
        $ins->bindValue(3, $cur, \PDO::PARAM_LOB);
        $ins->bindValue(4, strlen($cur), \PDO::PARAM_INT);
        $ins->execute();
        // prune: keep newest 50
        $pdo->prepare(
            'DELETE FROM file_versions WHERE file_id = ? AND id NOT IN '
            . '(SELECT id FROM (SELECT id FROM file_versions WHERE file_id = ? ORDER BY id DESC LIMIT 50) t)'
        )->execute([(int)$f['id'], (int)$f['id']]);
    }

    public static function versions(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $f = self::fetchOne($uid, (int)$args['id']);
        if (!$f) return Json::err($res, 'Not found', 404);
        $stmt = Database::pdo()->prepare('SELECT id, size, created_at FROM file_versions WHERE file_id = ? AND user_id = ? ORDER BY id DESC');
        $stmt->execute([(int)$f['id'], $uid]);
        return Json::ok($res, ['versions' => $stmt->fetchAll(), 'current' => ['size' => (int)$f['size']]]);
    }

    public static function versionContent(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $stmt = Database::pdo()->prepare('SELECT content FROM file_versions WHERE id = ? AND file_id = ? AND user_id = ?');
        $stmt->execute([(int)$args['vid'], (int)$args['id'], $uid]);
        $row = $stmt->fetch();
        if (!$row) return Json::err($res, 'Not found', 404);
        return Json::ok($res, ['content' => (string)$row['content']]);
    }

    public static function restoreVersion(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $f = self::fetchOne($uid, (int)$args['id']);
        if (!$f) return Json::err($res, 'Not found', 404);
        $pdo = Database::pdo();
        $stmt = $pdo->prepare('SELECT content FROM file_versions WHERE id = ? AND file_id = ? AND user_id = ?');
        $stmt->execute([(int)$args['vid'], (int)$f['id'], $uid]);
        $row = $stmt->fetch();
        if (!$row) return Json::err($res, 'Version not found', 404);

        $content = (string) $row['content'];
        $newSize = strlen($content);
        $delta = $newSize - (int)$f['size'];
        if ($delta > 0 && !self::quotaOk($uid, $delta)) {
            return Json::err($res, 'Storage quota exceeded', 413, 'quota_exceeded');
        }
        // snapshot current, then overwrite with the chosen version
        self::snapshot($uid, $f);
        if (file_put_contents(Storage::abs($f['storage_path']), $content) === false) {
            return Json::err($res, 'Wiederherstellen fehlgeschlagen', 500);
        }
        $pdo->prepare('UPDATE files SET size = ? WHERE id = ? AND user_id = ?')->execute([$newSize, (int)$f['id'], $uid]);
        $pdo->prepare('UPDATE users SET storage_used = MAX(0, storage_used + ?) WHERE id = ?')->execute([$delta, $uid]);
        return Json::ok($res, ['file' => self::fetchOne($uid, (int)$f['id'])]);
    }

    // ───── Resumable chunked upload (owner) ──────────────────────────────────
    public static function chunkInit(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        $name = (string)($b['file_name'] ?? '');
        $size = (int)($b['total_size'] ?? 0);
        $folder = isset($b['folder_id']) ? (int)$b['folder_id'] : null;
        $chunkSize = (int)($b['chunk_size'] ?? (8 * 1024 * 1024));
        if ($name === '' || $size <= 0) return Json::err($res, 'file_name + total_size required', 422);
        if (Storage::isDangerous($name)) return Json::err($res, 'Dieser Dateityp ist nicht erlaubt', 415, 'blocked_type');
        if (!self::quotaOk($uid, $size)) return Json::err($res, 'Storage quota exceeded', 413, 'quota_exceeded');

        $sid = bin2hex(random_bytes(12));
        $tempPath = Storage::temp() . '/' . $sid . '.part';
        touch($tempPath);
        Database::pdo()->prepare(
            'INSERT INTO upload_sessions (id, upload_link_id, user_id, folder_id, file_name, total_size, chunk_size, temp_path) '
            . 'VALUES (?, NULL, ?, ?, ?, ?, ?, ?)'
        )->execute([$sid, $uid, $folder, $name, $size, $chunkSize, $tempPath]);
        return Json::ok($res, ['session_id' => $sid, 'received' => 0, 'chunk_size' => $chunkSize], 201);
    }

    public static function chunkAppend(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $s = self::session($args['sid'], $uid);
        if (!$s) return Json::err($res, 'Session not found', 404);
        if ($s['status'] !== 'open') return Json::err($res, 'Session closed', 409);

        $body = (string) $req->getBody();
        if ($body === '') {
            $f = $req->getUploadedFiles()['chunk'] ?? null;
            if ($f) { if (is_array($f)) $f = $f[0]; $body = (string) $f->getStream(); }
        }
        if ($body === '') return Json::err($res, 'Empty chunk', 400);

        $fp = fopen($s['temp_path'], 'ab'); fwrite($fp, $body); fclose($fp);
        $received = (int)$s['received'] + strlen($body);
        Database::pdo()->prepare('UPDATE upload_sessions SET received = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            ->execute([$received, $s['id']]);
        return Json::ok($res, ['received' => $received, 'total' => (int)$s['total_size']]);
    }

    public static function chunkStatus(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $s = self::session($args['sid'], $uid);
        if (!$s) return Json::err($res, 'Not found', 404);
        return Json::ok($res, ['received' => (int)$s['received'], 'total' => (int)$s['total_size'], 'status' => $s['status']]);
    }

    public static function chunkFinalize(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $s = self::session($args['sid'], $uid);
        if (!$s) return Json::err($res, 'Session not found', 404);
        if ($s['status'] !== 'open') return Json::err($res, 'Already finalized', 409);
        if ((int)$s['received'] < (int)$s['total_size']) {
            return Json::err($res, 'Incomplete: ' . $s['received'] . ' / ' . $s['total_size'], 400);
        }

        $rel = Storage::relPath($uid, $s['file_name']);
        $abs = Storage::abs($rel);
        if (!@rename($s['temp_path'], $abs)) {
            if (!@copy($s['temp_path'], $abs)) return Json::err($res, 'Move failed', 500);
            @unlink($s['temp_path']);
        }
        $mime = mime_content_type($abs) ?: 'application/octet-stream';
        Database::pdo()->prepare("UPDATE upload_sessions SET status = 'finalized' WHERE id = ?")->execute([$s['id']]);

        $folder = $s['folder_id'] !== null ? (int)$s['folder_id'] : null;
        $id = self::insertFile($uid, $folder, $s['file_name'], $rel, $mime, (int)$s['total_size'], null, null);
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
        // Mark as recently opened (best-effort, ignore failures).
        try { Database::pdo()->prepare('UPDATE files SET opened_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')->execute([(int)$f['id'], $uid]); } catch (\Throwable $e) {}
        return self::stream($res, $f, isset($req->getQueryParams()['dl']));
    }

    // Soft delete — moves to trash. Blob stays, quota still counts it.
    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $f = self::fetchOne($uid, (int)$args['id']);
        if (!$f) return Json::err($res, 'Not found', 404);
        Database::pdo()->prepare('UPDATE files SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
            ->execute([(int)$args['id'], $uid]);
        return Json::ok($res, ['ok' => true, 'trashed' => true]);
    }

    public static function restore(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        Database::pdo()->prepare('UPDATE files SET deleted_at = NULL WHERE id = ? AND user_id = ?')
            ->execute([(int)$args['id'], $uid]);
        return Json::ok($res, ['ok' => true]);
    }

    public static function permanent(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $stmt = Database::pdo()->prepare('SELECT * FROM files WHERE id = ? AND user_id = ?');
        $stmt->execute([$id, $uid]);
        $f = $stmt->fetch();
        if (!$f) return Json::err($res, 'Not found', 404);
        self::hardDelete($uid, $f);
        return Json::ok($res, ['ok' => true]);
    }

    public static function trashList(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $stmt = Database::pdo()->prepare('SELECT * FROM files WHERE user_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 500');
        $stmt->execute([$uid]);
        return Json::ok($res, ['files' => $stmt->fetchAll()]);
    }

    public static function trashEmpty(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $stmt = Database::pdo()->prepare('SELECT * FROM files WHERE user_id = ? AND deleted_at IS NOT NULL');
        $stmt->execute([$uid]);
        $n = 0;
        foreach ($stmt->fetchAll() as $f) { self::hardDelete($uid, $f); $n++; }
        return Json::ok($res, ['ok' => true, 'removed' => $n]);
    }

    public static function zip(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        $ids = array_filter(array_map('intval', (array)($b['file_ids'] ?? [])));
        $folderId = isset($b['folder_id']) ? (int)$b['folder_id'] : null;
        if (!$ids && !$folderId) return Json::err($res, 'No files specified', 422);

        $pdo = Database::pdo();
        if ($folderId) {
            $stmt = $pdo->prepare('SELECT * FROM files WHERE user_id = ? AND folder_id = ? AND deleted_at IS NULL');
            $stmt->execute([$uid, $folderId]);
        } else {
            $place = implode(',', array_fill(0, count($ids), '?'));
            $stmt = $pdo->prepare("SELECT * FROM files WHERE user_id = ? AND deleted_at IS NULL AND id IN ($place)");
            $stmt->execute(array_merge([$uid], $ids));
        }
        $files = $stmt->fetchAll();
        if (!$files) return Json::err($res, 'No files found', 404);

        $zipPath = Storage::temp() . '/zip_' . bin2hex(random_bytes(8)) . '.zip';
        $zip = new \ZipArchive();
        if ($zip->open($zipPath, \ZipArchive::CREATE) !== true) return Json::err($res, 'Could not create archive', 500);
        $used = [];
        foreach ($files as $f) {
            $abs = Storage::abs($f['storage_path']);
            if (!is_file($abs)) continue;
            $base = $f['name']; $i = 1;
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
        register_shutdown_function(static fn() => @unlink($zipPath));
        return $res
            ->withHeader('Content-Type', 'application/zip')
            ->withHeader('Content-Disposition', 'attachment; filename="nyza-' . date('Ymd-His') . '.zip"')
            ->withHeader('Content-Length', (string)$size)
            ->withBody(new Stream($stream));
    }

    // ───── helpers ───────────────────────────────────────────────────────────
    private static function quotaOk(int $uid, int $size): bool
    {
        $u = Database::pdo()->prepare('SELECT storage_quota, storage_used FROM users WHERE id = ?');
        $u->execute([$uid]);
        $row = $u->fetch();
        return !$row || (int)$row['storage_used'] + $size <= (int)$row['storage_quota'];
    }

    private static function insertFile(int $uid, ?int $folder, string $name, string $rel, string $mime, int $size, ?int $linkId, ?string $uploaderName): int
    {
        $pdo = Database::pdo();
        $kind = Storage::kindFromMime($mime);
        $hue = (crc32($name) % 360);
        $pdo->prepare(
            'INSERT INTO files (user_id, folder_id, name, storage_path, mime_type, size, kind, hue, upload_link_id, uploader_name) '
            . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([$uid, $folder, $name, $rel, $mime, $size, $kind, $hue, $linkId, $uploaderName]);
        $id = (int)$pdo->lastInsertId();
        $pdo->prepare('UPDATE users SET storage_used = storage_used + ? WHERE id = ?')->execute([$size, $uid]);
        $pdo->prepare("INSERT INTO activity (user_id, kind, payload) VALUES (?, 'file_uploaded', ?)")
            ->execute([$uid, json_encode(['file_id' => $id, 'name' => $name, 'size' => $size])]);
        return $id;
    }

    private static function hardDelete(int $uid, array $f): void
    {
        Database::pdo()->prepare('DELETE FROM files WHERE id = ? AND user_id = ?')->execute([(int)$f['id'], $uid]);
        Database::pdo()->prepare('UPDATE users SET storage_used = MAX(0, storage_used - ?) WHERE id = ?')
            ->execute([(int)$f['size'], $uid]);
        Storage::deleteRel($f['storage_path']);
        @unlink(Storage::root() . '/thumbs/' . (int)$f['id'] . '.jpg');
    }

    private static function session(string $sid, int $uid): ?array
    {
        $stmt = Database::pdo()->prepare('SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?');
        $stmt->execute([$sid, $uid]);
        $s = $stmt->fetch();
        return $s ?: null;
    }

    public static function fetchOne(int $uid, int $id): ?array
    {
        $stmt = Database::pdo()->prepare('SELECT * FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL');
        $stmt->execute([$id, $uid]);
        $f = $stmt->fetch();
        return $f ?: null;
    }

    public static function stream(Response $res, array $file, bool $download = false): Response
    {
        $abs = Storage::abs($file['storage_path']);
        if (!is_file($abs)) return Json::err($res, 'File missing on disk', 410);

        $mime = $file['mime_type'] ?: 'application/octet-stream';
        // Force download for types that could execute script in our origin.
        if (Storage::mustDownload($mime)) $download = true;

        $stream = fopen($abs, 'rb');
        $disp = ($download ? 'attachment' : 'inline') . '; filename="' . addslashes($file['name']) . '"';
        return $res
            ->withHeader('Content-Type', $mime)
            ->withHeader('Content-Disposition', $disp)
            ->withHeader('Content-Length', (string)$file['size'])
            ->withHeader('X-Content-Type-Options', 'nosniff')
            ->withHeader('Cache-Control', 'private, max-age=600')
            ->withBody(new Stream($stream));
    }
}
