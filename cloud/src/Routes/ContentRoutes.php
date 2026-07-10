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
use Slim\Routing\RouteCollectorProxy;

/**
 * Content-Planung ("TikTok"-App) — mehrere Content-Accounts pro Nutzer
 * (z. B. Arcade Room, Lokalio, …), jeder mit eigenen Ideen, Kategorien,
 * Hashtags und Dateien. Accounts sind ein geteilter Arbeitsbereich wie
 * Firmen: der Anlegende ist automatisch Mitglied, weitere Nyza-Cloud-Nutzer
 * können als Mitglieder hinzugefügt werden — ohne das ist ein Account nur
 * für den Ersteller sichtbar.
 */
final class ContentRoutes
{
    private const STATUSES = ['idee', 'script', 'filmen', 'schneiden', 'bereit', 'geplant', 'veroeffentlicht', 'archiv'];
    private const FILE_MAX = 200 * 1024 * 1024;

    public static function mount(App $app): void
    {
        $app->group('/api/content', function (RouteCollectorProxy $g) {
            $g->get('/accounts',                    [self::class, 'listAccounts']);
            $g->post('/accounts',                   [self::class, 'createAccount']);
            $g->patch('/accounts/{id}',              [self::class, 'renameAccount']);
            $g->delete('/accounts/{id}',             [self::class, 'deleteAccount']);
            $g->get('/accounts/{id}/members',        [self::class, 'members']);
            $g->post('/accounts/{id}/members',       [self::class, 'addMember']);
            $g->delete('/accounts/{id}/members/{userId}', [self::class, 'removeMember']);

            $g->get('/categories',        [self::class, 'listCategories']);
            $g->post('/categories',       [self::class, 'createCategory']);
            $g->patch('/categories/{id}', [self::class, 'updateCategory']);
            $g->delete('/categories/{id}',[self::class, 'deleteCategory']);

            $g->get('/hashtags',        [self::class, 'listHashtags']);
            $g->post('/hashtags',       [self::class, 'createHashtag']);
            $g->delete('/hashtags/{id}',[self::class, 'deleteHashtag']);

            $g->get('/ideas',                 [self::class, 'listIdeas']);
            $g->post('/ideas',                [self::class, 'createIdea']);
            $g->get('/ideas/{id}',            [self::class, 'getIdea']);
            $g->patch('/ideas/{id}',          [self::class, 'updateIdea']);
            $g->delete('/ideas/{id}',         [self::class, 'deleteIdea']);
            $g->post('/ideas/{id}/duplicate', [self::class, 'duplicateIdea']);
            $g->post('/ideas/{id}/files',     [self::class, 'uploadFile']);

            $g->get('/files/{fileId}',    [self::class, 'getFile']);
            $g->delete('/files/{fileId}', [self::class, 'deleteFile']);

            $g->get('/media', [self::class, 'listMedia']);

            $g->get('/inspiration',           [self::class, 'listInspiration']);
            $g->post('/inspiration',          [self::class, 'createInspirationLink']);
            $g->post('/inspiration/upload',   [self::class, 'uploadInspirationImage']);
            $g->delete('/inspiration/{id}',   [self::class, 'deleteInspiration']);
            $g->get('/inspiration/{id}/image',[self::class, 'getInspirationImage']);
        })->add(new AuthMiddleware());
    }

    // ───── Medienbibliothek (alle Dateien im Account) ──────────────────────────

    public static function listMedia(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $q = $req->getQueryParams();
        $accountId = (int)($q['account_id'] ?? 0);
        if (!self::hasAccess($uid, $accountId)) return Json::err($res, 'Kein Zugriff', 403, 'forbidden');

        $where = 'ci.account_id = ?'; $params = [$accountId];
        $type = (string)($q['type'] ?? '');
        if ($type === 'video') { $where .= " AND cf.mime LIKE 'video/%'"; }
        elseif ($type === 'image') { $where .= " AND cf.mime LIKE 'image/%'"; }
        elseif ($type === 'other') { $where .= " AND (cf.mime IS NULL OR (cf.mime NOT LIKE 'video/%' AND cf.mime NOT LIKE 'image/%'))"; }

        $s = Database::pdo()->prepare(
            "SELECT cf.id, cf.name, cf.mime, cf.size, cf.created_at, ci.id AS idea_id, ci.title AS idea_title "
            . "FROM content_files cf JOIN content_ideas ci ON ci.id = cf.idea_id WHERE $where ORDER BY cf.created_at DESC LIMIT 500"
        );
        $s->execute($params);
        $files = array_map(static fn($r) => [
            'id' => (int)$r['id'], 'name' => $r['name'], 'mime' => $r['mime'], 'size' => (int)$r['size'],
            'created_at' => $r['created_at'], 'idea_id' => (int)$r['idea_id'], 'idea_title' => $r['idea_title'],
        ], $s->fetchAll());
        return Json::ok($res, ['files' => $files]);
    }

