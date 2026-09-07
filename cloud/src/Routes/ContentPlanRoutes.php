<?php
declare(strict_types=1);

namespace Nyza\Routes;

use Nyza\Database;
use Nyza\Json;
use Nyza\Middleware\AuthMiddleware;
use Nyza\Storage;
use Nyza\WorkspaceContext;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;
use Slim\Routing\RouteCollectorProxy;

/**
 * Content Plan — editorial calendar per client, with a per-month approval link.
 *
 * The team plans content on a month calendar (several items per day are normal:
 * a post plus the story pointing at it), attaches the idea and the finished
 * asset, and shares one month at a time with the customer. The customer opens a
 * token link and approves / rejects / requests changes per item; those verdicts
 * flow straight back into the team's calendar.
 *
 * Everything is scoped by Kontogruppe (workspace), like tasks and calendar.
 * Deliberately independent of the older content_* idea library.
 */
final class ContentPlanRoutes
{
    private const MEDIA_MAX = 200 * 1024 * 1024;
    private const FORMATS   = ['post', 'story', 'reel'];
    private const PLATFORMS = ['instagram', 'facebook', 'tiktok', 'linkedin', 'youtube', 'pinterest'];
    private const STATUSES  = ['idea', 'draft', 'ready', 'scheduled', 'posted'];
    private const REVIEWS   = ['pending', 'approved', 'rejected', 'revision'];

    public static function mount(App $app): void
    {
        $app->group('/api/content-plan', function (RouteCollectorProxy $g) {
            $g->get('/clients',         [self::class, 'listClients']);
            $g->post('/clients',        [self::class, 'createClient']);
            $g->patch('/clients/{id}',  [self::class, 'updateClient']);
            $g->delete('/clients/{id}', [self::class, 'deleteClient']);

            $g->get('/items',           [self::class, 'listItems']);
            $g->post('/items',          [self::class, 'createItem']);
            $g->get('/items/{id}',      [self::class, 'showItem']);
            $g->patch('/items/{id}',    [self::class, 'updateItem']);
            $g->delete('/items/{id}',   [self::class, 'deleteItem']);
            $g->post('/items/{id}/media',    [self::class, 'uploadMedia']);
            $g->post('/items/{id}/duplicate',[self::class, 'duplicateItem']);
            $g->post('/items/{id}/comments', [self::class, 'addComment']);
            $g->delete('/media/{mid}',  [self::class, 'deleteMedia']);
            $g->get('/media/{mid}/raw', [self::class, 'serveMedia']);

            $g->get('/shares',          [self::class, 'listShares']);
            $g->post('/shares',         [self::class, 'createShare']);
            $g->patch('/shares/{id}',   [self::class, 'updateShare']);
            $g->delete('/shares/{id}',  [self::class, 'deleteShare']);
        })->add(new AuthMiddleware());

        // Public (customer side) — one month of one client, by token.
        $app->post('/api/cp/{token}/unlock',            [self::class, 'publicUnlock']);
        $app->get('/api/cp/{token}',                    [self::class, 'publicShow']);
        $app->get('/api/cp/{token}/media/{mid}',        [self::class, 'publicMedia']);
        $app->post('/api/cp/{token}/items/{id}/review', [self::class, 'publicReview']);
    }

    // ───────────────────────── Clients ──────────────────────────────────────

    public static function listClients(Request $req, Response $res): Response
    {
        $wid = WorkspaceContext::of((int)$req->getAttribute('uid'));
        $s = Database::pdo()->prepare(
            'SELECT c.*, '
            . '(SELECT COUNT(*) FROM cp_items i WHERE i.client_id = c.id) AS item_count '
            . 'FROM cp_clients c WHERE c.workspace_id = ? AND c.archived_at IS NULL '
            . 'ORDER BY c.name ASC'
        );
        $s->execute([$wid]);
        return Json::ok($res, ['clients' => array_map([self::class, 'shapeClient'], $s->fetchAll())]);
    }

