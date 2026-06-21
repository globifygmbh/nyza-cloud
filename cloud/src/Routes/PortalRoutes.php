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
        Database::pdo()->prepare('INSERT INTO portals (user_id, company_id, name, contact_id, intro, token, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
            ->execute([$uid, $cid, mb_substr($name, 0, 160), self::cid($b['contact_id'] ?? null), self::str($b['intro'] ?? null, 4000), $token, $hash]);
        return Json::ok($res, ['portal' => self::detail($uid, (int)Database::pdo()->lastInsertId())], 201);
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
        if ($sets) { $vals[] = $id; $vals[] = $uid; Database::pdo()->prepare('UPDATE portals SET ' . implode(', ', $sets) . ' WHERE id = ? AND user_id = ?')->execute($vals); }
        return Json::ok($res, ['portal' => self::detail($uid, $id)]);
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
        if (!$folderId && !$fileId) return Json::err($res, 'folder_id oder file_id nötig', 422);
        // verify ownership of the referenced item
        if ($folderId) { $c = Database::pdo()->prepare('SELECT 1 FROM folders WHERE id = ? AND user_id = ?'); $c->execute([$folderId, $uid]); if (!$c->fetch()) return Json::err($res, 'Ordner nicht gefunden', 404); }
        if ($fileId) { $c = Database::pdo()->prepare('SELECT 1 FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL'); $c->execute([$fileId, $uid]); if (!$c->fetch()) return Json::err($res, 'Datei nicht gefunden', 404); }
        Database::pdo()->prepare('INSERT INTO portal_items (portal_id, folder_id, file_id) VALUES (?, ?, ?)')->execute([$id, $folderId, $fileId]);
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
            'SELECT i.id, i.folder_id, i.file_id, f.name AS folder_name, fi.name AS file_name, fi.kind AS file_kind '
            . 'FROM portal_items i LEFT JOIN folders f ON f.id = i.folder_id LEFT JOIN files fi ON fi.id = i.file_id WHERE i.portal_id = ?'
        );
        $items->execute([$id]);
        $out['item_list'] = array_map(static fn($r) => [
            'id' => (int)$r['id'],
            'folder_id' => $r['folder_id'] !== null ? (int)$r['folder_id'] : null,
            'file_id' => $r['file_id'] !== null ? (int)$r['file_id'] : null,
            'name' => $r['folder_name'] ?? $r['file_name'] ?? '—',
            'is_folder' => $r['folder_id'] !== null,
        ], $items->fetchAll());
        return $out;
    }

    private static function shape(array $p): array
    {
        return [
            'id' => (int)$p['id'], 'name' => $p['name'], 'token' => $p['token'],
            'contact_id' => $p['contact_id'] !== null ? (int)$p['contact_id'] : null,
            'contact_name' => $p['contact_name'] ?? null,
            'intro' => $p['intro'], 'has_password' => !empty($p['password_hash']),
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
