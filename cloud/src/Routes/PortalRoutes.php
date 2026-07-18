<?php
declare(strict_types=1);

namespace Nyza\Routes;

use Nyza\Auth;
use Nyza\CompanyContext;
use Nyza\Database;
use Nyza\Json;
use Nyza\Storage;
use Nyza\Middleware\AuthMiddleware;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;
use Slim\Psr7\Stream;
use Slim\Routing\RouteCollectorProxy;

/**
 * Customer portals. The owner bundles folders/files under a named, password-
 * gated portal; the customer opens /portal/<token>, enters the password and
 * sees + downloads everything. Files are flattened from the attached folders.
 */
final class PortalRoutes
{
    public static function mount(App $app): void
    {
        $app->group('/api/portals', function (RouteCollectorProxy $g) {
            $g->get('',              [self::class, 'list']);
            $g->post('',             [self::class, 'create']);
            $g->get('/{id}',         [self::class, 'show']);
            $g->patch('/{id}',       [self::class, 'update']);
            $g->delete('/{id}',      [self::class, 'delete']);
            $g->post('/{id}/items',  [self::class, 'addItem']);
            $g->delete('/{id}/items/{itemId}', [self::class, 'removeItem']);
        })->add(new AuthMiddleware());

        // Public (customer side).
        $app->post('/api/portal/{token}/unlock',     [self::class, 'unlock']);
        $app->get('/api/portal/{token}',             [self::class, 'publicShow']);
        $app->get('/api/portal/{token}/file/{id}',   [self::class, 'publicFile']);
        $app->get('/api/portal/{token}/file/{id}/thumb', [self::class, 'publicThumb']);
        $app->get('/api/portal/{token}/zip',         [self::class, 'publicZip']);
        $app->get('/api/portal/{token}/doc/{docId}', [self::class, 'publicDoc']);

        // Public (customer side) — upload into owner-chosen folders. Gated by
        // its own upload_password_hash, separate from the portal's view
        // password. Upload-only: no delete/browse capability is exposed here.
        $app->post('/api/portal/{token}/upload-unlock',        [self::class, 'uploadUnlock']);
        $app->post('/api/portal/{token}/upload',                [self::class, 'upload']);
        $app->post('/api/portal/{token}/upload/chunk/init',     [self::class, 'chunkInit']);
        $app->post('/api/portal/{token}/upload/chunk/{sid}',    [self::class, 'chunkAppend']);
        $app->post('/api/portal/{token}/upload/chunk/{sid}/finalize', [self::class, 'chunkFinalize']);

        // Read-only browsing of an allowed upload folder's existing contents
        // (so the customer sees what's already there, not just an upload box).
        $app->get('/api/portal/{token}/upload-folder/{fid}',                 [self::class, 'uploadFolderShow']);
        $app->get('/api/portal/{token}/upload-folder/{fid}/file/{id}',       [self::class, 'uploadFolderFile']);
        $app->get('/api/portal/{token}/upload-folder/{fid}/file/{id}/thumb', [self::class, 'uploadFolderThumb']);
    }

    // ───── owner ────────────────────────────────────────────────────────────
    public static function list(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $s = Database::pdo()->prepare(
            'SELECT p.*, c.name AS contact_name, (SELECT COUNT(*) FROM portal_items i WHERE i.portal_id = p.id) AS items '
            . 'FROM portals p LEFT JOIN contacts c ON c.id = p.contact_id WHERE p.user_id = ? ORDER BY p.created_at DESC'
        );
        $s->execute([$uid]);
        return Json::ok($res, ['portals' => array_map([self::class, 'shape'], $s->fetchAll())]);
    }