    public static function createClient(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array)$req->getParsedBody();
        $name = trim((string)($b['name'] ?? ''));
        if ($name === '') return Json::err($res, 'Name erforderlich', 422);
        $pdo = Database::pdo();
        $pdo->prepare('INSERT INTO cp_clients (workspace_id, name, tone, note) VALUES (?, ?, ?, ?)')
            ->execute([
                WorkspaceContext::of($uid), mb_substr($name, 0, 190),
                self::str($b['tone'] ?? null, 20), self::str($b['note'] ?? null, 2000),
            ]);
        return Json::ok($res, ['client' => self::shapeClient(self::fetchClient($uid, (int)$pdo->lastInsertId()) ?? [])], 201);
    }

    public static function updateClient(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchClient($uid, $id)) return Json::err($res, 'Not found', 404);
        $b = (array)$req->getParsedBody();
        $sets = []; $params = [];
        foreach (['name' => 190, 'tone' => 20, 'note' => 2000] as $k => $max) {
            if (array_key_exists($k, $b)) { $sets[] = "$k = ?"; $params[] = self::str($b[$k], $max); }
        }
        if ($sets) {
            $params[] = $id;
            Database::pdo()->prepare('UPDATE cp_clients SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($params);
        }
        return Json::ok($res, ['client' => self::shapeClient(self::fetchClient($uid, $id) ?? [])]);
    }

    public static function deleteClient(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchClient($uid, $id)) return Json::err($res, 'Not found', 404);
        // Items, media rows, shares and comments cascade; drop the files too.
        $m = Database::pdo()->prepare('SELECT m.path FROM cp_media m JOIN cp_items i ON i.id = m.item_id WHERE i.client_id = ?');
        $m->execute([$id]);
        foreach ($m->fetchAll() as $row) Storage::deleteRel((string)$row['path']);
        Database::pdo()->prepare('DELETE FROM cp_clients WHERE id = ?')->execute([$id]);
        return Json::ok($res, ['ok' => true]);
    }

    // ───────────────────────── Items ────────────────────────────────────────

    /** ?client_id= &year= &month=  (or &from=&to= for an arbitrary range). */
    public static function listItems(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $qp = $req->getQueryParams();
        $clientId = (int)($qp['client_id'] ?? 0);
        if (!$clientId || !self::fetchClient($uid, $clientId)) return Json::err($res, 'Kunde nicht gefunden', 404);

        [$from, $to] = self::range($qp);
        $s = Database::pdo()->prepare(
            'SELECT * FROM cp_items WHERE client_id = ? AND plan_date BETWEEN ? AND ? '
            . 'ORDER BY plan_date ASC, sort_order ASC, plan_time IS NULL, plan_time ASC, id ASC'
        );
        $s->execute([$clientId, $from, $to]);
        $items = $s->fetchAll();
        return Json::ok($res, ['items' => array_map(fn($r) => self::shapeItem($r, true), $items), 'from' => $from, 'to' => $to]);
    }

    public static function showItem(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $it = self::fetchItem($uid, (int)$args['id']);
        if (!$it) return Json::err($res, 'Not found', 404);
        return Json::ok($res, ['item' => self::shapeItem($it, true)]);
    }

    public static function createItem(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array)$req->getParsedBody();
        $clientId = (int)($b['client_id'] ?? 0);
        if (!$clientId || !self::fetchClient($uid, $clientId)) return Json::err($res, 'Kunde nicht gefunden', 404);
        $date = self::date($b['plan_date'] ?? null);
        if ($date === null) return Json::err($res, 'Datum erforderlich (JJJJ-MM-TT)', 422);
        $title = trim((string)($b['title'] ?? ''));
        if ($title === '') $title = 'Ohne Titel';

        $pdo = Database::pdo();
        $pdo->prepare(
            'INSERT INTO cp_items (workspace_id, client_id, plan_date, plan_time, title, idea, caption, '
            . 'formats, platforms, status, linked_to_id, sort_order, created_by) '
            . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([
            WorkspaceContext::of($uid), $clientId, $date, self::time($b['plan_time'] ?? null),
            mb_substr($title, 0, 300), self::str($b['idea'] ?? null, 20000), self::str($b['caption'] ?? null, 20000),
            self::csv($b['formats'] ?? null, self::FORMATS), self::csv($b['platforms'] ?? null, self::PLATFORMS),
            self::pick($b['status'] ?? null, self::STATUSES, 'idea'),
            self::linked($uid, $clientId, $b['linked_to_id'] ?? null),
            (int)($b['sort_order'] ?? 0), $uid,
        ]);
        $id = (int)$pdo->lastInsertId();
        return Json::ok($res, ['item' => self::shapeItem(self::fetchItem($uid, $id), true)], 201);
    }

    public static function updateItem(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $it = self::fetchItem($uid, $id);
        if (!$it) return Json::err($res, 'Not found', 404);
        $b = (array)$req->getParsedBody();

        $sets = []; $params = [];
        if (array_key_exists('plan_date', $b)) {
            $d = self::date($b['plan_date']);
            if ($d === null) return Json::err($res, 'Ungültiges Datum', 422);
            $sets[] = 'plan_date = ?'; $params[] = $d;
        }
        if (array_key_exists('plan_time', $b))  { $sets[] = 'plan_time = ?';  $params[] = self::time($b['plan_time']); }
        if (array_key_exists('title', $b))      { $sets[] = 'title = ?';      $params[] = mb_substr(trim((string)$b['title']) ?: 'Ohne Titel', 0, 300); }
        if (array_key_exists('idea', $b))       { $sets[] = 'idea = ?';       $params[] = self::str($b['idea'], 20000); }
        if (array_key_exists('caption', $b))    { $sets[] = 'caption = ?';    $params[] = self::str($b['caption'], 20000); }
        if (array_key_exists('formats', $b))    { $sets[] = 'formats = ?';    $params[] = self::csv($b['formats'], self::FORMATS); }
        if (array_key_exists('platforms', $b))  { $sets[] = 'platforms = ?';  $params[] = self::csv($b['platforms'], self::PLATFORMS); }
        if (array_key_exists('status', $b))     { $sets[] = 'status = ?';     $params[] = self::pick($b['status'], self::STATUSES, 'idea'); }
        if (array_key_exists('sort_order', $b)) { $sets[] = 'sort_order = ?'; $params[] = (int)$b['sort_order']; }
        if (array_key_exists('linked_to_id', $b)) {
            $sets[] = 'linked_to_id = ?';
            $params[] = self::linked($uid, (int)$it['client_id'], $b['linked_to_id'], $id);
        }
        // The team may reset a verdict (e.g. after reworking a rejected item)
        // so the customer sees it as open again on their link.
        if (array_key_exists('review_status', $b)) {
            $rs = self::pick($b['review_status'], self::REVIEWS, 'pending');
            $sets[] = 'review_status = ?'; $params[] = $rs;
            if ($rs === 'pending') { $sets[] = 'review_comment = NULL'; $sets[] = 'reviewed_at = NULL'; $sets[] = 'reviewed_by = NULL'; }
        }
        if ($sets) {
            $params[] = $id;
            Database::pdo()->prepare('UPDATE cp_items SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($params);
        }
        return Json::ok($res, ['item' => self::shapeItem(self::fetchItem($uid, $id), true)]);
    }

    public static function deleteItem(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchItem($uid, $id)) return Json::err($res, 'Not found', 404);
        $m = Database::pdo()->prepare('SELECT path FROM cp_media WHERE item_id = ?');
        $m->execute([$id]);
        foreach ($m->fetchAll() as $row) Storage::deleteRel((string)$row['path']);
        Database::pdo()->prepare('DELETE FROM cp_items WHERE id = ?')->execute([$id]);
        return Json::ok($res, ['ok' => true]);
    }

    /**
     * Copy an item (optionally onto another date) — the "same post again next
     * week" case. Media files are physically copied so the two items never
     * share storage; the customer's verdict and thread start fresh.
     */
    public static function duplicateItem(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $src = self::fetchItem($uid, (int)$args['id']);
        if (!$src) return Json::err($res, 'Not found', 404);
        $b = (array)$req->getParsedBody();
        $date = self::date($b['plan_date'] ?? null) ?? $src['plan_date'];

        $pdo = Database::pdo();
        $pdo->prepare(
            'INSERT INTO cp_items (workspace_id, client_id, plan_date, plan_time, title, idea, caption, '
            . 'formats, platforms, status, linked_to_id, sort_order, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)'
        )->execute([
            $src['workspace_id'], $src['client_id'], $date, $src['plan_time'],
            mb_substr((string)$src['title'], 0, 300), $src['idea'], $src['caption'],
            $src['formats'], $src['platforms'], $src['status'] === 'posted' ? 'draft' : $src['status'],
            (int)$src['sort_order'] + 1, $uid,
        ]);
        $newId = (int)$pdo->lastInsertId();

        $m = $pdo->prepare('SELECT * FROM cp_media WHERE item_id = ? ORDER BY id');
        $m->execute([(int)$src['id']]);
        $ins = $pdo->prepare('INSERT INTO cp_media (item_id, kind, path, name, mime, size) VALUES (?, ?, ?, ?, ?, ?)');
        foreach ($m->fetchAll() as $row) {
            $from = Storage::abs((string)$row['path']);
            if (!is_file($from)) continue;
            $rel = Storage::relPath($uid, (string)$row['name']);
            $to = Storage::abs($rel);
            if (!is_dir(dirname($to))) @mkdir(dirname($to), 0775, true);
            if (!@copy($from, $to)) continue;
            $ins->execute([$newId, $row['kind'], $rel, $row['name'], $row['mime'], (int)$row['size']]);
        }
        return Json::ok($res, ['item' => self::shapeItem(self::fetchItem($uid, $newId), true)], 201);
    }

    // ───────────────────────── Media ────────────────────────────────────────

    public static function uploadMedia(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchItem($uid, $id)) return Json::err($res, 'Not found', 404);
        $file = $req->getUploadedFiles()['file'] ?? null;
        if (!$file || $file->getError() !== UPLOAD_ERR_OK) return Json::err($res, 'Keine Datei', 422);
        if ((int)$file->getSize() > self::MEDIA_MAX) return Json::err($res, 'Datei zu groß (max 200 MB)', 413);

        $kind = ((string)((array)$req->getParsedBody())['kind'] ?? '') === 'idea' ? 'idea' : 'result';
        $name = $file->getClientFilename() ?: 'datei.bin';
        $mime = $file->getClientMediaType() ?: 'application/octet-stream';
        $rel = Storage::relPath($uid, $name);
        $file->moveTo(Storage::abs($rel));
        Database::pdo()->prepare('INSERT INTO cp_media (item_id, kind, path, name, mime, size) VALUES (?, ?, ?, ?, ?, ?)')
            ->execute([$id, $kind, $rel, mb_substr($name, 0, 255), mb_substr($mime, 0, 100), (int)$file->getSize()]);
        return Json::ok($res, ['item' => self::shapeItem(self::fetchItem($uid, $id), true)], 201);
    }

    public static function deleteMedia(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $mid = (int)$args['mid'];
        $row = self::fetchMedia($uid, $mid);
        if (!$row) return Json::err($res, 'Not found', 404);
        Storage::deleteRel((string)$row['path']);
        Database::pdo()->prepare('DELETE FROM cp_media WHERE id = ?')->execute([$mid]);
        return Json::ok($res, ['ok' => true]);
    }

    public static function serveMedia(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $row = self::fetchMedia($uid, (int)$args['mid']);
        if (!$row) return Json::err($res, 'Not found', 404);
        return self::stream($row, !empty($req->getQueryParams()['download']));
    }

    // ───────────────────────── Comments ─────────────────────────────────────

    public static function addComment(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchItem($uid, $id)) return Json::err($res, 'Not found', 404);
        $body = trim((string)((array)$req->getParsedBody())['body'] ?? '');
        if ($body === '') return Json::err($res, 'Kommentar leer', 422);
        $n = Database::pdo()->prepare('SELECT name FROM users WHERE id = ?');
        $n->execute([$uid]);
        $author = (string)(($n->fetch()['name'] ?? '') ?: 'Team');
        Database::pdo()->prepare('INSERT INTO cp_comments (item_id, user_id, author, body) VALUES (?, ?, ?, ?)')
            ->execute([$id, $uid, mb_substr($author, 0, 160), mb_substr($body, 0, 5000)]);
        return Json::ok($res, ['comments' => self::comments($id)], 201);
    }

    // ───────────────────────── Shares (per month) ───────────────────────────

    public static function listShares(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $clientId = (int)($req->getQueryParams()['client_id'] ?? 0);
        if (!$clientId || !self::fetchClient($uid, $clientId)) return Json::err($res, 'Kunde nicht gefunden', 404);
        $s = Database::pdo()->prepare('SELECT * FROM cp_shares WHERE client_id = ? ORDER BY year DESC, month DESC');
        $s->execute([$clientId]);
        return Json::ok($res, ['shares' => array_map([self::class, 'shapeShare'], $s->fetchAll())]);
    }

    /**
     * Create (or return) the link for one client-month. Idempotent on purpose:
     * a month already handed to the customer must keep its URL, and simply show
     * whatever has been added since.
     */
    public static function createShare(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array)$req->getParsedBody();
        $clientId = (int)($b['client_id'] ?? 0);
        if (!$clientId || !self::fetchClient($uid, $clientId)) return Json::err($res, 'Kunde nicht gefunden', 404);
        $year = (int)($b['year'] ?? 0);
        $month = (int)($b['month'] ?? 0);
        if ($year < 2000 || $year > 2100 || $month < 1 || $month > 12) return Json::err($res, 'Monat ungültig', 422);

        $pdo = Database::pdo();
        $ex = $pdo->prepare('SELECT * FROM cp_shares WHERE client_id = ? AND year = ? AND month = ?');
        $ex->execute([$clientId, $year, $month]);
        if ($row = $ex->fetch()) return Json::ok($res, ['share' => self::shapeShare($row)]);

        $pdo->prepare('INSERT INTO cp_shares (workspace_id, client_id, year, month, token, intro) VALUES (?, ?, ?, ?, ?, ?)')
            ->execute([
                WorkspaceContext::of($uid), $clientId, $year, $month,
                bin2hex(random_bytes(16)), self::str($b['intro'] ?? null, 2000),
            ]);
        $ex->execute([$clientId, $year, $month]);
        return Json::ok($res, ['share' => self::shapeShare($ex->fetch())], 201);
    }

    public static function updateShare(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $row = self::fetchShare($uid, (int)$args['id']);
        if (!$row) return Json::err($res, 'Not found', 404);
        $b = (array)$req->getParsedBody();
        $sets = []; $params = [];
        if (array_key_exists('intro', $b)) { $sets[] = 'intro = ?'; $params[] = self::str($b['intro'], 2000); }
        if (array_key_exists('password', $b)) {
            $pw = (string)$b['password'];
            $sets[] = 'password_hash = ?';
            $params[] = $pw === '' ? null : password_hash($pw, PASSWORD_BCRYPT);
        }
        if ($sets) {
            $params[] = (int)$args['id'];
            Database::pdo()->prepare('UPDATE cp_shares SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($params);
        }
        return Json::ok($res, ['share' => self::shapeShare(self::fetchShare($uid, (int)$args['id']))]);
    }

    public static function deleteShare(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        if (!self::fetchShare($uid, (int)$args['id'])) return Json::err($res, 'Not found', 404);
        Database::pdo()->prepare('DELETE FROM cp_shares WHERE id = ?')->execute([(int)$args['id']]);
        return Json::ok($res, ['ok' => true]);
    }

    // ───────────────────────── Public (customer) ────────────────────────────

    public static function publicUnlock(Request $req, Response $res, array $args): Response
    {
        $share = self::shareByToken((string)$args['token']);
        if (!$share) return Json::err($res, 'Link nicht gefunden', 404, 'notfound');
        $pw = (string)((array)$req->getParsedBody())['password'] ?? '';
        if ($share['password_hash'] && !password_verify($pw, (string)$share['password_hash'])) {
            return Json::err($res, 'Falsches Passwort', 403, 'bad_password');
        }
        return Json::ok($res, ['ok' => true]);
    }

    public static function publicShow(Request $req, Response $res, array $args): Response
    {
        $share = self::shareByToken((string)$args['token']);
        if (!$share) return Json::err($res, 'Link nicht gefunden', 404, 'notfound');
        if (!self::publicAuthed($req, $share)) return Json::err($res, 'Passwort erforderlich', 401, 'password');

        $client = Database::pdo()->prepare('SELECT name FROM cp_clients WHERE id = ?');
        $client->execute([(int)$share['client_id']]);
        [$from, $to] = self::monthRange((int)$share['year'], (int)$share['month']);

        $s = Database::pdo()->prepare(
            'SELECT * FROM cp_items WHERE client_id = ? AND plan_date BETWEEN ? AND ? '
            . "AND status <> 'idea' "     // drafts stay internal until they're worked out
            . 'ORDER BY plan_date ASC, sort_order ASC, plan_time IS NULL, plan_time ASC, id ASC'
        );
        $s->execute([(int)$share['client_id'], $from, $to]);

        return Json::ok($res, [
            'client'  => (string)($client->fetch()['name'] ?? ''),
            'year'    => (int)$share['year'],
            'month'   => (int)$share['month'],
            'intro'   => $share['intro'],
            'items'   => array_map(fn($r) => self::shapeItem($r, true), $s->fetchAll()),
        ]);
    }

    public static function publicMedia(Request $req, Response $res, array $args): Response
    {
        $share = self::shareByToken((string)$args['token']);
        if (!$share) return Json::err($res, 'Not found', 404);
        if (!self::publicAuthed($req, $share)) return Json::err($res, 'Passwort erforderlich', 401, 'password');
        [$from, $to] = self::monthRange((int)$share['year'], (int)$share['month']);
        // The media must belong to an item of THIS client and THIS month —
        // otherwise a token would expose every asset in the installation.
        $m = Database::pdo()->prepare(
            'SELECT m.* FROM cp_media m JOIN cp_items i ON i.id = m.item_id '
            . 'WHERE m.id = ? AND i.client_id = ? AND i.plan_date BETWEEN ? AND ?'
        );
        $m->execute([(int)$args['mid'], (int)$share['client_id'], $from, $to]);
        $row = $m->fetch();
        if (!$row) return Json::err($res, 'Not found', 404);
        return self::stream($row, !empty($req->getQueryParams()['download']));
    }

    public static function publicReview(Request $req, Response $res, array $args): Response
    {
        $share = self::shareByToken((string)$args['token']);
        if (!$share) return Json::err($res, 'Not found', 404);
        if (!self::publicAuthed($req, $share)) return Json::err($res, 'Passwort erforderlich', 401, 'password');
        [$from, $to] = self::monthRange((int)$share['year'], (int)$share['month']);

        $pdo = Database::pdo();
        $q = $pdo->prepare('SELECT * FROM cp_items WHERE id = ? AND client_id = ? AND plan_date BETWEEN ? AND ?');
        $q->execute([(int)$args['id'], (int)$share['client_id'], $from, $to]);
        $item = $q->fetch();
        if (!$item) return Json::err($res, 'Not found', 404);

        $b = (array)$req->getParsedBody();
        $decision = self::pick($b['decision'] ?? null, ['approved', 'rejected', 'revision'], '');
        if ($decision === '') return Json::err($res, 'Entscheidung fehlt', 422);
        $comment = self::str($b['comment'] ?? null, 5000);
        if ($decision !== 'approved' && ($comment === null || trim($comment) === '')) {
            return Json::err($res, 'Bitte kurz begründen, was geändert werden soll', 422, 'comment_required');
        }
        $who = trim((string)($b['name'] ?? '')) !== '' ? mb_substr(trim((string)$b['name']), 0, 160) : 'Kunde';

        $pdo->prepare('UPDATE cp_items SET review_status = ?, review_comment = ?, reviewed_at = NOW(), reviewed_by = ? WHERE id = ?')
            ->execute([$decision, $comment, $who, (int)$item['id']]);
        if ($comment !== null && trim($comment) !== '') {
            $pdo->prepare('INSERT INTO cp_comments (item_id, user_id, author, body, decision) VALUES (?, NULL, ?, ?, ?)')
                ->execute([(int)$item['id'], $who, $comment, $decision]);
        }
        $q->execute([(int)$args['id'], (int)$share['client_id'], $from, $to]);
        return Json::ok($res, ['item' => self::shapeItem($q->fetch(), true)]);
    }

    // ───────────────────────── helpers ──────────────────────────────────────

    /** The customer's password travels as ?p= (same pattern as share links). */
    private static function publicAuthed(Request $req, array $share): bool
    {
        if (!$share['password_hash']) return true;
        $qp = $req->getQueryParams();
        $pw = (string)($qp['p'] ?? ((array)$req->getParsedBody())['password'] ?? '');
        return $pw !== '' && password_verify($pw, (string)$share['password_hash']);
    }

    private static function shareByToken(string $token): ?array
    {
        $s = Database::pdo()->prepare('SELECT * FROM cp_shares WHERE token = ?');
        $s->execute([$token]);
        return $s->fetch() ?: null;
    }

    private static function fetchClient(int $uid, int $id): ?array
    {
        if ($id <= 0) return null;
        $s = Database::pdo()->prepare('SELECT * FROM cp_clients WHERE id = ? AND workspace_id = ?');
        $s->execute([$id, WorkspaceContext::of($uid)]);
        return $s->fetch() ?: null;
    }

    /** Every item mutation gates on this, so scoping lives in one place. */
    private static function fetchItem(int $uid, int $id): ?array
    {
        if ($id <= 0) return null;
        $s = Database::pdo()->prepare(
            'SELECT i.* FROM cp_items i JOIN cp_clients c ON c.id = i.client_id '
            . 'WHERE i.id = ? AND c.workspace_id = ?'
        );
        $s->execute([$id, WorkspaceContext::of($uid)]);
        return $s->fetch() ?: null;
    }

    private static function fetchMedia(int $uid, int $mid): ?array
    {
        $s = Database::pdo()->prepare(
            'SELECT m.* FROM cp_media m JOIN cp_items i ON i.id = m.item_id '
            . 'JOIN cp_clients c ON c.id = i.client_id WHERE m.id = ? AND c.workspace_id = ?'
        );
        $s->execute([$mid, WorkspaceContext::of($uid)]);
        return $s->fetch() ?: null;
    }

    private static function fetchShare(int $uid, int $id): ?array
    {
        $s = Database::pdo()->prepare(
            'SELECT s.* FROM cp_shares s JOIN cp_clients c ON c.id = s.client_id '
            . 'WHERE s.id = ? AND c.workspace_id = ?'
        );
        $s->execute([$id, WorkspaceContext::of($uid)]);
        return $s->fetch() ?: null;
    }

    private static function comments(int $itemId): array
    {
        $s = Database::pdo()->prepare('SELECT * FROM cp_comments WHERE item_id = ? ORDER BY id ASC');
        $s->execute([$itemId]);
        return array_map(static fn(array $c) => [
            'id'         => (int)$c['id'],
            'author'     => $c['author'],
            'from_team'  => $c['user_id'] !== null,
            'body'       => $c['body'],
            'decision'   => $c['decision'],
            'created_at' => $c['created_at'],
        ], $s->fetchAll());
    }

    private static function media(int $itemId): array
    {
        $s = Database::pdo()->prepare('SELECT * FROM cp_media WHERE item_id = ? ORDER BY id ASC');
        $s->execute([$itemId]);
        return array_map(static fn(array $m) => [
            'id'    => (int)$m['id'],
            'kind'  => $m['kind'],
            'name'  => $m['name'],
            'mime'  => $m['mime'],
            'size'  => (int)$m['size'],
            'is_image' => str_starts_with((string)$m['mime'], 'image/'),
            'is_video' => str_starts_with((string)$m['mime'], 'video/'),
        ], $s->fetchAll());
    }

    private static function shapeClient(array $c): array
    {
        if (!$c) return [];
        return [
            'id'         => (int)$c['id'],
            'name'       => $c['name'],
            'tone'       => $c['tone'],
            'note'       => $c['note'],
            'item_count' => isset($c['item_count']) ? (int)$c['item_count'] : 0,
        ];
    }

    private static function shapeItem(?array $r, bool $withDetail = false): array
    {
        if (!$r) return [];
        $out = [
            'id'            => (int)$r['id'],
            'client_id'     => (int)$r['client_id'],
            'plan_date'     => $r['plan_date'],
            'plan_time'     => $r['plan_time'] !== null ? substr((string)$r['plan_time'], 0, 5) : null,
            'title'         => $r['title'],
            'idea'          => $r['idea'],
            'caption'       => $r['caption'],
            'formats'       => $r['formats'] !== '' ? explode(',', (string)$r['formats']) : [],
            'platforms'     => $r['platforms'] !== '' ? explode(',', (string)$r['platforms']) : [],
            'status'        => $r['status'],
            'review_status' => $r['review_status'],
            'review_comment'=> $r['review_comment'],
            'reviewed_at'   => $r['reviewed_at'],
            'reviewed_by'   => $r['reviewed_by'],
            'linked_to_id'  => $r['linked_to_id'] !== null ? (int)$r['linked_to_id'] : null,
            'sort_order'    => (int)$r['sort_order'],
        ];
        if ($withDetail) {
            $out['media'] = self::media((int)$r['id']);
            $out['comments'] = self::comments((int)$r['id']);
        }
        return $out;
    }

    private static function shapeShare(?array $s): array
    {
        if (!$s) return [];
        return [
            'id'          => (int)$s['id'],
            'client_id'   => (int)$s['client_id'],
            'year'        => (int)$s['year'],
            'month'       => (int)$s['month'],
            'token'       => $s['token'],
            'intro'       => $s['intro'],
            'has_password'=> !empty($s['password_hash']),
            'created_at'  => $s['created_at'],
        ];
    }

    private static function stream(array $row, bool $download): Response
    {
        $abs = Storage::abs((string)$row['path']);
        if (!is_file($abs)) {
            http_response_code(404);
            exit;
        }
        while (ob_get_level() > 0) { @ob_end_clean(); }
        header('Content-Type: ' . ((string)($row['mime'] ?: 'application/octet-stream')));
        header('Content-Disposition: ' . ($download ? 'attachment' : 'inline')
            . '; filename="' . addslashes((string)$row['name']) . '"');
        header('Content-Length: ' . (string)filesize($abs));
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: private, max-age=0, must-revalidate');
        readfile($abs);
        exit;
    }

    /** ?year=&month= wins; otherwise ?from=&to=; otherwise the current month. */
    private static function range(array $qp): array
    {
        $year = (int)($qp['year'] ?? 0);
        $month = (int)($qp['month'] ?? 0);
        if ($year >= 2000 && $month >= 1 && $month <= 12) return self::monthRange($year, $month);
        $from = self::date($qp['from'] ?? null);
        $to = self::date($qp['to'] ?? null);
        if ($from !== null && $to !== null) return [$from, $to];
        return self::monthRange((int)date('Y'), (int)date('n'));
    }

    private static function monthRange(int $year, int $month): array
    {
        $first = sprintf('%04d-%02d-01', $year, $month);
        return [$first, date('Y-m-t', strtotime($first))];
    }

    private static function date($v): ?string
    {
        if ($v === null || $v === '') return null;
        $v = (string)$v;
        return preg_match('/^\d{4}-\d{2}-\d{2}$/', $v) ? $v : null;
    }

    private static function time($v): ?string
    {
        if ($v === null || $v === '') return null;
        $v = (string)$v;
        if (!preg_match('/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/', $v)) return null;
        return strlen($v) === 5 ? $v . ':00' : $v;
    }

    private static function str($v, int $max): ?string
    {
        if ($v === null) return null;
        $v = trim((string)$v);
        return $v === '' ? null : mb_substr($v, 0, $max);
    }

    private static function pick($v, array $allowed, string $default): string
    {
        $v = (string)($v ?? '');
        return in_array($v, $allowed, true) ? $v : $default;
    }

    /** Normalise a list (array or csv) down to the allowed values, as csv. */
    private static function csv($v, array $allowed): string
    {
        if ($v === null) return '';
        $list = is_array($v) ? $v : explode(',', (string)$v);
        $out = [];
        foreach ($list as $x) {
            $x = trim((string)$x);
            if (in_array($x, $allowed, true) && !in_array($x, $out, true)) $out[] = $x;
        }
        return implode(',', $out);
    }

    /** A link target must be another item of the same client (and not itself). */
    private static function linked(int $uid, int $clientId, $v, int $selfId = 0): ?int
    {
        if ($v === null || $v === '' || (int)$v <= 0) return null;
        $target = (int)$v;
        if ($target === $selfId) return null;
        $it = self::fetchItem($uid, $target);
        return ($it && (int)$it['client_id'] === $clientId) ? $target : null;
    }
}