    // ───── Inspiration board ────────────────────────────────────────────────────

    public static function listInspiration(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $accountId = (int)($req->getQueryParams()['account_id'] ?? 0);
        if (!self::hasAccess($uid, $accountId)) return Json::err($res, 'Kein Zugriff', 403, 'forbidden');
        $s = Database::pdo()->prepare('SELECT * FROM content_inspiration WHERE account_id = ? ORDER BY id DESC');
        $s->execute([$accountId]);
        return Json::ok($res, ['items' => array_map([self::class, 'shapeInspiration'], $s->fetchAll())]);
    }

    public static function createInspirationLink(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array)$req->getParsedBody();
        $accountId = (int)($b['account_id'] ?? 0);
        if (!self::hasAccess($uid, $accountId)) return Json::err($res, 'Kein Zugriff', 403, 'forbidden');
        $url = trim((string)($b['url'] ?? ''));
        if ($url === '' || !preg_match('#^https?://#i', $url)) return Json::err($res, 'Gültiger Link erforderlich', 422);
        $note = trim((string)($b['note'] ?? ''));
        Database::pdo()->prepare('INSERT INTO content_inspiration (account_id, kind, url, note, created_by) VALUES (?, "link", ?, ?, ?)')
            ->execute([$accountId, mb_substr($url, 0, 1000), $note !== '' ? mb_substr($note, 0, 500) : null, $uid]);
        $id = (int)Database::pdo()->lastInsertId();
        return Json::ok($res, ['item' => self::fetchInspiration($id)], 201);
    }

    public static function uploadInspirationImage(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array)$req->getParsedBody();
        $accountId = (int)($b['account_id'] ?? 0);
        if (!self::hasAccess($uid, $accountId)) return Json::err($res, 'Kein Zugriff', 403, 'forbidden');
        $file = $req->getUploadedFiles()['file'] ?? null;
        if (!$file || $file->getError() !== UPLOAD_ERR_OK) return Json::err($res, 'Keine Datei', 422);
        if ((int)$file->getSize() > self::FILE_MAX) return Json::err($res, 'Datei zu groß (max 200 MB)', 413);
        $note = trim((string)($b['note'] ?? ''));

        $name = $file->getClientFilename() ?: 'screenshot.png';
        $mime = $file->getClientMediaType() ?: 'application/octet-stream';
        $rel = Storage::relPath($uid, $name);
        $file->moveTo(Storage::abs($rel));
        Database::pdo()->prepare('INSERT INTO content_inspiration (account_id, kind, file_path, file_name, file_mime, note, created_by) VALUES (?, "image", ?, ?, ?, ?, ?)')
            ->execute([$accountId, $rel, mb_substr($name, 0, 255), mb_substr($mime, 0, 100), $note !== '' ? mb_substr($note, 0, 500) : null, $uid]);
        $id = (int)Database::pdo()->lastInsertId();
        return Json::ok($res, ['item' => self::fetchInspiration($id)], 201);
    }

    public static function getInspirationImage(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $s = Database::pdo()->prepare('SELECT * FROM content_inspiration WHERE id = ?');
        $s->execute([$id]);
        $row = $s->fetch();
        if (!$row || !self::hasAccess($uid, (int)$row['account_id']) || empty($row['file_path'])) return Json::err($res, 'Not found', 404);
        $abs = Storage::abs($row['file_path']);
        if (!is_file($abs)) return Json::err($res, 'Not found', 404);
        $data = (string)file_get_contents($abs);
        while (ob_get_level() > 0) { @ob_end_clean(); }
        header('Content-Type: ' . ($row['file_mime'] ?: 'application/octet-stream'));
        header('Content-Disposition: inline; filename="' . addslashes((string)$row['file_name']) . '"');
        header('Content-Length: ' . strlen($data));
        header('Cache-Control: private, max-age=3600');
        echo $data;
        exit;
    }

    public static function deleteInspiration(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $s = Database::pdo()->prepare('SELECT * FROM content_inspiration WHERE id = ?');
        $s->execute([$id]);
        $row = $s->fetch();
        if (!$row || !self::hasAccess($uid, (int)$row['account_id'])) return Json::err($res, 'Not found', 404);
        if (!empty($row['file_path'])) Storage::deleteRel($row['file_path']);
        Database::pdo()->prepare('DELETE FROM content_inspiration WHERE id = ?')->execute([$id]);
        return Json::ok($res, ['ok' => true]);
    }

    private static function fetchInspiration(int $id): ?array
    {
        $s = Database::pdo()->prepare('SELECT * FROM content_inspiration WHERE id = ?');
        $s->execute([$id]);
        $r = $s->fetch();
        return $r ? self::shapeInspiration($r) : null;
    }

    private static function shapeInspiration(array $r): array
    {
        return [
            'id' => (int)$r['id'], 'account_id' => (int)$r['account_id'], 'kind' => $r['kind'],
            'url' => $r['url'], 'file_name' => $r['file_name'], 'file_mime' => $r['file_mime'],
            'note' => $r['note'], 'created_at' => $r['created_at'],
        ];
    }

    // ───── Accounts ──────────────────────────────────────────────────────────

    public static function listAccounts(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $s = Database::pdo()->prepare(
            'SELECT a.id, a.name, a.owner_id, (a.owner_id = ?) AS is_owner '
            . 'FROM content_accounts a JOIN content_account_members m ON m.account_id = a.id '
            . 'WHERE m.user_id = ? ORDER BY a.name ASC, a.id ASC'
        );
        $s->execute([$uid, $uid]);
        $rows = array_map(static fn($r) => [
            'id' => (int)$r['id'], 'name' => $r['name'], 'is_owner' => (bool)$r['is_owner'],
        ], $s->fetchAll());
        return Json::ok($res, ['accounts' => $rows]);
    }

    public static function createAccount(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array)$req->getParsedBody();
        $name = trim((string)($b['name'] ?? ''));
        if ($name === '') return Json::err($res, 'Name erforderlich', 422);

        $pdo = Database::pdo();
        $pdo->beginTransaction();
        try {
            $pdo->prepare('INSERT INTO content_accounts (owner_id, name) VALUES (?, ?)')->execute([$uid, mb_substr($name, 0, 255)]);
            $id = (int)$pdo->lastInsertId();
            $pdo->prepare('INSERT INTO content_account_members (account_id, user_id) VALUES (?, ?)')->execute([$id, $uid]);
            if (!empty($b['seed'])) self::seedArcadeRoom($pdo, $id, $uid);
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            return Json::err($res, 'Anlegen fehlgeschlagen: ' . $e->getMessage(), 500);
        }
        return Json::ok($res, ['account' => ['id' => $id, 'name' => $name, 'is_owner' => true]], 201);
    }

    public static function renameAccount(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::isOwner($uid, $id)) return Json::err($res, 'Nur der Ersteller kann umbenennen', 403, 'forbidden');
        $b = (array)$req->getParsedBody();
        $name = trim((string)($b['name'] ?? ''));
        if ($name === '') return Json::err($res, 'Name erforderlich', 422);
        Database::pdo()->prepare('UPDATE content_accounts SET name = ? WHERE id = ?')->execute([mb_substr($name, 0, 255), $id]);
        return Json::ok($res, ['ok' => true]);
    }

    public static function deleteAccount(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::isOwner($uid, $id)) return Json::err($res, 'Nur der Ersteller kann löschen', 403, 'forbidden');
        $pdo = Database::pdo();
        $s = $pdo->prepare('SELECT path FROM content_files cf JOIN content_ideas ci ON ci.id = cf.idea_id WHERE ci.account_id = ?');
        $s->execute([$id]);
        foreach ($s->fetchAll() as $f) { Storage::deleteRel($f['path']); }
        $pdo->prepare('DELETE FROM content_accounts WHERE id = ?')->execute([$id]);
        return Json::ok($res, ['ok' => true]);
    }

    public static function members(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::hasAccess($uid, $id)) return Json::err($res, 'Kein Zugriff', 403, 'forbidden');
        $s = Database::pdo()->prepare(
            'SELECT u.id, u.name, u.email, (a.owner_id = u.id) AS is_owner FROM content_account_members m '
            . 'JOIN users u ON u.id = m.user_id JOIN content_accounts a ON a.id = m.account_id '
            . 'WHERE m.account_id = ? ORDER BY is_owner DESC, u.name ASC'
        );
        $s->execute([$id]);
        $members = array_map(static fn($r) => [
            'user_id' => (int)$r['id'], 'name' => $r['name'], 'email' => $r['email'], 'is_owner' => (bool)$r['is_owner'],
        ], $s->fetchAll());
        return Json::ok($res, ['members' => $members]);
    }

    /** Any current member can invite another Nyza-Cloud user by e-mail — lightweight shared workspace. */
    public static function addMember(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::hasAccess($uid, $id)) return Json::err($res, 'Kein Zugriff', 403, 'forbidden');
        $b = (array)$req->getParsedBody();
        $email = trim((string)($b['email'] ?? ''));
        if ($email === '') return Json::err($res, 'E-Mail erforderlich', 422);

        $pdo = Database::pdo();
        $u = $pdo->prepare('SELECT id, name, email FROM users WHERE email = ?');
        $u->execute([$email]);
        $user = $u->fetch();
        if (!$user) return Json::err($res, 'Kein Nyza-Cloud-Nutzer mit dieser E-Mail gefunden', 404);

        $pdo->prepare('INSERT INTO content_account_members (account_id, user_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE account_id = account_id')
            ->execute([$id, (int)$user['id']]);
        return Json::ok($res, ['member' => ['user_id' => (int)$user['id'], 'name' => $user['name'], 'email' => $user['email'], 'is_owner' => false]], 201);
    }

    public static function removeMember(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $targetId = (int)$args['userId'];
        if (!self::hasAccess($uid, $id)) return Json::err($res, 'Kein Zugriff', 403, 'forbidden');
        if (self::isOwner($targetId, $id)) return Json::err($res, 'Der Ersteller kann nicht entfernt werden', 422);
        Database::pdo()->prepare('DELETE FROM content_account_members WHERE account_id = ? AND user_id = ?')->execute([$id, $targetId]);
        return Json::ok($res, ['ok' => true]);
    }

    // ───── Categories ────────────────────────────────────────────────────────

    public static function listCategories(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $accountId = (int)($req->getQueryParams()['account_id'] ?? 0);
        if (!self::hasAccess($uid, $accountId)) return Json::err($res, 'Kein Zugriff', 403, 'forbidden');
        $s = Database::pdo()->prepare('SELECT * FROM content_categories WHERE account_id = ? ORDER BY sort_order ASC, name ASC');
        $s->execute([$accountId]);
        return Json::ok($res, ['categories' => array_map(static fn($r) => ['id' => (int)$r['id'], 'name' => $r['name'], 'sort_order' => (int)$r['sort_order']], $s->fetchAll())]);
    }

    public static function createCategory(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array)$req->getParsedBody();
        $accountId = (int)($b['account_id'] ?? 0);
        if (!self::hasAccess($uid, $accountId)) return Json::err($res, 'Kein Zugriff', 403, 'forbidden');
        $name = trim((string)($b['name'] ?? ''));
        if ($name === '') return Json::err($res, 'Name erforderlich', 422);
        Database::pdo()->prepare('INSERT INTO content_categories (account_id, name) VALUES (?, ?)')->execute([$accountId, mb_substr($name, 0, 100)]);
        $id = (int)Database::pdo()->lastInsertId();
        return Json::ok($res, ['category' => ['id' => $id, 'name' => $name, 'sort_order' => 0]], 201);
    }

    public static function updateCategory(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $accountId = self::accountForCategory($id);
        if (!$accountId || !self::hasAccess($uid, $accountId)) return Json::err($res, 'Not found', 404);
        $b = (array)$req->getParsedBody();
        if (array_key_exists('name', $b)) {
            $name = trim((string)$b['name']);
            if ($name === '') return Json::err($res, 'Name erforderlich', 422);
            Database::pdo()->prepare('UPDATE content_categories SET name = ? WHERE id = ?')->execute([mb_substr($name, 0, 100), $id]);
        }
        if (array_key_exists('sort_order', $b)) {
            Database::pdo()->prepare('UPDATE content_categories SET sort_order = ? WHERE id = ?')->execute([(int)$b['sort_order'], $id]);
        }
        return Json::ok($res, ['ok' => true]);
    }

    public static function deleteCategory(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $accountId = self::accountForCategory($id);
        if (!$accountId || !self::hasAccess($uid, $accountId)) return Json::err($res, 'Not found', 404);
        Database::pdo()->prepare('DELETE FROM content_categories WHERE id = ?')->execute([$id]);
        return Json::ok($res, ['ok' => true]);
    }

    // ───── Hashtags ──────────────────────────────────────────────────────────

    public static function listHashtags(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $accountId = (int)($req->getQueryParams()['account_id'] ?? 0);
        if (!self::hasAccess($uid, $accountId)) return Json::err($res, 'Kein Zugriff', 403, 'forbidden');
        $s = Database::pdo()->prepare('SELECT * FROM content_hashtags WHERE account_id = ? ORDER BY tag ASC');
        $s->execute([$accountId]);
        return Json::ok($res, ['hashtags' => array_map(static fn($r) => ['id' => (int)$r['id'], 'tag' => $r['tag']], $s->fetchAll())]);
    }

    public static function createHashtag(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array)$req->getParsedBody();
        $accountId = (int)($b['account_id'] ?? 0);
        if (!self::hasAccess($uid, $accountId)) return Json::err($res, 'Kein Zugriff', 403, 'forbidden');
        $tag = ltrim(trim((string)($b['tag'] ?? '')), '#');
        if ($tag === '') return Json::err($res, 'Hashtag erforderlich', 422);
        Database::pdo()->prepare('INSERT INTO content_hashtags (account_id, tag) VALUES (?, ?)')->execute([$accountId, mb_substr($tag, 0, 100)]);
        $id = (int)Database::pdo()->lastInsertId();
        return Json::ok($res, ['hashtag' => ['id' => $id, 'tag' => $tag]], 201);
    }

    public static function deleteHashtag(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $s = Database::pdo()->prepare('SELECT account_id FROM content_hashtags WHERE id = ?');
        $s->execute([$id]);
        $accountId = (int)($s->fetchColumn() ?: 0);
        if (!$accountId || !self::hasAccess($uid, $accountId)) return Json::err($res, 'Not found', 404);
        Database::pdo()->prepare('DELETE FROM content_hashtags WHERE id = ?')->execute([$id]);
        return Json::ok($res, ['ok' => true]);
    }

    // ───── Ideas ─────────────────────────────────────────────────────────────

    public static function listIdeas(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $q = $req->getQueryParams();
        $accountId = (int)($q['account_id'] ?? 0);
        if (!self::hasAccess($uid, $accountId)) return Json::err($res, 'Kein Zugriff', 403, 'forbidden');

        $where = 'i.account_id = ?'; $params = [$accountId];
        if (!empty($q['status'])) { $where .= ' AND i.status = ?'; $params[] = $q['status']; }
        if (!empty($q['category_id'])) { $where .= ' AND i.category_id = ?'; $params[] = (int)$q['category_id']; }
        if (!empty($q['platform'])) { $where .= ' AND FIND_IN_SET(?, i.platforms)'; $params[] = $q['platform']; }
        if (!empty($q['q'])) {
            $like = '%' . str_replace(['%', '_'], ['\%', '\_'], (string)$q['q']) . '%';
            $where .= " AND (i.title LIKE ? ESCAPE '\\\\' OR i.hashtags LIKE ? ESCAPE '\\\\' OR i.notes LIKE ? ESCAPE '\\\\')";
            $params[] = $like; $params[] = $like; $params[] = $like;
        }
        $s = Database::pdo()->prepare(
            'SELECT i.*, c.name AS category_name, (SELECT COUNT(*) FROM content_files f WHERE f.idea_id = i.id) AS file_count '
            . "FROM content_ideas i LEFT JOIN content_categories c ON c.id = i.category_id WHERE $where "
            . 'ORDER BY i.status ASC, i.position ASC, i.id DESC'
        );
        $s->execute($params);
        return Json::ok($res, ['ideas' => array_map([self::class, 'shapeIdea'], $s->fetchAll())]);
    }

    public static function createIdea(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array)$req->getParsedBody();
        $accountId = (int)($b['account_id'] ?? 0);
        if (!self::hasAccess($uid, $accountId)) return Json::err($res, 'Kein Zugriff', 403, 'forbidden');
        $title = trim((string)($b['title'] ?? ''));
        if ($title === '') return Json::err($res, 'Titel erforderlich', 422);

        $pdo = Database::pdo();
        $maxPos = (int)$pdo->query('SELECT COALESCE(MAX(position),0) FROM content_ideas WHERE account_id = ' . $accountId)->fetchColumn();
        $f = self::fields($b, true);
        $cols = array_keys($f);
        $pdo->prepare('INSERT INTO content_ideas (account_id, created_by, position, ' . implode(', ', $cols) . ') VALUES (?, ?, ?, ' . implode(', ', array_fill(0, count($cols), '?')) . ')')
            ->execute(array_merge([$accountId, $uid, $maxPos + 1], array_values($f)));
        $id = (int)$pdo->lastInsertId();
        return Json::ok($res, ['idea' => self::fetchIdea($id)], 201);
    }

    public static function getIdea(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $idea = self::fetchIdea($id);
        if (!$idea || !self::hasAccess($uid, $idea['account_id'])) return Json::err($res, 'Not found', 404);
        $fs = Database::pdo()->prepare('SELECT id, name, mime, size FROM content_files WHERE idea_id = ? ORDER BY id ASC');
        $fs->execute([$id]);
        $idea['files'] = array_map(static fn($r) => ['id' => (int)$r['id'], 'name' => $r['name'], 'mime' => $r['mime'], 'size' => (int)$r['size']], $fs->fetchAll());
        return Json::ok($res, ['idea' => $idea]);
    }

    public static function updateIdea(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $idea = self::fetchIdea($id);
        if (!$idea || !self::hasAccess($uid, $idea['account_id'])) return Json::err($res, 'Not found', 404);
        $b = (array)$req->getParsedBody();
        if (array_key_exists('title', $b) && trim((string)$b['title']) === '') return Json::err($res, 'Titel erforderlich', 422);
        $f = self::fields($b, false);
        if (!$f) return Json::ok($res, ['idea' => self::fetchIdea($id)]);
        $sets = implode(', ', array_map(static fn($c) => "$c = ?", array_keys($f)));
        Database::pdo()->prepare("UPDATE content_ideas SET $sets WHERE id = ?")->execute([...array_values($f), $id]);
        return Json::ok($res, ['idea' => self::fetchIdea($id)]);
    }

    public static function deleteIdea(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $idea = self::fetchIdea($id);
        if (!$idea || !self::hasAccess($uid, $idea['account_id'])) return Json::err($res, 'Not found', 404);
        $pdo = Database::pdo();
        $s = $pdo->prepare('SELECT path FROM content_files WHERE idea_id = ?');
        $s->execute([$id]);
        foreach ($s->fetchAll() as $f) { Storage::deleteRel($f['path']); }
        $pdo->prepare('DELETE FROM content_ideas WHERE id = ?')->execute([$id]);
        return Json::ok($res, ['ok' => true]);
    }

    public static function duplicateIdea(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $idea = self::fetchIdea($id);
        if (!$idea || !self::hasAccess($uid, $idea['account_id'])) return Json::err($res, 'Not found', 404);
        $pdo = Database::pdo();
        $maxPos = (int)$pdo->query('SELECT COALESCE(MAX(position),0) FROM content_ideas WHERE account_id = ' . (int)$idea['account_id'])->fetchColumn();
        $pdo->prepare(
            'INSERT INTO content_ideas (account_id, created_by, position, title, description, category_id, status, platforms, priority, '
            . 'content_type, capture_device, duration, hook, script, shotlist, hashtags, music, sound_ideas, notes) '
            . 'VALUES (?, ?, ?, ?, ?, ?, "idee", ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([
            $idea['account_id'], $uid, $maxPos + 1, $idea['title'] . ' (Kopie)', $idea['description'], $idea['category_id'],
            self::platformsStr($idea['platforms']), $idea['priority'], $idea['content_type'], $idea['capture_device'], $idea['duration'],
            $idea['hook'], $idea['script'], $idea['shotlist'], $idea['hashtags'], $idea['music'], $idea['sound_ideas'], $idea['notes'],
        ]);
        $newId = (int)$pdo->lastInsertId();
        return Json::ok($res, ['idea' => self::fetchIdea($newId)], 201);
    }

    // ───── Files ─────────────────────────────────────────────────────────────

    public static function uploadFile(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $idea = self::fetchIdea($id);
        if (!$idea || !self::hasAccess($uid, $idea['account_id'])) return Json::err($res, 'Not found', 404);
        $file = $req->getUploadedFiles()['file'] ?? null;
        if (!$file || $file->getError() !== UPLOAD_ERR_OK) return Json::err($res, 'Keine Datei', 422);
        if ((int)$file->getSize() > self::FILE_MAX) return Json::err($res, 'Datei zu groß (max 200 MB)', 413);

        $name = $file->getClientFilename() ?: 'datei.bin';
        $mime = $file->getClientMediaType() ?: 'application/octet-stream';
        $rel = Storage::relPath($uid, $name);
        $file->moveTo(Storage::abs($rel));
        Database::pdo()->prepare('INSERT INTO content_files (idea_id, path, name, mime, size) VALUES (?, ?, ?, ?, ?)')
            ->execute([$id, $rel, mb_substr($name, 0, 255), mb_substr($mime, 0, 100), (int)$file->getSize()]);
        $fid = (int)Database::pdo()->lastInsertId();
        return Json::ok($res, ['file' => ['id' => $fid, 'name' => $name, 'mime' => $mime, 'size' => (int)$file->getSize()]], 201);
    }

    public static function getFile(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $fid = (int)$args['fileId'];
        $s = Database::pdo()->prepare('SELECT cf.*, ci.account_id FROM content_files cf JOIN content_ideas ci ON ci.id = cf.idea_id WHERE cf.id = ?');
        $s->execute([$fid]);
        $f = $s->fetch();
        if (!$f || !self::hasAccess($uid, (int)$f['account_id'])) return Json::err($res, 'Not found', 404);
        $abs = Storage::abs($f['path']);
        if (!is_file($abs)) return Json::err($res, 'Not found', 404);

        $download = !empty($req->getQueryParams()['download']);
        $data = (string)file_get_contents($abs);
        while (ob_get_level() > 0) { @ob_end_clean(); }
        header('Content-Type: ' . ($f['mime'] ?: 'application/octet-stream'));
        header('Content-Disposition: ' . ($download ? 'attachment' : 'inline') . '; filename="' . addslashes($f['name']) . '"');
        header('Content-Length: ' . strlen($data));
        header('Cache-Control: private, max-age=3600');
        echo $data;
        exit;
    }

    public static function deleteFile(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $fid = (int)$args['fileId'];
        $s = Database::pdo()->prepare('SELECT cf.*, ci.account_id FROM content_files cf JOIN content_ideas ci ON ci.id = cf.idea_id WHERE cf.id = ?');
        $s->execute([$fid]);
        $f = $s->fetch();
        if (!$f || !self::hasAccess($uid, (int)$f['account_id'])) return Json::err($res, 'Not found', 404);
        Storage::deleteRel($f['path']);
        Database::pdo()->prepare('DELETE FROM content_files WHERE id = ?')->execute([$fid]);
        return Json::ok($res, ['ok' => true]);
    }

    // ───── helpers ───────────────────────────────────────────────────────────

    private static function hasAccess(int $uid, int $accountId): bool
    {
        if ($accountId <= 0) return false;
        $s = Database::pdo()->prepare('SELECT 1 FROM content_account_members WHERE account_id = ? AND user_id = ?');
        $s->execute([$accountId, $uid]);
        return (bool)$s->fetch();
    }

    private static function isOwner(int $uid, int $accountId): bool
    {
        $s = Database::pdo()->prepare('SELECT 1 FROM content_accounts WHERE id = ? AND owner_id = ?');
        $s->execute([$accountId, $uid]);
        return (bool)$s->fetch();
    }

    private static function accountForCategory(int $id): int
    {
        $s = Database::pdo()->prepare('SELECT account_id FROM content_categories WHERE id = ?');
        $s->execute([$id]);
        return (int)($s->fetchColumn() ?: 0);
    }

    private static function fetchIdea(int $id): ?array
    {
        $s = Database::pdo()->prepare(
            'SELECT i.*, c.name AS category_name, (SELECT COUNT(*) FROM content_files f WHERE f.idea_id = i.id) AS file_count '
            . 'FROM content_ideas i LEFT JOIN content_categories c ON c.id = i.category_id WHERE i.id = ?'
        );
        $s->execute([$id]);
        $r = $s->fetch();
        return $r ? self::shapeIdea($r) : null;
    }

    private static function shapeIdea(array $r): array
    {
        return [
            'id' => (int)$r['id'], 'account_id' => (int)$r['account_id'], 'title' => $r['title'], 'description' => $r['description'],
            'category_id' => $r['category_id'] !== null ? (int)$r['category_id'] : null, 'category_name' => $r['category_name'],
            'status' => $r['status'], 'platforms' => self::platformsArr($r['platforms']), 'priority' => (int)$r['priority'],
            'content_type' => $r['content_type'], 'capture_device' => $r['capture_device'], 'duration' => $r['duration'],
            'hook' => $r['hook'], 'script' => $r['script'], 'shotlist' => $r['shotlist'], 'hashtags' => $r['hashtags'],
            'music' => $r['music'], 'sound_ideas' => $r['sound_ideas'], 'notes' => $r['notes'],
            'scheduled_at' => $r['scheduled_at'], 'position' => (int)$r['position'], 'file_count' => (int)$r['file_count'],
            'created_at' => $r['created_at'], 'updated_at' => $r['updated_at'],
        ];
    }

    private static function platformsArr($v): array
    {
        $v = trim((string)$v);
        return $v === '' ? [] : explode(',', $v);
    }

    private static function platformsStr($v): ?string
    {
        if (is_array($v)) $v = implode(',', array_filter(array_map('trim', $v)));
        $v = trim((string)$v);
        return $v === '' ? null : mb_substr($v, 0, 255);
    }

    /** Build the column→value map from the request body (create: every column with defaults; update: only present keys). */
    private static function fields(array $b, bool $withDefaults): array
    {
        $out = [];
        if (array_key_exists('title', $b)) $out['title'] = mb_substr(trim((string)$b['title']), 0, 255);
        elseif ($withDefaults) $out['title'] = '';

        $text = ['description' => 500, 'content_type' => 30, 'capture_device' => 20, 'duration' => 10, 'music' => 255];
        foreach ($text as $k => $max) {
            if (array_key_exists($k, $b)) { $v = $b[$k] === null ? null : trim((string)$b[$k]); $out[$k] = ($v === '' ? null : mb_substr($v, 0, $max)); }
            elseif ($withDefaults) $out[$k] = null;
        }
        $long = ['hook', 'script', 'shotlist', 'hashtags', 'sound_ideas', 'notes'];
        foreach ($long as $k) {
            if (array_key_exists($k, $b)) { $v = $b[$k] === null ? null : trim((string)$b[$k]); $out[$k] = ($v === '' ? null : $v); }
            elseif ($withDefaults) $out[$k] = null;
        }
        if (array_key_exists('category_id', $b)) $out['category_id'] = ($b['category_id'] !== null && $b['category_id'] !== '') ? (int)$b['category_id'] : null;
        elseif ($withDefaults) $out['category_id'] = null;

        if (array_key_exists('status', $b)) $out['status'] = in_array($b['status'], self::STATUSES, true) ? $b['status'] : 'idee';
        elseif ($withDefaults) $out['status'] = 'idee';

        if (array_key_exists('platforms', $b)) $out['platforms'] = self::platformsStr($b['platforms']);
        elseif ($withDefaults) $out['platforms'] = null;

        if (array_key_exists('priority', $b)) $out['priority'] = max(0, min(2, (int)$b['priority']));
        elseif ($withDefaults) $out['priority'] = 1;

        if (array_key_exists('position', $b)) $out['position'] = (int)$b['position'];

        if (array_key_exists('scheduled_at', $b)) {
            $v = trim((string)$b['scheduled_at']);
            $out['scheduled_at'] = preg_match('/^\d{4}-\d{2}-\d{2}$/', $v) ? $v : null;
        } elseif ($withDefaults) $out['scheduled_at'] = null;

        return $out;
    }

    /** Seeds a starter account with 50 arcade-room-flavoured TikTok content ideas. */
    private static function seedArcadeRoom(\PDO $pdo, int $accountId, int $uid): void
    {
        $cats = ['Arcade Sounds', 'Room Vibes', 'Neue Lieferungen', 'Neue Geräte', 'Umbauten', 'Community', 'Storytelling', 'ASMR'];
        $catIds = [];
        foreach ($cats as $i => $name) {
            $pdo->prepare('INSERT INTO content_categories (account_id, name, sort_order) VALUES (?, ?, ?)')->execute([$accountId, $name, $i]);
            $catIds[$name] = (int)$pdo->lastInsertId();
        }

        $ideas = [
            'Arcade Sounds' => [
                'Der Automat startet', 'Münze fällt ein', 'Joystick Sounds im Loop', 'Flipper-Geräusche ASMR',
                'Highscore-Fanfare', 'Krallenautomat Greifgeräusch', 'Lieblingsgeräusch des Tages',
                'Game-Over-Jingle Compilation', 'Knopfdruck-ASMR Nahaufnahme', 'Welcher Automat klingt am besten?',
            ],
            'Room Vibes' => [
                'Room bei Nacht mit Neonlicht', 'Vorher/Nachher Umbau', 'Freitagabend im Arcade Room',
                'Leerer Room am frühen Morgen', 'POV: Erster Schritt in den Room', 'Licht-Setup Zeitraffer',
                'Room Tour in 30 Sekunden', 'Lieblingsecke im Room', 'Farbwechsel LED Showcase', 'Slow-Motion durch den Room',
            ],
            'Neue Lieferungen' => ['Neuer Automat geliefert', 'Unboxing: Was ist in der Kiste?', 'Anlieferung Zeitraffer', 'Erste Reaktion auf neue Ware', 'Lieferwagen kommt an'],
            'Neue Geräte' => ['Neues Gerät im Testlauf', 'Erstes Spiel auf dem neuen Automaten', 'Technik-Check neues Gerät', 'Was kann das neue Gerät?', 'Reaktionen der Gäste auf neues Gerät'],
            'Umbauten' => ['Neue LEDs eingebaut', 'Umbau Zeitraffer', 'Werkzeug raus, Umbau los', 'Wand neu gestrichen', 'Layout-Änderung im Room'],
            'Community' => ['Community fragt, wir antworten', 'Bester Trick der Woche', 'Gäste-Highlight der Woche', 'Kommentare vorlesen und reagieren', 'Wer schafft den Highscore zuerst?'],
            'Storytelling' => ['Wie alles begann', 'Ein Tag im Arcade Room', 'Die Geschichte hinter dem Namen', 'Größter Fail bisher', 'Was niemand über uns weiß'],
            'ASMR' => ['Automat reinigen ASMR', 'Joystick-Klicks in Zeitlupe', 'Münzen sortieren ASMR', 'Reinigungsroutine am Morgen', 'Leiser Room, nur Ambient-Sounds'],
        ];

        $ins = $pdo->prepare(
            'INSERT INTO content_ideas (account_id, created_by, position, title, category_id, status, platforms, priority, content_type, capture_device) '
            . 'VALUES (?, ?, ?, ?, ?, "idee", "tiktok", 1, ?, "handy")'
        );
        $pos = 0;
        foreach ($ideas as $catName => $titles) {
            $style = $catName === 'ASMR' ? 'ASMR' : ($catName === 'Storytelling' ? 'Story' : ($catName === 'Community' ? 'Community' : null));
            foreach ($titles as $title) {
                $pos++;
                $ins->execute([$accountId, $uid, $pos, sprintf('%03d %s', $pos, $title), $catIds[$catName], $style]);
            }
        }
    }
}
