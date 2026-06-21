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
            $g->get('/{id}/meta',             [self::class, 'meta']);
            $g->post('/{id}/star',            [self::class, 'star']);
            $g->post('/{id}/pin',             [self::class, 'pinFile']);
            $g->post('/{id}/label',           [self::class, 'setLabel']);
            $g->post('/{id}/unzip',           [self::class, 'unzip']);
            $g->get('/{id}/comments',         [self::class, 'comments']);
            $g->post('/{id}/comments',        [self::class, 'addComment']);
            $g->delete('/{id}/comments/{cid}',[self::class, 'deleteComment']);
            $g->patch('/{id}',                [self::class, 'move']);
            $g->put('/{id}/content',          [self::class, 'saveContent']);
            $g->get('/{id}/versions',         [self::class, 'versions']);
            $g->get('/{id}/versions/{vid}',   [self::class, 'versionContent']);
            $g->get('/{id}/versions/{vid}/raw', [self::class, 'versionRaw']);
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
            $stmt = $pdo->prepare("SELECT * FROM files WHERE user_id = ? AND deleted_at IS NULL AND starred = 1 ORDER BY pinned DESC, created_at DESC LIMIT $limit");
            $stmt->execute([$uid]);
        } elseif ($folder === null) {
            $stmt = $pdo->prepare("SELECT * FROM files WHERE user_id = ? AND deleted_at IS NULL ORDER BY pinned DESC, created_at DESC LIMIT $limit");
            $stmt->execute([$uid]);
        } else {
            $stmt = $pdo->prepare("SELECT * FROM files WHERE user_id = ? AND folder_id = ? AND deleted_at IS NULL ORDER BY pinned DESC, created_at DESC LIMIT $limit");
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

    public static function setLabel(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $f = self::fetchOne($uid, (int)$args['id']);
        if (!$f) return Json::err($res, 'Not found', 404);
        $b = (array) $req->getParsedBody();
        $allowed = [null, 'red', 'yellow', 'green'];
        $label = array_key_exists('label', $b) ? ($b['label'] === '' || $b['label'] === null ? null : (string)$b['label']) : 'remove';
        if (!in_array($label, $allowed, true)) return Json::err($res, 'Invalid label', 422);
        Database::pdo()->prepare('UPDATE files SET label = ? WHERE id = ? AND user_id = ?')
            ->execute([$label, (int)$f['id'], $uid]);
        return Json::ok($res, ['ok' => true, 'label' => $label]);
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

    public static function pinFile(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $f = self::fetchOne($uid, (int)$args['id']);
        if (!$f) return Json::err($res, 'Not found', 404);
        $newPin = $f['pinned'] ? 0 : 1;
        Database::pdo()->prepare('UPDATE files SET pinned = ? WHERE id = ? AND user_id = ?')
            ->execute([$newPin, (int)$f['id'], $uid]);
        return Json::ok($res, ['ok' => true, 'pinned' => (bool)$newPin]);
    }

    // ───── Comments (owner side) ─────────────────────────────────────────────
    /** Shared list shape used by both owner and public endpoints. */
    public static function listComments(int $fileId): array
    {
        $stmt = Database::pdo()->prepare('SELECT id, user_id, author_name, body, source, created_at FROM comments WHERE file_id = ? ORDER BY id ASC');
        $stmt->execute([$fileId]);
        return array_map(static function (array $c): array {
            return [
                'id' => (int)$c['id'], 'author_name' => $c['author_name'], 'body' => $c['body'],
                'source' => $c['source'], 'created_at' => $c['created_at'],
            ];
        }, $stmt->fetchAll());
    }

    public static function comments(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        if (!self::fetchOne($uid, (int)$args['id'])) return Json::err($res, 'Not found', 404);
        return Json::ok($res, ['comments' => self::listComments((int)$args['id'])]);
    }

    public static function addComment(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $f = self::fetchOne($uid, (int)$args['id']);
        if (!$f) return Json::err($res, 'Not found', 404);
        $b = (array) $req->getParsedBody();
        $body = trim((string)($b['body'] ?? ''));
        if ($body === '') return Json::err($res, 'Kommentar leer', 422);
        $body = mb_substr($body, 0, 5000);
        $name = Database::pdo()->query("SELECT name FROM users WHERE id = $uid")->fetch()['name'] ?? 'Owner';
        Database::pdo()->prepare("INSERT INTO comments (file_id, user_id, author_name, body, source) VALUES (?, ?, ?, ?, 'owner')")
            ->execute([(int)$f['id'], $uid, $name, $body]);
        \Nyza\Mentions::notify($uid, $name, $b['mentions'] ?? [], 'Datei „' . $f['name'] . '"', $body);
        return Json::ok($res, ['comments' => self::listComments((int)$f['id'])], 201);
    }

    public static function deleteComment(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $f = self::fetchOne($uid, (int)$args['id']);
        if (!$f) return Json::err($res, 'Not found', 404);
        // Owner may delete ANY comment on their own file (incl. guest feedback).
        Database::pdo()->prepare('DELETE FROM comments WHERE id = ? AND file_id = ?')
            ->execute([(int)$args['cid'], (int)$f['id']]);
        return Json::ok($res, ['ok' => true]);
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
        $folders = $pdo->prepare("SELECT id, name, kind, tone, parent_id FROM folders WHERE user_id = ? AND deleted_at IS NULL AND name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 50");
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
        $s = Database::pdo()->prepare('SELECT 1 FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NULL');
        $s->execute([$fid, $uid]);
        return (bool)$s->fetch();
    }

    // On-demand image thumbnail (max 400px), cached under storage/thumbs/.
    // Falls back to streaming the original when GD is unavailable or the file
    // isn't a raster image — the frontend can always use this URL for images.
    public static function thumb(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $f = self::fetchReadable($uid, (int)$args['id']);
        if (!$f) return Json::err($res, 'Not found', 404);
        return self::serveThumb($res, $f);
    }

    /** Rich metadata for the info panel: dimensions + EXIF (camera, lens, aperture…). */
    public static function meta(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $f = self::fetchReadable($uid, (int)$args['id']);
        if (!$f) return Json::err($res, 'Not found', 404);
        $abs = Storage::abs($f['storage_path']);
        $out = [];
        if (is_file($abs)) {
            $gi = @getimagesize($abs);
            if ($gi) { $out['width'] = (int)$gi[0]; $out['height'] = (int)$gi[1]; }
            if (function_exists('exif_read_data') && in_array(strtolower((string)$f['mime_type']), ['image/jpeg', 'image/tiff'], true)) {
                try { $e = @exif_read_data($abs); } catch (\Throwable $ex) { $e = false; }
                if (is_array($e)) {
                    $make = trim((string)($e['Make'] ?? '')); $model = trim((string)($e['Model'] ?? ''));
                    $cam = trim($make && $model && stripos($model, $make) === false ? "$make $model" : ($model ?: $make));
                    if ($cam !== '') $out['camera'] = $cam;
                    if (!empty($e['UndefinedTag:0xA434'])) $out['lens'] = trim((string)$e['UndefinedTag:0xA434']);
                    elseif (!empty($e['LensModel'])) $out['lens'] = trim((string)$e['LensModel']);
                    if (!empty($e['FNumber'])) $out['aperture'] = 'f/' . rtrim(rtrim(number_format(self::frac($e['FNumber']), 1, '.', ''), '0'), '.');
                    if (!empty($e['ExposureTime'])) { $x = self::frac($e['ExposureTime']); $out['exposure'] = $x > 0 && $x < 1 ? '1/' . round(1 / $x) . ' s' : rtrim(rtrim(number_format($x, 1), '0'), '.') . ' s'; }
                    $iso = $e['ISOSpeedRatings'] ?? ($e['ISO'] ?? null); if (is_array($iso)) $iso = $iso[0] ?? null; if ($iso) $out['iso'] = 'ISO ' . (int)$iso;
                    if (!empty($e['FocalLength'])) $out['focal'] = round(self::frac($e['FocalLength'])) . ' mm';
                }
            }
        }
        return Json::ok($res, ['meta' => $out]);
    }

    /** Parse an EXIF rational ("28/10") into a float. */
    private static function frac($v): float
    {
        if (is_array($v)) $v = $v[0] ?? 0;
        $v = (string)$v;
        if (str_contains($v, '/')) { [$a, $b] = array_pad(explode('/', $v, 2), 2, '1'); return (float)$b != 0.0 ? (float)$a / (float)$b : 0.0; }
        return (float)$v;
    }

    /** Serve a cached GD thumbnail for a file row (or fall back to the original).
     *  Shared by the owner endpoint and the public share thumbnail endpoint. */
    public static function serveThumb(Response $res, array $f): Response
    {
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

    /** EXIF orientation (1–8) of a JPEG — uses php-exif when present, else a
     *  minimal manual APP1 parser so rotation works without the extension. */
    private static function jpegOrientation(string $src): int
    {
        if (function_exists('exif_read_data')) {
            try { $e = @exif_read_data($src); if (is_array($e) && !empty($e['Orientation'])) return (int)$e['Orientation']; } catch (\Throwable $ex) {}
        }
        $fh = @fopen($src, 'rb');
        if (!$fh) return 1;
        try {
            if (fread($fh, 2) !== "\xFF\xD8") return 1;
            while (!feof($fh)) {
                $marker = fread($fh, 2);
                if (strlen($marker) < 2 || $marker[0] !== "\xFF") return 1;
                $m = ord($marker[1]);
                if ($m === 0xDA || $m === 0xD9) return 1;
                $lb = fread($fh, 2);
                if (strlen($lb) < 2) return 1;
                $seg = ((ord($lb[0]) << 8) + ord($lb[1])) - 2;
                if ($seg < 0) return 1;
                if ($m === 0xE1) {
                    $data = fread($fh, $seg);
                    if (substr($data, 0, 6) !== "Exif\x00\x00") return 1;
                    $t = substr($data, 6);
                    if (strlen($t) < 8) return 1;
                    $le = substr($t, 0, 2) === 'II';
                    $u16 = static fn($o) => $le ? (ord($t[$o]) | (ord($t[$o + 1]) << 8)) : ((ord($t[$o]) << 8) | ord($t[$o + 1]));
                    $u32 = static fn($o) => $le
                        ? (ord($t[$o]) | (ord($t[$o + 1]) << 8) | (ord($t[$o + 2]) << 16) | (ord($t[$o + 3]) << 24))
                        : ((ord($t[$o]) << 24) | (ord($t[$o + 1]) << 16) | (ord($t[$o + 2]) << 8) | ord($t[$o + 3]));
                    $ifd = $u32(4);
                    if ($ifd + 2 > strlen($t)) return 1;
                    $n = $u16($ifd);
                    for ($i = 0; $i < $n; $i++) {
                        $en = $ifd + 2 + $i * 12;
                        if ($en + 12 > strlen($t)) break;
                        if ($u16($en) === 0x0112) { $v = $u16($en + 8); return ($v >= 1 && $v <= 8) ? $v : 1; }
                    }
                    return 1;
                }
                fseek($fh, $seg, SEEK_CUR);
            }
        } catch (\Throwable $e) { return 1; } finally { fclose($fh); }
        return 1;
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
            // Honour EXIF orientation so portrait phone photos aren't shown
            // sideways/landscape. Works even without the php-exif extension.
            if ($mime === 'image/jpeg') {
                switch (self::jpegOrientation($src)) {
                    case 2: imageflip($img, IMG_FLIP_HORIZONTAL); break;
                    case 3: $img = imagerotate($img, 180, 0); break;
                    case 4: imageflip($img, IMG_FLIP_VERTICAL); break;
                    case 5: $img = imagerotate($img, -90, 0); imageflip($img, IMG_FLIP_HORIZONTAL); break;
                    case 6: $img = imagerotate($img, -90, 0); break;
                    case 7: $img = imagerotate($img, 90, 0); imageflip($img, IMG_FLIP_HORIZONTAL); break;
                    case 8: $img = imagerotate($img, 90, 0); break;
                }
            }
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

    /**
     * Backfill files.taken_at from EXIF for images uploaded before php-exif was
     * available (so galleries can sort by capture time). Bounded; optionally
     * scoped to one folder. Returns how many were filled.
     */
    public static function backfillTakenAt(?int $folderId, int $limit = 300): int
    {
        if (!function_exists('exif_read_data')) return 0;
        $pdo = Database::pdo();
        $sql = "SELECT id, storage_path, mime_type FROM files WHERE taken_at IS NULL AND deleted_at IS NULL "
             . "AND mime_type IN ('image/jpeg','image/tiff') "
             . ($folderId !== null ? 'AND folder_id = ? ' : '')
             . "ORDER BY id DESC LIMIT " . (int)$limit;
        $st = $pdo->prepare($sql);
        $st->execute($folderId !== null ? [$folderId] : []);
        $rows = $st->fetchAll();
        if (!$rows) return 0;
        $upd = $pdo->prepare('UPDATE files SET taken_at = ? WHERE id = ?');
        $n = 0;
        foreach ($rows as $r) {
            $t = self::extractTakenAt(Storage::abs($r['storage_path']), (string)$r['mime_type']);
            if ($t) { $upd->execute([$t, (int)$r['id']]); $n++; }
        }
        return $n;
    }

    public static function backfillTakenAtEndpoint(Request $req, Response $res): Response
    {
        $n = self::backfillTakenAt(null, 1000);
        return Json::ok($res, ['filled' => $n]);
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
        // Re-uploading a same-named file into the same folder versions it instead
        // of creating a duplicate — unless the client asked to keep both, in which
        // case we uniquify the name. Quota is checked against the net size delta.
        $existing = self::existingInFolder($uid, $folder, $name);
        $mode = (string)($b['mode'] ?? '');
        if ($existing && $mode === 'skip') {
            return Json::ok($res, ['skipped' => true, 'file' => self::fetchOne($uid, (int)$existing['id'])], 200);
        }
        if ($existing && $mode === 'keep_both') {
            $name = self::uniqueName($uid, $folder, $name);
            $existing = null;
        }
        $quotaNeed = $existing ? max(0, $size - (int)$existing['size']) : $size;
        if (!self::quotaOk($uid, $quotaNeed)) {
            return Json::err($res, 'Storage quota exceeded', 413, 'quota_exceeded');
        }

        $rel = Storage::relPath($uid, $name);
        $files->moveTo(Storage::abs($rel));

        if ($existing) {
            $id = self::replaceWithVersion($uid, $existing, $rel, $mime, $size);
        } else {
            $id = self::insertFile($uid, $folder, $name, $rel, $mime, $size, null, null);
        }
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
        self::adjustStorage($uid, $delta);
        return Json::ok($res, ['file' => self::fetchOne($uid, (int)$f['id'])]);
    }

    // Snapshot the file's CURRENT on-disk content as a history entry, then prune
    // to the newest 50. Small text files are stored inline (so the editor's
    // version diff/preview keeps working); everything else (incl. large binary
    // media) is copied to a versions/ blob on disk and referenced by path.
    private static function snapshot(int $uid, array $f): void
    {
        $abs = Storage::abs($f['storage_path']);
        if (!is_file($abs)) return;
        $size = (int) filesize($abs);
        $pdo = Database::pdo();

        if (self::isTextish($f) && $size <= self::TEXT_MAX) {
            $cur = (string) file_get_contents($abs);
            $ins = $pdo->prepare(
                'INSERT INTO file_versions (file_id, user_id, content, storage_path, mime_type, name, size) '
                . 'VALUES (?, ?, ?, NULL, ?, ?, ?)'
            );
            $ins->bindValue(1, (int)$f['id'], \PDO::PARAM_INT);
            $ins->bindValue(2, $uid, \PDO::PARAM_INT);
            $ins->bindValue(3, $cur, \PDO::PARAM_LOB);
            $ins->bindValue(4, (string)($f['mime_type'] ?? 'text/plain'));
            $ins->bindValue(5, (string)$f['name']);
            $ins->bindValue(6, strlen($cur), \PDO::PARAM_INT);
            $ins->execute();
        } else {
            $vrel = Storage::versionPath($uid);
            if (!@copy($abs, Storage::abs($vrel))) return;
            $pdo->prepare(
                'INSERT INTO file_versions (file_id, user_id, content, storage_path, mime_type, name, size) '
                . 'VALUES (?, ?, NULL, ?, ?, ?, ?)'
            )->execute([(int)$f['id'], $uid, $vrel, (string)($f['mime_type'] ?? 'application/octet-stream'), (string)$f['name'], $size]);
        }
        self::pruneVersions((int)$f['id']);
    }

    // Keep only the newest 50 versions of a file; unlink any pruned disk blobs.
    private static function pruneVersions(int $fileId): void
    {
        $pdo = Database::pdo();
        $keep = $pdo->prepare('SELECT id FROM file_versions WHERE file_id = ? ORDER BY id DESC LIMIT 50');
        $keep->execute([$fileId]);
        $keepIds = array_map('intval', array_column($keep->fetchAll(), 'id'));
        if (!$keepIds) return;
        $place = implode(',', array_fill(0, count($keepIds), '?'));
        $old = $pdo->prepare("SELECT id, storage_path FROM file_versions WHERE file_id = ? AND id NOT IN ($place)");
        $old->execute(array_merge([$fileId], $keepIds));
        $stale = $old->fetchAll();
        if (!$stale) return;
        foreach ($stale as $v) {
            if (!empty($v['storage_path'])) Storage::deleteRel($v['storage_path']);
        }
        $delPlace = implode(',', array_fill(0, count($stale), '?'));
        $pdo->prepare("DELETE FROM file_versions WHERE id IN ($delPlace)")
            ->execute(array_map(static fn($v) => (int)$v['id'], $stale));
    }

    // Text-like files are previewed/edited as text; their versions stay inline.
    private static function isTextish(array $f): bool
    {
        $mime = strtolower((string)($f['mime_type'] ?? ''));
        if (str_starts_with($mime, 'text/')) return true;
        if (in_array($mime, ['application/json', 'application/xml', 'application/javascript', 'application/x-yaml'], true)) return true;
        $ext = strtolower(pathinfo((string)$f['name'], PATHINFO_EXTENSION));
        return in_array($ext, [
            'txt', 'md', 'markdown', 'json', 'xml', 'yml', 'yaml', 'csv', 'log', 'ini', 'conf',
            'js', 'ts', 'jsx', 'tsx', 'css', 'scss', 'html', 'htm', 'php', 'py', 'rb', 'go', 'rs',
            'java', 'c', 'cpp', 'h', 'sh', 'sql', 'env',
        ], true);
    }

    /** Read a version's bytes whether stored inline (content) or on disk. */
    private static function versionBytes(array $v): string
    {
        if ($v['content'] !== null) return (string)$v['content'];
        if (!empty($v['storage_path'])) {
            $abs = Storage::abs($v['storage_path']);
            if (is_file($abs)) return (string) file_get_contents($abs);
        }
        return '';
    }

    public static function versions(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $f = self::fetchReadable($uid, (int)$args['id']);
        if (!$f) return Json::err($res, 'Not found', 404);
        // Versions belong to the file's OWNER; scope by the file's user_id so a
        // shared viewer sees the (read-only) history too.
        $ownerId = (int)$f['user_id'];
        $stmt = Database::pdo()->prepare('SELECT id, size, name, mime_type, (content IS NOT NULL) AS inline, created_at FROM file_versions WHERE file_id = ? AND user_id = ? ORDER BY id DESC');
        $stmt->execute([(int)$f['id'], $ownerId]);
        $rows = array_map(static function (array $v): array {
            return [
                'id' => (int)$v['id'], 'size' => (int)$v['size'],
                'name' => $v['name'], 'mime_type' => $v['mime_type'],
                'inline' => (bool)$v['inline'], 'created_at' => $v['created_at'],
            ];
        }, $stmt->fetchAll());
        return Json::ok($res, ['versions' => $rows, 'current' => ['size' => (int)$f['size'], 'name' => $f['name']]]);
    }

    public static function versionContent(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $f = self::fetchReadable($uid, (int)$args['id']);
        if (!$f) return Json::err($res, 'Not found', 404);
        $stmt = Database::pdo()->prepare('SELECT content, storage_path FROM file_versions WHERE id = ? AND file_id = ? AND user_id = ?');
        $stmt->execute([(int)$args['vid'], (int)$f['id'], (int)$f['user_id']]);
        $row = $stmt->fetch();
        if (!$row) return Json::err($res, 'Not found', 404);
        return Json::ok($res, ['content' => self::versionBytes($row)]);
    }

    // Download a version's raw bytes (used for binary file versions).
    public static function versionRaw(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $f = self::fetchReadable($uid, (int)$args['id']);
        if (!$f) return Json::err($res, 'Not found', 404);
        $stmt = Database::pdo()->prepare('SELECT content, storage_path, name, mime_type, size FROM file_versions WHERE id = ? AND file_id = ? AND user_id = ?');
        $stmt->execute([(int)$args['vid'], (int)$f['id'], (int)$f['user_id']]);
        $v = $stmt->fetch();
        if (!$v) return Json::err($res, 'Not found', 404);
        $bytes = self::versionBytes($v);
        $res->getBody()->write($bytes);
        $mime = $v['mime_type'] ?: 'application/octet-stream';
        if (Storage::mustDownload($mime)) $mime = 'application/octet-stream';
        return $res
            ->withHeader('Content-Type', $mime)
            ->withHeader('Content-Disposition', 'attachment; filename="' . addslashes((string)$v['name']) . '"')
            ->withHeader('X-Content-Type-Options', 'nosniff');
    }

    public static function restoreVersion(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $f = self::fetchOne($uid, (int)$args['id']);
        if (!$f) return Json::err($res, 'Not found', 404);
        $pdo = Database::pdo();
        $stmt = $pdo->prepare('SELECT content, storage_path FROM file_versions WHERE id = ? AND file_id = ? AND user_id = ?');
        $stmt->execute([(int)$args['vid'], (int)$f['id'], $uid]);
        $row = $stmt->fetch();
        if (!$row) return Json::err($res, 'Version not found', 404);

        $content = self::versionBytes($row);
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
        self::adjustStorage($uid, $delta);
        return Json::ok($res, ['file' => self::fetchOne($uid, (int)$f['id'])]);
    }

    // ───── Unzip an uploaded .zip into a new folder named after it ────────────
    public static function unzip(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $f = self::fetchOne($uid, (int)$args['id']);
        if (!$f) return Json::err($res, 'Not found', 404);
        if (strtolower(pathinfo($f['name'], PATHINFO_EXTENSION)) !== 'zip') {
            return Json::err($res, 'Keine ZIP-Datei', 422);
        }
        $abs = Storage::abs($f['storage_path']);
        if (!is_file($abs)) return Json::err($res, 'Datei fehlt auf der Platte', 410);

        $zip = new \ZipArchive();
        if ($zip->open($abs) !== true) return Json::err($res, 'ZIP konnte nicht geöffnet werden', 422);

        $entries = $zip->numFiles;
        if ($entries > 10000) { $zip->close(); return Json::err($res, 'ZIP enthält zu viele Dateien', 413); }
        $total = 0;
        for ($i = 0; $i < $entries; $i++) {
            $st = $zip->statIndex($i);
            if ($st) $total += (int)$st['size'];
        }
        if (!self::quotaOk($uid, $total)) { $zip->close(); return Json::err($res, 'Storage quota exceeded', 413, 'quota_exceeded'); }

        $parent = $f['folder_id'] !== null ? (int)$f['folder_id'] : null;
        $baseName = pathinfo($f['name'], PATHINFO_FILENAME) ?: 'Entpackt';
        $rootId = self::uniqueSubfolder($uid, $parent, $baseName);

        $count = 0; $skipped = 0;
        for ($i = 0; $i < $entries; $i++) {
            $name = $zip->getNameIndex($i);
            if ($name === false) continue;
            $name = str_replace('\\', '/', $name);
            $isDir = substr($name, -1) === '/';
            // Sanitise: drop empty / '.' / '..' segments (zip-slip protection).
            $parts = array_values(array_filter(explode('/', $name), static fn($p) => $p !== '' && $p !== '.' && $p !== '..'));
            if (!$parts) continue;

            $folderId = $rootId;
            $dirParts = $isDir ? $parts : array_slice($parts, 0, -1);
            foreach ($dirParts as $seg) { $folderId = self::ensureSubfolder($uid, $folderId, mb_substr($seg, 0, 255)); }
            if ($isDir) continue;

            $leaf = mb_substr($parts[count($parts) - 1], 0, 255);
            if (Storage::isDangerous($leaf)) { $skipped++; continue; }
            $st = $zip->statIndex($i);
            $size = (int)($st['size'] ?? 0);
            $in = $zip->getStream($name);
            if (!$in) { $skipped++; continue; }
            $rel = Storage::relPath($uid, $leaf);
            $out = fopen(Storage::abs($rel), 'wb');
            if (!$out) { fclose($in); $skipped++; continue; }
            stream_copy_to_stream($in, $out);
            fclose($out); fclose($in);
            $mime = mime_content_type(Storage::abs($rel)) ?: 'application/octet-stream';
            // Extracted files version same-named siblings just like normal uploads.
            $existing = self::existingInFolder($uid, $folderId, $leaf);
            if ($existing) self::replaceWithVersion($uid, $existing, $rel, $mime, $size);
            else self::insertFile($uid, $folderId, $leaf, $rel, $mime, $size, null, null);
            $count++;
        }
        $zip->close();
        return Json::ok($res, ['folder_id' => $rootId, 'extracted' => $count, 'skipped' => $skipped], 201);
    }

    /** Find or create a child folder by name; returns its id. */
    private static function ensureSubfolder(int $uid, ?int $parent, string $name): int
    {
        $pdo = Database::pdo();
        if ($parent === null) {
            $s = $pdo->prepare('SELECT id FROM folders WHERE user_id = ? AND parent_id IS NULL AND name = ? LIMIT 1');
            $s->execute([$uid, $name]);
        } else {
            $s = $pdo->prepare('SELECT id FROM folders WHERE user_id = ? AND parent_id = ? AND name = ? LIMIT 1');
            $s->execute([$uid, $parent, $name]);
        }
        if ($r = $s->fetch()) return (int)$r['id'];
        $pdo->prepare('INSERT INTO folders (user_id, parent_id, name, kind, tone) VALUES (?, ?, ?, ?, ?)')
            ->execute([$uid, $parent, $name, 'normal', 'violet']);
        return (int)$pdo->lastInsertId();
    }

    /** Create a new child folder, appending " (n)" until the name is free. */
    private static function uniqueSubfolder(int $uid, ?int $parent, string $base): int
    {
        $pdo = Database::pdo();
        $exists = static function (string $n) use ($pdo, $uid, $parent): bool {
            if ($parent === null) {
                $s = $pdo->prepare('SELECT 1 FROM folders WHERE user_id = ? AND parent_id IS NULL AND name = ?');
                $s->execute([$uid, $n]);
            } else {
                $s = $pdo->prepare('SELECT 1 FROM folders WHERE user_id = ? AND parent_id = ? AND name = ?');
                $s->execute([$uid, $parent, $n]);
            }
            return (bool)$s->fetch();
        };
        $name = $base; $i = 1;
        while ($exists($name)) { $name = $base . ' (' . $i . ')'; $i++; }
        $pdo->prepare('INSERT INTO folders (user_id, parent_id, name, kind, tone) VALUES (?, ?, ?, ?, ?)')
            ->execute([$uid, $parent, $name, 'normal', 'violet']);
        return (int)$pdo->lastInsertId();
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
        $name = $s['file_name'];
        $b = (array) $req->getParsedBody();
        $existing = self::existingInFolder($uid, $folder, $name);
        $mode = (string)($b['mode'] ?? '');
        if ($existing && $mode === 'skip') {
            @unlink($abs); // discard the just-assembled blob; keep the existing file
            return Json::ok($res, ['skipped' => true, 'file' => self::fetchOne($uid, (int)$existing['id'])], 200);
        }
        if ($existing && $mode === 'keep_both') {
            $name = self::uniqueName($uid, $folder, $name);
            $existing = null;
        }
        if ($existing) {
            $id = self::replaceWithVersion($uid, $existing, $rel, $mime, (int)$s['total_size']);
        } else {
            $id = self::insertFile($uid, $folder, $name, $rel, $mime, (int)$s['total_size'], null, null);
        }
        return Json::ok($res, ['file' => self::fetchOne($uid, $id)], 201);
    }

    public static function show(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $f = self::fetchReadable($uid, (int)$args['id']);
        if (!$f) return Json::err($res, 'Not found', 404);
        return Json::ok($res, ['file' => $f]);
    }

    public static function raw(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $f = self::fetchReadable($uid, (int)$args['id']);
        if (!$f) return Json::err($res, 'Not found', 404);
        // Mark as recently opened (best-effort) — only for the file's OWNER, so a
        // shared viewer never bumps someone else's recents. Scoped by user_id.
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
        // Also purge trashed FOLDER rows (folders soft-deleted via FolderRoutes).
        // Their files are removed above; the empty folder shells go here. FK
        // ON DELETE CASCADE drops any still-trashed nested folder rows.
        Database::pdo()->prepare('DELETE FROM folders WHERE user_id = ? AND deleted_at IS NOT NULL')
            ->execute([$uid]);
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

        // True streaming archive: constant memory, no temp file, instant start.
        $members = [];
        foreach ($files as $f) {
            $members[] = ['path' => Storage::abs($f['storage_path']), 'name' => $f['name']];
        }
        \Nyza\ZipStreamer::emit($members, 'nyza-' . date('Ymd-His') . '.zip');
        return $res; // unreachable — emit() exits after streaming
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
        // Pull the photo's real capture date from EXIF so galleries group by
        // when the shot was taken, not when it landed on the server.
        $takenAt = self::extractTakenAt(Storage::abs($rel), $mime);
        $pdo->prepare(
            'INSERT INTO files (user_id, folder_id, name, storage_path, mime_type, size, kind, hue, upload_link_id, uploader_name, taken_at) '
            . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([$uid, $folder, $name, $rel, $mime, $size, $kind, $hue, $linkId, $uploaderName, $takenAt]);
        $id = (int)$pdo->lastInsertId();
        $pdo->prepare('UPDATE users SET storage_used = storage_used + ? WHERE id = ?')->execute([$size, $uid]);
        $pdo->prepare("INSERT INTO activity (user_id, kind, payload) VALUES (?, 'file_uploaded', ?)")
            ->execute([$uid, json_encode(['file_id' => $id, 'name' => $name, 'size' => $size])]);
        self::maybeAutoRename($uid, $id, $folder, $name, $mime, $rel);
        return $id;
    }

    /**
     * In folders flagged auto_rename, OCR an uploaded receipt (image/PDF) and
     * rename it to "YYYY-MM-DD_Vendor_amount.ext". Silently no-ops when the
     * folder isn't flagged, OCR is unavailable or nothing useful was read.
     */
    private static function maybeAutoRename(int $uid, int $id, ?int $folder, string $name, string $mime, string $rel): void
    {
        if ($folder === null) return;
        $m = strtolower($mime);
        if (!str_starts_with($m, 'image/') && !str_contains($m, 'pdf')) return;
        $s = Database::pdo()->prepare('SELECT auto_rename FROM folders WHERE id = ? AND user_id = ?');
        $s->execute([$folder, $uid]);
        $row = $s->fetch();
        if (!$row || (int)$row['auto_rename'] !== 1) return;
        if (!\Nyza\Ocr::available()) return;
        try {
            $text = \Nyza\Ocr::extractText(Storage::abs($rel), $mime);
            if (trim($text) === '') return;
            $sug = \Nyza\Ocr::parse($text);
            $ext = pathinfo($name, PATHINFO_EXTENSION);
            $date = $sug['date'] ?: date('Y-m-d');
            $vendor = '';
            if (!empty($sug['vendor'])) {
                $vendor = trim(preg_replace('/\s+/', ' ', preg_replace('/[^\p{L}0-9 ]+/u', '', (string)$sug['vendor'])));
                $vendor = str_replace(' ', '-', mb_substr($vendor, 0, 40));
            }
            $amount = $sug['gross'] !== null ? number_format((float)$sug['gross'], 2, ',', '') . '€' : '';
            $parts = array_values(array_filter([$date, $vendor, $amount], static fn($p) => $p !== ''));
            if (!$parts) return;
            $base = implode('_', $parts);
            $newName = self::uniqueName($uid, $folder, $base . ($ext !== '' ? '.' . $ext : ''));
            if ($newName !== $name) {
                Database::pdo()->prepare('UPDATE files SET name = ? WHERE id = ? AND user_id = ?')->execute([$newName, $id, $uid]);
            }
        } catch (\Throwable $e) { /* best-effort; keep original name */ }
    }

    /**
     * Read the original capture timestamp from a JPEG/TIFF's EXIF block and
     * normalise it to 'Y-m-d H:i:s'. Returns null when the ext is missing, the
     * file isn't EXIF-bearing, or no usable date tag is present.
     */
    private static function extractTakenAt(string $abs, string $mime): ?string
    {
        if (!function_exists('exif_read_data')) return null;
        if (!in_array(strtolower($mime), ['image/jpeg', 'image/tiff'], true)) return null;
        if (!is_file($abs)) return null;
        try {
            $exif = @exif_read_data($abs);
        } catch (\Throwable $e) {
            return null;
        }
        if (!is_array($exif)) return null;
        $raw = $exif['DateTimeOriginal'] ?? $exif['DateTimeDigitized'] ?? $exif['DateTime'] ?? null;
        if (!is_string($raw) || $raw === '') return null;
        // EXIF dates are "YYYY:MM:DD HH:MM:SS"; tolerate already-normalised too.
        $ts = strtotime(str_replace(':', '-', substr($raw, 0, 10)) . substr($raw, 10));
        if ($ts === false || $ts <= 0) return null;
        return date('Y-m-d H:i:s', $ts);
    }

    private static function hardDelete(int $uid, array $f): void
    {
        // Remove any on-disk version blobs first (DB rows cascade via FK).
        // Best-effort: never let blob cleanup block the actual deletion.
        try {
            $vs = Database::pdo()->prepare('SELECT storage_path FROM file_versions WHERE file_id = ? AND storage_path IS NOT NULL');
            $vs->execute([(int)$f['id']]);
            foreach ($vs->fetchAll() as $v) { Storage::deleteRel($v['storage_path']); }
        } catch (\Throwable $e) {}

        Database::pdo()->prepare('DELETE FROM files WHERE id = ? AND user_id = ?')->execute([(int)$f['id'], $uid]);
        self::adjustStorage($uid, -(int)$f['size']);
        Storage::deleteRel($f['storage_path']);
        @unlink(Storage::root() . '/thumbs/' . (int)$f['id'] . '.jpg');
    }

    /**
     * Apply a (signed) delta to the user's storage_used, floored at 0. Computed
     * in PHP because `storage_used` is an UNSIGNED column — doing `used - n` in
     * SQL underflows and throws "BIGINT UNSIGNED out of range" when n > used
     * (e.g. after quota drift), which previously 500'd a delete *after* the row
     * was already gone. Portable across MySQL + SQLite.
     */
    private static function adjustStorage(int $uid, int $delta): void
    {
        $pdo = Database::pdo();
        $row = $pdo->prepare('SELECT storage_used FROM users WHERE id = ?');
        $row->execute([$uid]);
        $cur = (int)($row->fetch()['storage_used'] ?? 0);
        $new = max(0, $cur + $delta);
        $pdo->prepare('UPDATE users SET storage_used = ? WHERE id = ?')->execute([$new, $uid]);
    }

    /**
     * Store a file from a source path into the user's tree, versioning it if a
     * same-named live file already exists in that folder. Moves the source into
     * place. Throws RuntimeException(415|507) for blocked types / quota. Returns
     * the resulting file row. Shared by the WebDAV PUT handler.
     */
    public static function ingestPath(int $uid, ?int $folder, string $name, string $srcAbs, ?string $mime = null): array
    {
        if (Storage::isDangerous($name)) {
            throw new \RuntimeException('Dieser Dateityp ist nicht erlaubt', 415);
        }
        $size = (int) filesize($srcAbs);
        $mime = $mime ?: (mime_content_type($srcAbs) ?: 'application/octet-stream');
        $existing = self::existingInFolder($uid, $folder, $name);
        $quotaNeed = $existing ? max(0, $size - (int)$existing['size']) : $size;
        if (!self::quotaOk($uid, $quotaNeed)) {
            throw new \RuntimeException('Storage quota exceeded', 507);
        }
        $rel = Storage::relPath($uid, $name);
        if (!@rename($srcAbs, Storage::abs($rel))) {
            if (!@copy($srcAbs, Storage::abs($rel))) throw new \RuntimeException('Write failed', 500);
            @unlink($srcAbs);
        }
        $id = $existing
            ? self::replaceWithVersion($uid, $existing, $rel, $mime, $size)
            : self::insertFile($uid, $folder, $name, $rel, $mime, $size, null, null);
        return self::fetchOne($uid, $id) ?? [];
    }

    /** A free filename in the folder by appending " (n)" before the extension. */
    private static function uniqueName(int $uid, ?int $folder, string $name): string
    {
        if (!self::existingInFolder($uid, $folder, $name)) return $name;
        $dot = strrpos($name, '.');
        $base = $dot !== false && $dot > 0 ? substr($name, 0, $dot) : $name;
        $ext = $dot !== false && $dot > 0 ? substr($name, $dot) : '';
        for ($n = 2; $n < 1000; $n++) {
            $cand = $base . ' (' . $n . ')' . $ext;
            if (!self::existingInFolder($uid, $folder, $cand)) return $cand;
        }
        return $base . ' (' . time() . ')' . $ext;
    }

    /** A live (non-trashed) file with this exact name in the given folder, or null. */
    private static function existingInFolder(int $uid, ?int $folder, string $name): ?array
    {
        $pdo = Database::pdo();
        if ($folder === null) {
            $stmt = $pdo->prepare('SELECT * FROM files WHERE user_id = ? AND folder_id IS NULL AND name = ? AND deleted_at IS NULL LIMIT 1');
            $stmt->execute([$uid, $name]);
        } else {
            $stmt = $pdo->prepare('SELECT * FROM files WHERE user_id = ? AND folder_id = ? AND name = ? AND deleted_at IS NULL LIMIT 1');
            $stmt->execute([$uid, $folder, $name]);
        }
        $r = $stmt->fetch();
        return $r ?: null;
    }

    /**
     * Point an existing file row at a freshly stored blob, archiving the previous
     * content into the version history first. Adjusts quota by the size delta and
     * removes the old blob + stale thumbnail. Returns the (unchanged) file id.
     */
    private static function replaceWithVersion(int $uid, array $existing, string $newRel, string $mime, int $newSize): int
    {
        self::snapshot($uid, $existing);
        $oldRel = (string)$existing['storage_path'];
        $delta = $newSize - (int)$existing['size'];
        $pdo = Database::pdo();
        $kind = Storage::kindFromMime($mime);
        $pdo->prepare('UPDATE files SET storage_path = ?, mime_type = ?, size = ?, kind = ? WHERE id = ? AND user_id = ?')
            ->execute([$newRel, $mime, $newSize, $kind, (int)$existing['id'], $uid]);
        self::adjustStorage($uid, $delta);
        if ($oldRel !== '' && $oldRel !== $newRel) Storage::deleteRel($oldRel);
        @unlink(Storage::root() . '/thumbs/' . (int)$existing['id'] . '.jpg');
        $pdo->prepare("INSERT INTO activity (user_id, kind, payload) VALUES (?, 'file_versioned', ?)")
            ->execute([$uid, json_encode(['file_id' => (int)$existing['id'], 'name' => $existing['name'], 'size' => $newSize])]);
        return (int)$existing['id'];
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

    /**
     * Fetch a file the user is allowed to READ: their own, OR one shared with
     * them internally (directly, or via a shared containing folder/ancestor).
     * Returns the real file row (owner's) once access is confirmed. Used only by
     * read endpoints (show/raw/thumb/versions/download) — never for mutations.
     */
    private static function fetchReadable(int $uid, int $id): ?array
    {
        $own = self::fetchOne($uid, $id);
        if ($own) return $own;
        if (!InternalShareRoutes::accessibleFile($uid, $id)) return null;
        $stmt = Database::pdo()->prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL');
        $stmt->execute([$id]);
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

        $size = (int) filesize($abs);
        $disp = ($download ? 'attachment' : 'inline') . '; filename="' . addslashes($file['name']) . '"';

        // Stream natively with HTTP Range support so video/audio can be scrubbed
        // and Safari (which requires 206 responses) plays inline — both for the
        // owner and on shared links. Bypasses PSR-7 for true ranged delivery.
        while (ob_get_level() > 0) { @ob_end_clean(); }
        $start = 0; $end = $size - 1; $partial = false;
        $range = $_SERVER['HTTP_RANGE'] ?? '';
        if ($range !== '' && preg_match('/bytes=(\d*)-(\d*)/', $range, $m)) {
            if ($m[1] !== '') { $start = (int)$m[1]; }
            if ($m[2] !== '') { $end = (int)$m[2]; }
            if ($m[1] === '' && $m[2] !== '') { $start = max(0, $size - (int)$m[2]); $end = $size - 1; }
            if ($start > $end || $start >= $size) {
                header('Content-Range: bytes */' . $size);
                http_response_code(416);
                exit;
            }
            $end = min($end, $size - 1);
            $partial = true;
        }
        $length = $end - $start + 1;

        if (function_exists('set_time_limit')) { @set_time_limit(0); }
        header('Content-Type: ' . $mime);
        header('Content-Disposition: ' . $disp);
        header('Accept-Ranges: bytes');
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: private, max-age=600');
        if ($partial) {
            http_response_code(206);
            header('Content-Range: bytes ' . $start . '-' . $end . '/' . $size);
        }
        header('Content-Length: ' . $length);

        $fp = fopen($abs, 'rb');
        if ($fp === false) { http_response_code(500); exit; }
        if ($start > 0) fseek($fp, $start);
        $remaining = $length;
        while ($remaining > 0 && !feof($fp)) {
            $buf = fread($fp, (int) min(131072, $remaining));
            if ($buf === false || $buf === '') break;
            echo $buf;
            $remaining -= strlen($buf);
            @flush();
        }
        fclose($fp);
        exit;
    }
}