    public static function create(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $b = (array)$req->getParsedBody();
        $name = trim((string)($b['name'] ?? '')) ?: 'Kundenportal';
        $token = Auth::randomToken(24);
        $hash = !empty($b['password']) ? password_hash((string)$b['password'], PASSWORD_BCRYPT) : null;
        $uploadHash = !empty($b['upload_password']) ? password_hash((string)$b['upload_password'], PASSWORD_BCRYPT) : null;
        Database::pdo()->prepare('INSERT INTO portals (user_id, company_id, name, contact_id, intro, token, password_hash, upload_password_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            ->execute([$uid, $cid, mb_substr($name, 0, 160), self::cid($b['contact_id'] ?? null), self::str($b['intro'] ?? null, 4000), $token, $hash, $uploadHash]);
        $id = (int)Database::pdo()->lastInsertId();
        self::setUploadFolders($uid, $id, $b['upload_folder_ids'] ?? null);
        return Json::ok($res, ['portal' => self::detail($uid, $id)], 201);
    }

    public static function show(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $d = self::detail($uid, (int)$args['id']);
        if (!$d) return Json::err($res, 'Not found', 404);
        return Json::ok($res, ['portal' => $d]);
    }

    public static function update(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::owned($uid, $id)) return Json::err($res, 'Not found', 404);
        $b = (array)$req->getParsedBody();
        $sets = []; $vals = [];
        if (array_key_exists('name', $b)) { $sets[] = 'name = ?'; $vals[] = mb_substr(trim((string)$b['name']) ?: 'Kundenportal', 0, 160); }
        if (array_key_exists('intro', $b)) { $sets[] = 'intro = ?'; $vals[] = self::str($b['intro'], 4000); }
        if (array_key_exists('contact_id', $b)) { $sets[] = 'contact_id = ?'; $vals[] = self::cid($b['contact_id']); }
        if (!empty($b['clear_password'])) { $sets[] = 'password_hash = ?'; $vals[] = null; }
        elseif (array_key_exists('password', $b) && (string)$b['password'] !== '') { $sets[] = 'password_hash = ?'; $vals[] = password_hash((string)$b['password'], PASSWORD_BCRYPT); }
        if (!empty($b['clear_upload_password'])) { $sets[] = 'upload_password_hash = ?'; $vals[] = null; }
        elseif (array_key_exists('upload_password', $b) && (string)$b['upload_password'] !== '') { $sets[] = 'upload_password_hash = ?'; $vals[] = password_hash((string)$b['upload_password'], PASSWORD_BCRYPT); }
        if ($sets) { $vals[] = $id; $vals[] = $uid; Database::pdo()->prepare('UPDATE portals SET ' . implode(', ', $sets) . ' WHERE id = ? AND user_id = ?')->execute($vals); }
        if (array_key_exists('upload_folder_ids', $b)) self::setUploadFolders($uid, $id, $b['upload_folder_ids']);
        return Json::ok($res, ['portal' => self::detail($uid, $id)]);
    }

