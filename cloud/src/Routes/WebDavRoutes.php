<?php
declare(strict_types=1);

namespace Nyza\Routes;

use Nyza\Database;
use Nyza\Json;
use Nyza\Storage;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;
use Slim\Psr7\Stream;

/**
 * WebDAV endpoint so the user can mount their Nyza Cloud as a network drive in
 * macOS Finder ("Connect to Server", https://host/cloud/webdav/) or Windows
 * Explorer ("Map network drive").
 *
 * Single-user: authenticated with HTTP Basic (account email + password). The
 * URL path maps onto the folder tree; PUT versions same-named files via the
 * shared FileRoutes::ingestPath() so uploads behave like the web UI.
 *
 * Locking (LOCK/UNLOCK) is accepted but not enforced — Finder/Explorer refuse
 * to write to a class-1 server, so we advertise class 2 and hand back opaque
 * lock tokens. PROPPATCH is acknowledged (clients set Win32 attrs on save).
 */
final class WebDavRoutes
{
    private const METHODS = [
        'OPTIONS', 'GET', 'HEAD', 'PUT', 'DELETE',
        'PROPFIND', 'PROPPATCH', 'MKCOL', 'MOVE', 'COPY', 'LOCK', 'UNLOCK',
    ];

    public static function mount(App $app): void
    {
        $app->map(self::METHODS, '/webdav', [self::class, 'handle']);
        $app->map(self::METHODS, '/webdav/{path:.*}', [self::class, 'handle']);
    }

    public static function handle(Request $req, Response $res, array $args): Response
    {
        $method = strtoupper($req->getMethod());

        // OPTIONS must work unauthenticated so clients can probe capabilities.
        if ($method === 'OPTIONS') return self::options($res);

        $uid = self::auth($req);
        if ($uid === null) {
            return $res
                ->withHeader('WWW-Authenticate', 'Basic realm="Nyza Cloud"')
                ->withStatus(401);
        }

        $path = (string)($args['path'] ?? '');
        try {
            switch ($method) {
                case 'PROPFIND':  return self::propfind($req, $res, $uid, $path);
                case 'GET':
                case 'HEAD':      return self::get($res, $uid, $path, $method === 'HEAD');
                case 'PUT':       return self::put($req, $res, $uid, $path);
                case 'DELETE':    return self::delete($res, $uid, $path);
                case 'MKCOL':     return self::mkcol($res, $uid, $path);
                case 'MOVE':      return self::moveCopy($req, $res, $uid, $path, true);
                case 'COPY':      return self::moveCopy($req, $res, $uid, $path, false);
                case 'PROPPATCH': return self::proppatch($res, $uid, $path);
                case 'LOCK':      return self::lock($res, $path);
                case 'UNLOCK':    return $res->withStatus(204);
            }
        } catch (\RuntimeException $e) {
            $code = $e->getCode();
            return $res->withStatus($code >= 400 && $code < 600 ? $code : 500);
        }
        return $res->withStatus(405);
    }