    /** Full replace of a portal's allowed-upload folders (owner-verified each time). */
    private static function setUploadFolders(int $uid, int $portalId, $ids): void
    {
        if (!is_array($ids)) return;
        $pdo = Database::pdo();
        $pdo->prepare('DELETE FROM portal_upload_folders WHERE portal_id = ?')->execute([$portalId]);
        $ins = $pdo->prepare('INSERT IGNORE INTO portal_upload_folders (portal_id, folder_id) VALUES (?, ?)');
        $check = $pdo->prepare('SELECT 1 FROM folders WHERE id = ? AND user_id = ?');
        foreach ($ids as $fid) {
            $fid = (int)$fid;
            if ($fid <= 0) continue;
            $check->execute([$fid, $uid]);
            if ($check->fetch()) $ins->execute([$portalId, $fid]);
        }
    }

    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        Database::pdo()->prepare('DELETE FROM portals WHERE id = ? AND user_id = ?')->execute([(int)$args['id'], $uid]);
        return Json::ok($res, ['ok' => true]);
    }

    public static function addItem(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::owned($uid, $id)) return Json::err($res, 'Not found', 404);
        $b = (array)$req->getParsedBody();
        $folderId = !empty($b['folder_id']) ? (int)$b['folder_id'] : null;
        $fileId = !empty($b['file_id']) ? (int)$b['file_id'] : null;
        $sigId = !empty($b['signature_id']) ? (int)$b['signature_id'] : null;
        $upId = !empty($b['upload_link_id']) ? (int)$b['upload_link_id'] : null;
        if (!$folderId && !$fileId && !$sigId && !$upId) return Json::err($res, 'Kein Element', 422);
        // verify ownership of the referenced item
        if ($folderId) { $c = Database::pdo()->prepare('SELECT 1 FROM folders WHERE id = ? AND user_id = ?'); $c->execute([$folderId, $uid]); if (!$c->fetch()) return Json::err($res, 'Ordner nicht gefunden', 404); }
        if ($fileId) { $c = Database::pdo()->prepare('SELECT 1 FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL'); $c->execute([$fileId, $uid]); if (!$c->fetch()) return Json::err($res, 'Datei nicht gefunden', 404); }
        if ($sigId) { $c = Database::pdo()->prepare('SELECT 1 FROM signature_requests WHERE id = ? AND user_id = ?'); $c->execute([$sigId, $uid]); if (!$c->fetch()) return Json::err($res, 'Signatur nicht gefunden', 404); }
        if ($upId) { $c = Database::pdo()->prepare('SELECT 1 FROM upload_links WHERE id = ? AND user_id = ?'); $c->execute([$upId, $uid]); if (!$c->fetch()) return Json::err($res, 'Upload-Link nicht gefunden', 404); }
        Database::pdo()->prepare('INSERT INTO portal_items (portal_id, folder_id, file_id, signature_id, upload_link_id) VALUES (?, ?, ?, ?, ?)')->execute([$id, $folderId, $fileId, $sigId, $upId]);
        return Json::ok($res, ['portal' => self::detail($uid, $id)], 201);
    }

    public static function removeItem(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::owned($uid, $id)) return Json::err($res, 'Not found', 404);
        Database::pdo()->prepare('DELETE FROM portal_items WHERE id = ? AND portal_id = ?')->execute([(int)$args['itemId'], $id]);
        return Json::ok($res, ['portal' => self::detail($uid, $id)]);
    }

    // ───── public (customer) ──────────────────────────────────────────────────
    public static function unlock(Request $req, Response $res, array $args): Response
    {
        $p = self::byToken((string)$args['token']);
        if (!$p) return Json::err($res, 'Not found', 404);
        $pw = (string)(((array)$req->getParsedBody())['password'] ?? '');
        if ($p['password_hash'] && !password_verify($pw, (string)$p['password_hash'])) return Json::err($res, 'Falsches Passwort', 403, 'bad_password');
        return Json::ok($res, ['ok' => true]);
    }

    public static function publicShow(Request $req, Response $res, array $args): Response
    {
        $p = self::byToken((string)$args['token']);
        if (!$p) return Json::err($res, 'Not found', 404);
        if ($p['password_hash'] && !self::pwOk($p, $req)) {
            return Json::ok($res, ['requires_password' => true, 'name' => $p['name']], 401);
        }
        $owner = Database::pdo()->prepare('SELECT id, name, logo_path FROM users WHERE id = ?');
        $owner->execute([(int)$p['user_id']]);
        $o = $owner->fetch();
        $files = self::collectFiles((int)$p['id']);
        return Json::ok($res, [
            'name' => $p['name'],
            'intro' => $p['intro'],
            'owner' => $o ? ['id' => (int)$o['id'], 'name' => $o['name'], 'has_logo' => !empty($o['logo_path'])] : null,
            'files' => array_map(static fn($f) => [
                'id' => (int)$f['id'], 'name' => $f['name'], 'kind' => $f['kind'], 'size' => (int)$f['size'],
                'mime_type' => $f['mime_type'], 'hue' => (int)$f['hue'], 'taken_at' => $f['taken_at'] ?? null, 'created_at' => $f['created_at'] ?? null,
            ], $files),
            'documents' => self::collectDocuments($p),
            'signatures' => self::collectLinks((int)$p['id'], 'signature'),
            'uploads' => self::collectLinks((int)$p['id'], 'upload'),
            // Embedded upload capability (separate from the legacy attached
            // Upload-Links above) — folder names are only revealed once
            // upload-unlock succeeds, not here.
            'upload_enabled' => !empty(self::uploadFolderIds((int)$p['id'])),
            'requires_upload_password' => !empty($p['upload_password_hash']),
        ]);
    }

    public static function publicFile(Request $req, Response $res, array $args): Response
    {
        return self::stream($req, $res, $args, false);
    }

    public static function publicThumb(Request $req, Response $res, array $args): Response
    {
        $p = self::byToken((string)$args['token']);
        if (!$p || ($p['password_hash'] && !self::pwOk($p, $req))) return Json::err($res, 'Not found', 404);
        $fileId = (int)$args['id'];
        if (!isset(self::allowedIds((int)$p['id'])[$fileId])) return Json::err($res, 'Forbidden', 403);
        $f = Database::pdo()->prepare('SELECT * FROM files WHERE id = ?'); $f->execute([$fileId]); $row = $f->fetch();
        if (!$row) return Json::err($res, 'Not found', 404);
        return FileRoutes::serveThumb($res, $row);
    }

    public static function publicZip(Request $req, Response $res, array $args): Response
    {
        $p = self::byToken((string)$args['token']);
        if (!$p) return Json::err($res, 'Not found', 404);
        if ($p['password_hash'] && !self::pwOk($p, $req)) return Json::err($res, 'Passwort erforderlich', 401);
        $files = self::collectFiles((int)$p['id']);
        if (!$files) return Json::err($res, 'Keine Dateien', 404);
        $members = [];
        $idsParam = (string)($req->getQueryParams()['ids'] ?? '');
        $want = $idsParam !== '' ? array_flip(array_map('intval', explode(',', $idsParam))) : null;
        foreach ($files as $f) {
            if ($want !== null && !isset($want[(int)$f['id']])) continue;
            $members[] = ['path' => Storage::abs($f['storage_path']), 'name' => $f['name']];
        }
        if (!$members) return Json::err($res, 'Keine Dateien', 404);
        \Nyza\ZipStreamer::emit($members, 'portal-' . substr($p['token'], 0, 8) . '.zip');
        return $res;
    }

    /** Invoices/offers of the linked contact (auto-included in the portal). */
    private static function collectDocuments(array $p): array
    {
        if (empty($p['contact_id'])) return [];
        $s = Database::pdo()->prepare(
            "SELECT id, type, number, doc_date, gross, paid_at, signed_at FROM documents WHERE company_id = ? AND contact_id = ? ORDER BY doc_date DESC, id DESC LIMIT 200"
        );
        $s->execute([(int)$p['company_id'], (int)$p['contact_id']]);
        return array_map(static fn($d) => [
            'id' => (int)$d['id'], 'type' => $d['type'], 'number' => $d['number'],
            'doc_date' => $d['doc_date'], 'gross' => (float)$d['gross'],
            'paid' => !empty($d['paid_at']), 'signed' => !empty($d['signed_at']),
        ], $s->fetchAll());
    }

    /** Attached signature requests / upload links for the public portal page. */
    private static function collectLinks(int $portalId, string $type): array
    {
        $pdo = Database::pdo();
        if ($type === 'signature') {
            $s = $pdo->prepare('SELECT sr.token, sr.title, sr.status FROM portal_items i JOIN signature_requests sr ON sr.id = i.signature_id WHERE i.portal_id = ?');
            $s->execute([$portalId]);
            return array_map(static fn($r) => ['token' => $r['token'], 'title' => $r['title'], 'status' => $r['status']], $s->fetchAll());
        }
        $s = $pdo->prepare('SELECT ul.token, ul.title FROM portal_items i JOIN upload_links ul ON ul.id = i.upload_link_id WHERE i.portal_id = ?');
        $s->execute([$portalId]);
        return array_map(static fn($r) => ['token' => $r['token'], 'title' => $r['title']], $s->fetchAll());
    }

    public static function publicDoc(Request $req, Response $res, array $args): Response
    {
        $p = self::byToken((string)$args['token']);
        if (!$p) return Json::err($res, 'Not found', 404);
        if ($p['password_hash'] && !self::pwOk($p, $req)) return Json::err($res, 'Passwort erforderlich', 401);
        if (empty($p['contact_id'])) return Json::err($res, 'Forbidden', 403);
        $cid = (int)$p['company_id'];
        $doc = DocumentRoutes::docForSignature($cid, (int)$args['docId']);
        if (!$doc || (int)($doc['contact_id'] ?? 0) !== (int)$p['contact_id']) return Json::err($res, 'Forbidden', 403);
        $bytes = DocumentRoutes::pdfBytesFor((int)$p['user_id'], $cid, $doc);
        $res->getBody()->write($bytes);
        return $res->withHeader('Content-Type', 'application/pdf')
            ->withHeader('Content-Disposition', (empty($req->getQueryParams()['download']) ? 'inline' : 'attachment') . '; filename="' . addslashes((string)$doc['number']) . '.pdf"')
            ->withStatus(200);
    }

    // ───── public (customer) — embedded upload ────────────────────────────────
    /** View-password + upload-password + folder-whitelist check for every upload call. */
    private static function uploadGate(array $p, Request $req, ?int $folderId): ?array
    {
        if ($p['password_hash'] && !self::pwOk($p, $req)) return ['error' => 'password_required', 'status' => 401];
        if (!empty($p['upload_password_hash']) && !self::uploadPwOk($p, $req)) return ['error' => 'upload_password_required', 'status' => 401];
        if ($folderId === null || !isset(self::uploadFolderIds((int)$p['id'])[$folderId])) {
            return ['error' => 'folder_not_allowed', 'status' => 403];
        }
        return null;
    }

    private static function uploadPwOk(array $p, Request $req): bool
    {
        $pw = $req->getQueryParams()['up'] ?? (((array)$req->getParsedBody())['upload_password'] ?? null);
        return $pw !== null && password_verify((string)$pw, (string)$p['upload_password_hash']);
    }

    private static function uploadFolderIds(int $portalId): array
    {
        $ids = [];
        $s = Database::pdo()->prepare('SELECT folder_id FROM portal_upload_folders WHERE portal_id = ?');
        $s->execute([$portalId]);
        foreach ($s->fetchAll() as $r) $ids[(int)$r['folder_id']] = true;
        return $ids;
    }

    public static function uploadUnlock(Request $req, Response $res, array $args): Response
    {
        if (!\Nyza\RateLimiter::allowReq($req, 'portal_upload_unlock', 10, 300, $args['token'])) {
            return Json::err($res, 'Zu viele Versuche — bitte später erneut', 429, 'rate_limited');
        }
        $p = self::byToken((string)$args['token']);
        if (!$p) return Json::err($res, 'Not found', 404);
        if ($p['password_hash'] && !self::pwOk($p, $req)) return Json::err($res, 'Passwort erforderlich', 401);
        if (!empty($p['upload_password_hash'])) {
            $pw = (string)(((array)$req->getParsedBody())['upload_password'] ?? '');
            if ($pw === '' || !password_verify($pw, (string)$p['upload_password_hash'])) {
                return Json::err($res, 'Falsches Passwort', 403, 'bad_password');
            }
        }
        return Json::ok($res, ['ok' => true, 'folders' => self::uploadFoldersDetailed((int)$p['id'])]);
    }

    /** Allowed upload folders with the same at-a-glance metadata the owner
     *  sees in their own folder tiles (tone, item count, size). */
    private static function uploadFoldersDetailed(int $portalId): array
    {
        $s = Database::pdo()->prepare(
            'SELECT f.id, f.name, f.tone, f.kind, '
            . '(SELECT COUNT(*) FROM files WHERE folder_id = f.id AND deleted_at IS NULL) AS item_count, '
            . '(SELECT COALESCE(SUM(size),0) FROM files WHERE folder_id = f.id AND deleted_at IS NULL) AS total_size '
            . 'FROM portal_upload_folders u JOIN folders f ON f.id = u.folder_id WHERE u.portal_id = ? ORDER BY f.name'
        );
        $s->execute([$portalId]);
        return array_map(static fn($r) => [
            'id' => (int)$r['id'], 'name' => $r['name'], 'tone' => $r['tone'], 'kind' => $r['kind'],
            'item_count' => (int)$r['item_count'], 'total_size' => (int)$r['total_size'],
        ], $s->fetchAll());
    }

    public static function uploadFolderShow(Request $req, Response $res, array $args): Response
    {
        $p = self::byToken((string)$args['token']);
        if (!$p) return Json::err($res, 'Not found', 404);
        $folderId = (int)$args['fid'];
        $err = self::uploadGate($p, $req, $folderId);
        if ($err) return Json::err($res, $err['error'], $err['status']);
        $s = Database::pdo()->prepare('SELECT * FROM files WHERE folder_id = ? AND deleted_at IS NULL ORDER BY pinned DESC, created_at DESC');
        $s->execute([$folderId]);
        return Json::ok($res, ['files' => array_map(static fn($f) => [
            'id' => (int)$f['id'], 'name' => $f['name'], 'kind' => $f['kind'], 'size' => (int)$f['size'],
            'hue' => (int)$f['hue'], 'created_at' => $f['created_at'] ?? null,
        ], $s->fetchAll())]);
    }

    public static function uploadFolderFile(Request $req, Response $res, array $args): Response
    {
        return self::streamUploadFolderFile($req, $res, $args);
    }

    public static function uploadFolderThumb(Request $req, Response $res, array $args): Response
    {
        $p = self::byToken((string)$args['token']);
        if (!$p) return Json::err($res, 'Not found', 404);
        $folderId = (int)$args['fid'];
        $err = self::uploadGate($p, $req, $folderId);
        if ($err) return Json::err($res, $err['error'], $err['status']);
        $f = Database::pdo()->prepare('SELECT * FROM files WHERE id = ? AND folder_id = ? AND deleted_at IS NULL');
        $f->execute([(int)$args['id'], $folderId]);
        $row = $f->fetch();
        if (!$row) return Json::err($res, 'Not found', 404);
        return FileRoutes::serveThumb($res, $row);
    }

    private static function streamUploadFolderFile(Request $req, Response $res, array $args): Response
    {
        $p = self::byToken((string)$args['token']);
        if (!$p) return Json::err($res, 'Not found', 404);
        $folderId = (int)$args['fid'];
        $err = self::uploadGate($p, $req, $folderId);
        if ($err) return Json::err($res, $err['error'], $err['status']);
        $f = Database::pdo()->prepare('SELECT * FROM files WHERE id = ? AND folder_id = ? AND deleted_at IS NULL');
        $f->execute([(int)$args['id'], $folderId]);
        $row = $f->fetch();
        if (!$row) return Json::err($res, 'Not found', 404);
        $abs = Storage::abs($row['storage_path']);
        if (!is_file($abs)) return Json::err($res, 'Not found', 404);
        $download = !empty($req->getQueryParams()['download']);
        $mime = $row['mime_type'] ?: 'application/octet-stream';
        if (Storage::mustDownload($mime)) $mime = 'application/octet-stream';
        return $res
            ->withHeader('Content-Type', $mime)
            ->withHeader('Content-Disposition', ($download ? 'attachment' : 'inline') . '; filename="' . addslashes((string)$row['name']) . '"')
            ->withHeader('X-Content-Type-Options', 'nosniff')
            ->withBody(new Stream(fopen($abs, 'rb')))
            ->withStatus(200);
    }

    public static function upload(Request $req, Response $res, array $args): Response
    {
        $p = self::byToken((string)$args['token']);
        if (!$p) return Json::err($res, 'Not found', 404);
        $b = (array)$req->getParsedBody();
        $folderId = !empty($b['folder_id']) ? (int)$b['folder_id'] : null;
        $err = self::uploadGate($p, $req, $folderId);
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

        $rel = Storage::relPath((int)$p['user_id'], $name);
        $files->moveTo(Storage::abs($rel));

        return self::recordUploadedFile($p, $folderId, $rel, $name, $mime, $size, $b['uploader_name'] ?? null, $res);
    }

    public static function chunkInit(Request $req, Response $res, array $args): Response
    {
        $p = self::byToken((string)$args['token']);
        if (!$p) return Json::err($res, 'Not found', 404);
        $b = (array)$req->getParsedBody();
        $folderId = !empty($b['folder_id']) ? (int)$b['folder_id'] : null;
        $err = self::uploadGate($p, $req, $folderId);
        if ($err) return Json::err($res, $err['error'], $err['status']);

        $name = (string)($b['file_name'] ?? '');
        $size = (int)($b['total_size'] ?? 0);
        $chunkSize = (int)($b['chunk_size'] ?? (10 * 1024 * 1024));
        if ($name === '' || $size <= 0) return Json::err($res, 'file_name + total_size required', 422);
        if (Storage::isDangerous($name)) return Json::err($res, 'Dieser Dateityp ist nicht erlaubt', 415, 'blocked_type');

        $sid = bin2hex(random_bytes(12));
        $tempPath = Storage::temp() . '/' . $sid . '.part';
        touch($tempPath);
        Database::pdo()->prepare(
            'INSERT INTO upload_sessions (id, portal_id, user_id, folder_id, file_name, total_size, chunk_size, temp_path, uploader_name) '
            . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([$sid, (int)$p['id'], (int)$p['user_id'], $folderId, $name, $size, $chunkSize, $tempPath, $b['uploader_name'] ?? null]);

        return Json::ok($res, ['session_id' => $sid, 'received' => 0, 'chunk_size' => $chunkSize], 201);
    }

    public static function chunkAppend(Request $req, Response $res, array $args): Response
    {
        $p = self::byToken((string)$args['token']);
        if (!$p) return Json::err($res, 'Not found', 404);
        $sid = $args['sid'];
        $stmt = Database::pdo()->prepare('SELECT * FROM upload_sessions WHERE id = ? AND portal_id = ?');
        $stmt->execute([$sid, (int)$p['id']]);
        $s = $stmt->fetch();
        if (!$s) return Json::err($res, 'Session not found', 404);
        if ($s['status'] !== 'open') return Json::err($res, 'Session closed', 409);

        $body = (string) $req->getBody();
        if ($body === '') {
            $files = $req->getUploadedFiles()['chunk'] ?? null;
            if ($files) { if (is_array($files)) $files = $files[0]; $body = (string) $files->getStream(); }
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

    public static function chunkFinalize(Request $req, Response $res, array $args): Response
    {
        $p = self::byToken((string)$args['token']);
        if (!$p) return Json::err($res, 'Not found', 404);
        $sid = $args['sid'];
        $stmt = Database::pdo()->prepare('SELECT * FROM upload_sessions WHERE id = ? AND portal_id = ?');
        $stmt->execute([$sid, (int)$p['id']]);
        $s = $stmt->fetch();
        if (!$s) return Json::err($res, 'Session not found', 404);
        if ($s['status'] !== 'open') return Json::err($res, 'Already finalized', 409);
        if ((int)$s['received'] < (int)$s['total_size']) {
            return Json::err($res, 'Incomplete: received ' . $s['received'] . ' / ' . $s['total_size'], 400);
        }

        $rel = Storage::relPath((int)$s['user_id'], $s['file_name']);
        $abs = Storage::abs($rel);
        if (!@rename($s['temp_path'], $abs)) {
            if (!@copy($s['temp_path'], $abs)) return Json::err($res, 'Move failed', 500);
            @unlink($s['temp_path']);
        }

        $size = (int)$s['total_size'];
        $name = $s['file_name'];
        $mime = mime_content_type($abs) ?: 'application/octet-stream';
        Database::pdo()->prepare("UPDATE upload_sessions SET status = 'finalized' WHERE id = ?")->execute([$sid]);

        return self::recordUploadedFile($p, (int)$s['folder_id'], $rel, $name, $mime, $size, $s['uploader_name'], $res);
    }

    private static function recordUploadedFile(array $p, int $folderId, string $rel, string $name, string $mime, int $size, ?string $uploaderName, Response $res): Response
    {
        $kind = Storage::kindFromMime($mime);
        $hue = (crc32($name) % 360);
        $pdo = Database::pdo();
        $pdo->prepare(
            'INSERT INTO files (user_id, folder_id, name, storage_path, mime_type, size, kind, hue, uploader_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([(int)$p['user_id'], $folderId, $name, $rel, $mime, $size, $kind, $hue, $uploaderName]);
        $id = (int)$pdo->lastInsertId();

        $pdo->prepare('UPDATE users SET storage_used = storage_used + ? WHERE id = ?')->execute([$size, (int)$p['user_id']]);
        $pdo->prepare("INSERT INTO activity (user_id, kind, payload) VALUES (?, 'portal_upload', ?)")
            ->execute([(int)$p['user_id'], json_encode([
                'file_id' => $id, 'name' => $name, 'size' => $size,
                'portal_id' => (int)$p['id'], 'portal_name' => $p['name'], 'uploader_name' => $uploaderName,
            ])]);

        return Json::ok($res, ['file' => ['id' => $id, 'name' => $name, 'size' => $size, 'kind' => $kind, 'mime_type' => $mime]], 201);
    }

    private static function stream(Request $req, Response $res, array $args, bool $thumb): Response
    {
        $p = self::byToken((string)$args['token']);
        if (!$p) return Json::err($res, 'Not found', 404);
        if ($p['password_hash'] && !self::pwOk($p, $req)) return Json::err($res, 'Passwort erforderlich', 401);
        $fileId = (int)$args['id'];
        if (!isset(self::allowedIds((int)$p['id'])[$fileId])) return Json::err($res, 'Forbidden', 403);
        $f = Database::pdo()->prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL');
        $f->execute([$fileId]);
        $row = $f->fetch();
        if (!$row) return Json::err($res, 'Not found', 404);
        $abs = Storage::abs($row['storage_path']);
        if (!is_file($abs)) return Json::err($res, 'Not found', 404);
        $download = !empty($req->getQueryParams()['download']);
        $mime = $row['mime_type'] ?: 'application/octet-stream';
        if (Storage::mustDownload($mime)) $mime = 'application/octet-stream';
        return $res
            ->withHeader('Content-Type', $mime)
            ->withHeader('Content-Disposition', ($download ? 'attachment' : 'inline') . '; filename="' . addslashes((string)$row['name']) . '"')
            ->withHeader('X-Content-Type-Options', 'nosniff')
            ->withBody(new Stream(fopen($abs, 'rb')))
            ->withStatus(200);
    }

    // ───── helpers ─────────────────────────────────────────────────────────────
    /** All file rows belonging to a portal (attached files + files in attached folders). */
    private static function collectFiles(int $portalId): array
    {
        $pdo = Database::pdo();
        $it = $pdo->prepare('SELECT folder_id, file_id FROM portal_items WHERE portal_id = ?');
        $it->execute([$portalId]);
        $folderIds = []; $fileIds = [];
        foreach ($it->fetchAll() as $r) {
            if ($r['folder_id'] !== null) $folderIds[] = (int)$r['folder_id'];
            if ($r['file_id'] !== null) $fileIds[] = (int)$r['file_id'];
        }
        $files = []; $seen = [];
        if ($folderIds) {
            $place = implode(',', array_fill(0, count($folderIds), '?'));
            $s = $pdo->prepare("SELECT * FROM files WHERE folder_id IN ($place) AND deleted_at IS NULL ORDER BY name");
            $s->execute($folderIds);
            foreach ($s->fetchAll() as $f) { if (!isset($seen[(int)$f['id']])) { $seen[(int)$f['id']] = 1; $files[] = $f; } }
        }
        if ($fileIds) {
            $place = implode(',', array_fill(0, count($fileIds), '?'));
            $s = $pdo->prepare("SELECT * FROM files WHERE id IN ($place) AND deleted_at IS NULL");
            $s->execute($fileIds);
            foreach ($s->fetchAll() as $f) { if (!isset($seen[(int)$f['id']])) { $seen[(int)$f['id']] = 1; $files[] = $f; } }
        }
        return $files;
    }

    private static function allowedIds(int $portalId): array
    {
        $ids = [];
        foreach (self::collectFiles($portalId) as $f) $ids[(int)$f['id']] = true;
        return $ids;
    }

    private static function detail(int $uid, int $id): ?array
    {
        $s = Database::pdo()->prepare('SELECT p.*, c.name AS contact_name FROM portals p LEFT JOIN contacts c ON c.id = p.contact_id WHERE p.id = ? AND p.user_id = ?');
        $s->execute([$id, $uid]);
        $p = $s->fetch();
        if (!$p) return null;
        $out = self::shape($p);
        $items = Database::pdo()->prepare(
            'SELECT i.id, i.folder_id, i.file_id, i.signature_id, i.upload_link_id, '
            . 'f.name AS folder_name, fi.name AS file_name, sr.title AS sig_title, ul.title AS up_title '
            . 'FROM portal_items i '
            . 'LEFT JOIN folders f ON f.id = i.folder_id '
            . 'LEFT JOIN files fi ON fi.id = i.file_id '
            . 'LEFT JOIN signature_requests sr ON sr.id = i.signature_id '
            . 'LEFT JOIN upload_links ul ON ul.id = i.upload_link_id '
            . 'WHERE i.portal_id = ?'
        );
        $items->execute([$id]);
        $out['item_list'] = array_map(static function ($r) {
            $kind = $r['folder_id'] !== null ? 'folder' : ($r['file_id'] !== null ? 'file' : ($r['signature_id'] !== null ? 'signature' : 'upload'));
            return [
                'id' => (int)$r['id'], 'kind' => $kind,
                'name' => $r['folder_name'] ?? $r['file_name'] ?? $r['sig_title'] ?? $r['up_title'] ?? '—',
                'is_folder' => $r['folder_id'] !== null,
            ];
        }, $items->fetchAll());
        $uf = Database::pdo()->prepare('SELECT f.id, f.name FROM portal_upload_folders u JOIN folders f ON f.id = u.folder_id WHERE u.portal_id = ? ORDER BY f.name');
        $uf->execute([$id]);
        $out['upload_folders'] = array_map(static fn($r) => ['id' => (int)$r['id'], 'name' => $r['name']], $uf->fetchAll());
        return $out;
    }

    private static function shape(array $p): array
    {
        return [
            'id' => (int)$p['id'], 'name' => $p['name'], 'token' => $p['token'],
            'contact_id' => $p['contact_id'] !== null ? (int)$p['contact_id'] : null,
            'contact_name' => $p['contact_name'] ?? null,
            'intro' => $p['intro'], 'has_password' => !empty($p['password_hash']),
            'has_upload_password' => !empty($p['upload_password_hash']),
            'items' => (int)($p['items'] ?? 0), 'created_at' => $p['created_at'] ?? null,
        ];
    }

    private static function byToken(string $token): ?array
    {
        $s = Database::pdo()->prepare('SELECT * FROM portals WHERE token = ? LIMIT 1');
        $s->execute([$token]);
        return $s->fetch() ?: null;
    }

    private static function pwOk(array $p, Request $req): bool
    {
        $pw = $req->getQueryParams()['p'] ?? (((array)$req->getParsedBody())['password'] ?? null);
        return $pw !== null && password_verify((string)$pw, (string)$p['password_hash']);
    }

    private static function owned(int $uid, int $id): bool
    {
        $s = Database::pdo()->prepare('SELECT 1 FROM portals WHERE id = ? AND user_id = ?');
        $s->execute([$id, $uid]);
        return (bool)$s->fetch();
    }

    private static function cid($v): ?int { return ($v !== null && (int)$v > 0) ? (int)$v : null; }
    private static function str($v, int $max): ?string { if ($v === null) return null; $v = trim((string)$v); return $v === '' ? null : mb_substr($v, 0, $max); }
}