    // ───── auth ──────────────────────────────────────────────────────────────
    private static function auth(Request $req): ?int
    {
        $h = $req->getHeaderLine('Authorization');
        if ($h === '') {
            // Apache often relocates the header through CGI/FPM.
            $h = (string)($_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
        }
        if (!preg_match('/^Basic\s+(.+)$/i', $h, $m)) return null;
        $decoded = base64_decode($m[1], true);
        if ($decoded === false || !str_contains($decoded, ':')) return null;
        [$email, $pass] = explode(':', $decoded, 2);

        $stmt = Database::pdo()->prepare('SELECT id, password_hash FROM users WHERE email = ?');
        $stmt->execute([trim($email)]);
        $u = $stmt->fetch();
        if (!$u || !password_verify($pass, $u['password_hash'])) return null;
        return (int)$u['id'];
    }

    // ───── path resolution ───────────────────────────────────────────────────
    /** @return string[] decoded, non-empty path segments */
    private static function segments(string $path): array
    {
        $parts = array_filter(explode('/', trim($path, '/')), static fn($s) => $s !== '');
        return array_values(array_map('rawurldecode', $parts));
    }

    private static function findFolder(int $uid, ?int $parent, string $name): ?array
    {
        $pdo = Database::pdo();
        if ($parent === null) {
            $stmt = $pdo->prepare('SELECT * FROM folders WHERE user_id = ? AND parent_id IS NULL AND name = ? LIMIT 1');
            $stmt->execute([$uid, $name]);
        } else {
            $stmt = $pdo->prepare('SELECT * FROM folders WHERE user_id = ? AND parent_id = ? AND name = ? LIMIT 1');
            $stmt->execute([$uid, $parent, $name]);
        }
        return $stmt->fetch() ?: null;
    }

    private static function findFile(int $uid, ?int $folder, string $name): ?array
    {
        $pdo = Database::pdo();
        if ($folder === null) {
            $stmt = $pdo->prepare('SELECT * FROM files WHERE user_id = ? AND folder_id IS NULL AND name = ? AND deleted_at IS NULL LIMIT 1');
            $stmt->execute([$uid, $name]);
        } else {
            $stmt = $pdo->prepare('SELECT * FROM files WHERE user_id = ? AND folder_id = ? AND name = ? AND deleted_at IS NULL LIMIT 1');
            $stmt->execute([$uid, $folder, $name]);
        }
        return $stmt->fetch() ?: null;
    }

    /**
     * Resolve a path to a resource.
     * @return array{type:string,row?:array,parentId?:?int,name?:string}
     *   type: 'root' | 'folder' | 'file' | 'missing' | 'badpath'
     */
    private static function resolve(int $uid, string $path): array
    {
        $segs = self::segments($path);
        if (!$segs) return ['type' => 'root', 'parentId' => null];

        $parent = null;
        for ($i = 0; $i < count($segs) - 1; $i++) {
            $f = self::findFolder($uid, $parent, $segs[$i]);
            if (!$f) return ['type' => 'badpath'];
            $parent = (int)$f['id'];
        }
        $last = $segs[count($segs) - 1];
        if ($folder = self::findFolder($uid, $parent, $last)) {
            return ['type' => 'folder', 'row' => $folder, 'parentId' => $parent];
        }
        if ($file = self::findFile($uid, $parent, $last)) {
            return ['type' => 'file', 'row' => $file, 'parentId' => $parent];
        }
        return ['type' => 'missing', 'parentId' => $parent, 'name' => $last];
    }

    // ───── href helpers ────────────────────────────────────────────────────
    private static function davRoot(): string
    {
        $script = $_SERVER['SCRIPT_NAME'] ?? '/index.php';
        $base = rtrim(str_replace('\\', '/', dirname($script)), '/');
        return ($base === '' ? '' : $base) . '/webdav';
    }

    private static function href(string $relPath, bool $collection): string
    {
        $segs = array_map('rawurlencode', array_filter(explode('/', trim($relPath, '/')), static fn($s) => $s !== ''));
        $h = self::davRoot() . (count($segs) ? '/' . implode('/', $segs) : '/');
        if ($collection && substr($h, -1) !== '/') $h .= '/';
        return $h;
    }

    // ───── OPTIONS ───────────────────────────────────────────────────────────
    private static function options(Response $res): Response
    {
        return $res
            ->withHeader('DAV', '1, 2')
            ->withHeader('MS-Author-Via', 'DAV')
            ->withHeader('Allow', implode(', ', self::METHODS))
            ->withStatus(200);
    }

    // ───── PROPFIND ──────────────────────────────────────────────────────────
    private static function propfind(Request $req, Response $res, int $uid, string $path): Response
    {
        $r = self::resolve($uid, $path);
        if (in_array($r['type'], ['missing', 'badpath'], true)) return $res->withStatus(404);

        $depth = $req->getHeaderLine('Depth');
        if ($depth === '') $depth = '1';
        $base = trim($path, '/');

        $entries = [];
        if ($r['type'] === 'file') {
            $entries[] = self::fileXml($base, $r['row']);
        } else {
            // collection itself
            $entries[] = self::collectionXml($base === '' ? '' : $base, $r['row'] ?? null);
            if ($depth !== '0') {
                $folderId = $r['type'] === 'root' ? null : (int)$r['row']['id'];
                foreach (self::childFolders($uid, $folderId) as $sf) {
                    $entries[] = self::collectionXml(($base === '' ? '' : $base . '/') . $sf['name'], $sf);
                }
                foreach (self::childFiles($uid, $folderId) as $cf) {
                    $entries[] = self::fileXml(($base === '' ? '' : $base . '/') . $cf['name'], $cf);
                }
            }
        }

        $xml = '<?xml version="1.0" encoding="utf-8"?>' . "\n"
             . '<D:multistatus xmlns:D="DAV:">' . implode('', $entries) . '</D:multistatus>';
        $res->getBody()->write($xml);
        return $res->withHeader('Content-Type', 'application/xml; charset=utf-8')->withStatus(207);
    }

    private static function childFolders(int $uid, ?int $parent): array
    {
        $pdo = Database::pdo();
        if ($parent === null) {
            $s = $pdo->prepare('SELECT * FROM folders WHERE user_id = ? AND parent_id IS NULL ORDER BY name');
            $s->execute([$uid]);
        } else {
            $s = $pdo->prepare('SELECT * FROM folders WHERE user_id = ? AND parent_id = ? ORDER BY name');
            $s->execute([$uid, $parent]);
        }
        return $s->fetchAll();
    }

    private static function childFiles(int $uid, ?int $folder): array
    {
        $pdo = Database::pdo();
        if ($folder === null) {
            $s = $pdo->prepare('SELECT * FROM files WHERE user_id = ? AND folder_id IS NULL AND deleted_at IS NULL ORDER BY name');
            $s->execute([$uid]);
        } else {
            $s = $pdo->prepare('SELECT * FROM files WHERE user_id = ? AND folder_id = ? AND deleted_at IS NULL ORDER BY name');
            $s->execute([$uid, $folder]);
        }
        return $s->fetchAll();
    }

    private static function collectionXml(string $relPath, ?array $row): string
    {
        $name = $row['name'] ?? 'Nyza Cloud';
        $mtime = isset($row['updated_at']) ? strtotime((string)$row['updated_at']) : time();
        return '<D:response><D:href>' . htmlspecialchars(self::href($relPath, true), ENT_XML1) . '</D:href>'
            . '<D:propstat><D:prop>'
            . '<D:displayname>' . htmlspecialchars($name, ENT_XML1) . '</D:displayname>'
            . '<D:resourcetype><D:collection/></D:resourcetype>'
            . '<D:getlastmodified>' . gmdate('D, d M Y H:i:s', $mtime ?: time()) . ' GMT</D:getlastmodified>'
            . '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>';
    }

    private static function fileXml(string $relPath, array $row): string
    {
        $mtime = strtotime((string)($row['created_at'] ?? 'now')) ?: time();
        return '<D:response><D:href>' . htmlspecialchars(self::href($relPath, false), ENT_XML1) . '</D:href>'
            . '<D:propstat><D:prop>'
            . '<D:displayname>' . htmlspecialchars((string)$row['name'], ENT_XML1) . '</D:displayname>'
            . '<D:resourcetype/>'
            . '<D:getcontentlength>' . (int)$row['size'] . '</D:getcontentlength>'
            . '<D:getcontenttype>' . htmlspecialchars((string)$row['mime_type'], ENT_XML1) . '</D:getcontenttype>'
            . '<D:getlastmodified>' . gmdate('D, d M Y H:i:s', $mtime) . ' GMT</D:getlastmodified>'
            . '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>';
    }

    // ───── GET / HEAD ──────────────────────────────────────────────────────
    private static function get(Response $res, int $uid, string $path, bool $head): Response
    {
        $r = self::resolve($uid, $path);
        if ($r['type'] !== 'file') return $res->withStatus($r['type'] === 'folder' || $r['type'] === 'root' ? 405 : 404);
        $f = $r['row'];
        $abs = Storage::abs($f['storage_path']);
        if (!is_file($abs)) return $res->withStatus(404);

        $mime = $f['mime_type'] ?: 'application/octet-stream';
        if (Storage::mustDownload($mime)) $mime = 'application/octet-stream';
        $res = $res
            ->withHeader('Content-Type', $mime)
            ->withHeader('Content-Length', (string)$f['size'])
            ->withHeader('X-Content-Type-Options', 'nosniff')
            ->withHeader('Last-Modified', gmdate('D, d M Y H:i:s', strtotime((string)$f['created_at']) ?: time()) . ' GMT');
        if ($head) return $res->withStatus(200);
        return $res->withBody(new Stream(fopen($abs, 'rb')))->withStatus(200);
    }

    // ───── PUT ─────────────────────────────────────────────────────────────
    private static function put(Request $req, Response $res, int $uid, string $path): Response
    {
        $segs = self::segments($path);
        if (!$segs) return $res->withStatus(409);
        $name = array_pop($segs);

        // Resolve (and require) the parent collection.
        $parent = null;
        foreach ($segs as $seg) {
            $f = self::findFolder($uid, $parent, $seg);
            if (!$f) return $res->withStatus(409); // missing intermediate collection
            $parent = (int)$f['id'];
        }

        $existed = self::findFile($uid, $parent, $name) !== null;

        // Stream the request body to a temp file (constant memory).
        $tmp = Storage::temp() . '/dav_' . bin2hex(random_bytes(8));
        $in = $req->getBody();
        $fp = fopen($tmp, 'wb');
        if ($in->isSeekable()) $in->rewind();
        while (!$in->eof()) {
            $chunk = $in->read(1 << 20);
            if ($chunk === '') break;
            fwrite($fp, $chunk);
        }
        fclose($fp);

        try {
            FileRoutes::ingestPath($uid, $parent, $name, $tmp);
        } catch (\RuntimeException $e) {
            @unlink($tmp);
            $code = $e->getCode();
            return $res->withStatus($code >= 400 && $code < 600 ? $code : 500);
        }
        return $res->withStatus($existed ? 204 : 201);
    }

    // ───── MKCOL ───────────────────────────────────────────────────────────
    private static function mkcol(Response $res, int $uid, string $path): Response
    {
        $segs = self::segments($path);
        if (!$segs) return $res->withStatus(405); // root already exists
        $name = array_pop($segs);

        $parent = null;
        foreach ($segs as $seg) {
            $f = self::findFolder($uid, $parent, $seg);
            if (!$f) return $res->withStatus(409);
            $parent = (int)$f['id'];
        }
        if (self::findFolder($uid, $parent, $name) || self::findFile($uid, $parent, $name)) {
            return $res->withStatus(405); // already exists
        }
        Database::pdo()->prepare('INSERT INTO folders (user_id, parent_id, name, kind, tone) VALUES (?, ?, ?, ?, ?)')
            ->execute([$uid, $parent, $name, 'normal', 'violet']);
        return $res->withStatus(201);
    }

    // ───── DELETE ──────────────────────────────────────────────────────────
    private static function delete(Response $res, int $uid, string $path): Response
    {
        $r = self::resolve($uid, $path);
        $pdo = Database::pdo();
        if ($r['type'] === 'file') {
            $pdo->prepare('UPDATE files SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
                ->execute([(int)$r['row']['id'], $uid]);
            return $res->withStatus(204);
        }
        if ($r['type'] === 'folder') {
            self::deleteFolderTree($uid, (int)$r['row']['id']);
            return $res->withStatus(204);
        }
        if ($r['type'] === 'root') return $res->withStatus(403);
        return $res->withStatus(404);
    }

    /**
     * Permanently delete a folder subtree: file rows + their blobs + version
     * blobs, then every folder row. Done explicitly (not via FK cascade) because
     * files.folder_id is ON DELETE SET NULL — a plain cascade would orphan the
     * rows and leak quota.
     */
    private static function deleteFolderTree(int $uid, int $id): void
    {
        $pdo = Database::pdo();
        $all = [$id];
        $frontier = [$id];
        $child = $pdo->prepare('SELECT id FROM folders WHERE parent_id = ? AND user_id = ?');
        $guard = 0;
        while ($frontier && $guard++ < 10000) {
            $next = [];
            foreach ($frontier as $fid) {
                $child->execute([$fid, $uid]);
                foreach ($child->fetchAll() as $row) { $all[] = (int)$row['id']; $next[] = (int)$row['id']; }
            }
            $frontier = $next;
        }
        $place = implode(',', array_fill(0, count($all), '?'));

        // Files in the subtree (incl. trashed — we're removing everything).
        $files = $pdo->prepare("SELECT id, size, storage_path FROM files WHERE user_id = ? AND folder_id IN ($place)");
        $files->execute(array_merge([$uid], $all));
        $rows = $files->fetchAll();
        $freed = 0;
        foreach ($rows as $r) {
            $freed += (int)$r['size'];
            Storage::deleteRel($r['storage_path']);
            @unlink(Storage::root() . '/thumbs/' . (int)$r['id'] . '.jpg');
            $vs = $pdo->prepare('SELECT storage_path FROM file_versions WHERE file_id = ? AND storage_path IS NOT NULL');
            $vs->execute([(int)$r['id']]);
            foreach ($vs->fetchAll() as $v) { Storage::deleteRel($v['storage_path']); }
        }
        if ($rows) {
            $ids = array_map(static fn($r) => (int)$r['id'], $rows);
            $fp = implode(',', array_fill(0, count($ids), '?'));
            $pdo->prepare("DELETE FROM file_versions WHERE file_id IN ($fp)")->execute($ids);
            $pdo->prepare("DELETE FROM files WHERE id IN ($fp)")->execute($ids);
        }
        $pdo->prepare("DELETE FROM folders WHERE user_id = ? AND id IN ($place)")->execute(array_merge([$uid], $all));
        if ($freed > 0) self::adjustStorage($uid, -$freed);
    }

    /** Floor-at-0 storage adjustment (computed in PHP; avoids UNSIGNED underflow). */
    private static function adjustStorage(int $uid, int $delta): void
    {
        $pdo = Database::pdo();
        $row = $pdo->prepare('SELECT storage_used FROM users WHERE id = ?');
        $row->execute([$uid]);
        $cur = (int)($row->fetch()['storage_used'] ?? 0);
        $pdo->prepare('UPDATE users SET storage_used = ? WHERE id = ?')->execute([max(0, $cur + $delta), $uid]);
    }

    // ───── MOVE / COPY ───────────────────────────────────────────────────────
    private static function moveCopy(Request $req, Response $res, int $uid, string $path, bool $move): Response
    {
        $src = self::resolve($uid, $path);
        if (in_array($src['type'], ['missing', 'badpath', 'root'], true)) return $res->withStatus(409);

        $dest = self::destination($req);
        if ($dest === null) return $res->withStatus(400);
        $destSegs = self::segments($dest);
        if (!$destSegs) return $res->withStatus(403); // can't replace root
        $newName = array_pop($destSegs);

        // Resolve destination parent collection.
        $destParent = null;
        foreach ($destSegs as $seg) {
            $f = self::findFolder($uid, $destParent, $seg);
            if (!$f) return $res->withStatus(409);
            $destParent = (int)$f['id'];
        }

        $overwrite = strtolower($req->getHeaderLine('Overwrite')) !== 'f';
        $existingTarget = self::findFile($uid, $destParent, $newName) ?? self::findFolder($uid, $destParent, $newName);
        if ($existingTarget && !$overwrite) return $res->withStatus(412);

        $pdo = Database::pdo();
        if ($src['type'] === 'file') {
            $f = $src['row'];
            if ($move) {
                // Atomic-save pattern: overwriting an existing file in the target
                // versions it. ingestPath moves the source blob into the target
                // (archiving the old content); then drop the now-empty source row
                // and reclaim its quota (its blob was consumed by the move).
                if ($overwrite && ($t = self::findFile($uid, $destParent, $newName)) && (int)$t['id'] !== (int)$f['id']) {
                    $abs = Storage::abs($f['storage_path']);
                    FileRoutes::ingestPath($uid, $destParent, $newName, $abs, $f['mime_type']);
                    $pdo->prepare('DELETE FROM files WHERE id = ? AND user_id = ?')->execute([(int)$f['id'], $uid]);
                    self::adjustStorage($uid, -(int)$f['size']);
                    return $res->withStatus(204);
                }
                $pdo->prepare('UPDATE files SET folder_id = ?, name = ? WHERE id = ? AND user_id = ?')
                    ->execute([$destParent, $newName, (int)$f['id'], $uid]);
                return $res->withStatus($existingTarget ? 204 : 201);
            }
            // COPY a file: duplicate the blob via a temp copy so the source stays.
            $abs = Storage::abs($f['storage_path']);
            if (!is_file($abs)) return $res->withStatus(404);
            $tmp = Storage::temp() . '/davcp_' . bin2hex(random_bytes(8));
            if (!@copy($abs, $tmp)) return $res->withStatus(500);
            FileRoutes::ingestPath($uid, $destParent, $newName, $tmp, $f['mime_type']);
            return $res->withStatus($existingTarget ? 204 : 201);
        }

        // Folder MOVE = rename / re-parent. COPY of a collection: not supported.
        if (!$move) return $res->withStatus(502);
        $folderId = (int)$src['row']['id'];
        if ($destParent === $folderId) return $res->withStatus(409);
        // prevent moving into own descendant
        if ($destParent !== null && in_array($destParent, self::descendants($uid, $folderId), true)) {
            return $res->withStatus(409);
        }
        $pdo->prepare('UPDATE folders SET parent_id = ?, name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
            ->execute([$destParent, $newName, $folderId, $uid]);
        return $res->withStatus($existingTarget ? 204 : 201);
    }

    private static function descendants(int $uid, int $id): array
    {
        $pdo = Database::pdo();
        $child = $pdo->prepare('SELECT id FROM folders WHERE parent_id = ? AND user_id = ?');
        $out = []; $frontier = [$id]; $guard = 0;
        while ($frontier && $guard++ < 10000) {
            $next = [];
            foreach ($frontier as $fid) {
                $child->execute([$fid, $uid]);
                foreach ($child->fetchAll() as $r) { $out[] = (int)$r['id']; $next[] = (int)$r['id']; }
            }
            $frontier = $next;
        }
        return $out;
    }

    /** Extract the path portion of the Destination header, stripped of dav root. */
    private static function destination(Request $req): ?string
    {
        $dest = $req->getHeaderLine('Destination');
        if ($dest === '') return null;
        // May be a full URL or an absolute path.
        $p = parse_url($dest, PHP_URL_PATH);
        if ($p === false || $p === null) $p = $dest;
        $root = self::davRoot();
        if (str_starts_with($p, $root)) $p = substr($p, strlen($root));
        return $p;
    }

    // ───── PROPPATCH (acknowledge) ───────────────────────────────────────────
    private static function proppatch(Response $res, int $uid, string $path): Response
    {
        $r = self::resolve($uid, $path);
        if (in_array($r['type'], ['missing', 'badpath'], true)) return $res->withStatus(404);
        $href = self::href(trim($path, '/'), $r['type'] !== 'file');
        $xml = '<?xml version="1.0" encoding="utf-8"?>'
             . '<D:multistatus xmlns:D="DAV:"><D:response><D:href>' . htmlspecialchars($href, ENT_XML1) . '</D:href>'
             . '<D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>';
        $res->getBody()->write($xml);
        return $res->withHeader('Content-Type', 'application/xml; charset=utf-8')->withStatus(207);
    }

    // ───── LOCK (fake exclusive write lock) ──────────────────────────────────
    private static function lock(Response $res, string $path): Response
    {
        $token = 'opaquelocktoken:' . self::uuid();
        $href = self::href(trim($path, '/'), false);
        $xml = '<?xml version="1.0" encoding="utf-8"?>'
             . '<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>'
             . '<D:locktype><D:write/></D:locktype>'
             . '<D:lockscope><D:exclusive/></D:lockscope>'
             . '<D:depth>infinity</D:depth>'
             . '<D:timeout>Second-3600</D:timeout>'
             . '<D:locktoken><D:href>' . $token . '</D:href></D:locktoken>'
             . '<D:lockroot><D:href>' . htmlspecialchars($href, ENT_XML1) . '</D:href></D:lockroot>'
             . '</D:activelock></D:lockdiscovery></D:prop>';
        $res->getBody()->write($xml);
        return $res
            ->withHeader('Content-Type', 'application/xml; charset=utf-8')
            ->withHeader('Lock-Token', '<' . $token . '>')
            ->withStatus(200);
    }

    private static function uuid(): string
    {
        $b = random_bytes(16);
        $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
        $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
    }
}
