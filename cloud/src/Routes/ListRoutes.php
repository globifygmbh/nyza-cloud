<?php
declare(strict_types=1);

namespace Nyza\Routes;

use Nyza\Database;
use Nyza\Json;
use Nyza\Middleware\AuthMiddleware;
use Nyza\WorkspaceContext;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;
use Slim\Routing\RouteCollectorProxy;

/**
 * Listen — shared checklists. Several lists per team, notes on each entry, tick
 * things off; who ticked what is recorded so a shared list stays readable.
 *
 * Scoped by Kontogruppe (workspace) like tasks and calendar: every member of a
 * group works on the same lists, other groups see none of them.
 */
final class ListRoutes
{
    public static function mount(App $app): void
    {
        $app->group('/api/lists', function (RouteCollectorProxy $g) {
            $g->get('',                    [self::class, 'index']);
            $g->post('',                   [self::class, 'create']);
            $g->get('/{id}',               [self::class, 'show']);
            $g->patch('/{id}',             [self::class, 'update']);
            $g->delete('/{id}',            [self::class, 'destroy']);
            $g->post('/{id}/items',        [self::class, 'addItem']);
            $g->post('/{id}/clear-done',   [self::class, 'clearDone']);
            $g->patch('/items/{itemId}',   [self::class, 'updateItem']);
            $g->delete('/items/{itemId}',  [self::class, 'deleteItem']);
        })->add(new AuthMiddleware());
    }

    // ───────────────────────── Lists ────────────────────────────────────────

    public static function index(Request $req, Response $res): Response
    {
        $wid = WorkspaceContext::of((int)$req->getAttribute('uid'));
        $s = Database::pdo()->prepare(
            'SELECT l.*, u.name AS created_by_name, '
            . '(SELECT COUNT(*) FROM checklist_items i WHERE i.list_id = l.id) AS total, '
            . '(SELECT COUNT(*) FROM checklist_items i WHERE i.list_id = l.id AND i.done = 1) AS done_count '
            . 'FROM checklists l LEFT JOIN users u ON u.id = l.created_by '
            . 'WHERE l.workspace_id = ? ORDER BY l.sort_order ASC, l.id ASC'
        );
        $s->execute([$wid]);
        return Json::ok($res, ['lists' => array_map([self::class, 'shapeList'], $s->fetchAll())]);
    }

    public static function show(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $l = self::fetchList($uid, (int)$args['id']);
        if (!$l) return Json::err($res, 'Not found', 404);
        $out = self::shapeList($l);
        $out['items'] = self::items((int)$l['id']);
        return Json::ok($res, ['list' => $out]);
    }

    public static function create(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array)$req->getParsedBody();
        $name = trim((string)($b['name'] ?? ''));
        if ($name === '') return Json::err($res, 'Name erforderlich', 422);

        $pdo = Database::pdo();
        $wid = WorkspaceContext::of($uid);
        $next = $pdo->prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM checklists WHERE workspace_id = ?');
        $next->execute([$wid]);
        $pdo->prepare('INSERT INTO checklists (workspace_id, name, note, tone, sort_order, created_by) VALUES (?, ?, ?, ?, ?, ?)')
            ->execute([
                $wid, mb_substr($name, 0, 190), self::str($b['note'] ?? null, 5000),
                self::str($b['tone'] ?? null, 20), (int)($next->fetch()['n'] ?? 1), $uid,
            ]);
        $id = (int)$pdo->lastInsertId();
        $out = self::shapeList(self::fetchList($uid, $id) ?? []);
        $out['items'] = [];
        return Json::ok($res, ['list' => $out], 201);
    }

    public static function update(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchList($uid, $id)) return Json::err($res, 'Not found', 404);
        $b = (array)$req->getParsedBody();

        $sets = []; $params = [];
        if (array_key_exists('name', $b)) {
            $name = trim((string)$b['name']);
            if ($name === '') return Json::err($res, 'Name erforderlich', 422);
            $sets[] = 'name = ?'; $params[] = mb_substr($name, 0, 190);
        }
        if (array_key_exists('note', $b))       { $sets[] = 'note = ?';       $params[] = self::str($b['note'], 5000); }
        if (array_key_exists('tone', $b))       { $sets[] = 'tone = ?';       $params[] = self::str($b['tone'], 20); }
        if (array_key_exists('sort_order', $b)) { $sets[] = 'sort_order = ?'; $params[] = (int)$b['sort_order']; }
        if ($sets) {
            $params[] = $id;
            Database::pdo()->prepare('UPDATE checklists SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($params);
        }
        $out = self::shapeList(self::fetchList($uid, $id) ?? []);
        $out['items'] = self::items($id);
        return Json::ok($res, ['list' => $out]);
    }

    public static function destroy(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchList($uid, $id)) return Json::err($res, 'Not found', 404);
        Database::pdo()->prepare('DELETE FROM checklists WHERE id = ?')->execute([$id]);   // items cascade
        return Json::ok($res, ['ok' => true]);
    }

    // ───────────────────────── Items ────────────────────────────────────────

    public static function addItem(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchList($uid, $id)) return Json::err($res, 'Not found', 404);
        $b = (array)$req->getParsedBody();

        // Accept one entry, or a pasted block of lines as several entries.
        $raw = (string)($b['text'] ?? '');
        $lines = array_values(array_filter(array_map('trim', preg_split('/\R/', $raw) ?: []), fn($t) => $t !== ''));
        if (!$lines) return Json::err($res, 'Text erforderlich', 422);

        $pdo = Database::pdo();
        $next = $pdo->prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM checklist_items WHERE list_id = ?');
        $next->execute([$id]);
        $order = (int)($next->fetch()['n'] ?? 1);
        $ins = $pdo->prepare('INSERT INTO checklist_items (list_id, text, note, sort_order, created_by) VALUES (?, ?, ?, ?, ?)');
        foreach ($lines as $line) {
            $ins->execute([$id, mb_substr($line, 0, 2000), self::str($b['note'] ?? null, 5000), $order++, $uid]);
        }
        return Json::ok($res, ['items' => self::items($id)], 201);
    }

    public static function updateItem(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $itemId = (int)$args['itemId'];
        $it = self::fetchItem($uid, $itemId);
        if (!$it) return Json::err($res, 'Not found', 404);
        $b = (array)$req->getParsedBody();

        $sets = []; $params = [];
        if (array_key_exists('text', $b)) {
            $t = trim((string)$b['text']);
            if ($t === '') return Json::err($res, 'Text erforderlich', 422);
            $sets[] = 'text = ?'; $params[] = mb_substr($t, 0, 2000);
        }
        if (array_key_exists('note', $b))       { $sets[] = 'note = ?';       $params[] = self::str($b['note'], 5000); }
        if (array_key_exists('sort_order', $b)) { $sets[] = 'sort_order = ?'; $params[] = (int)$b['sort_order']; }
        if (array_key_exists('done', $b)) {
            $done = (int)((bool)$b['done']);
            $sets[] = 'done = ?';    $params[] = $done;
            // Record who ticked it — on a shared list that is the useful part.
            $sets[] = 'done_at = ?'; $params[] = $done ? date('Y-m-d H:i:s') : null;
            $sets[] = 'done_by = ?'; $params[] = $done ? $uid : null;
        }
        if ($sets) {
            $params[] = $itemId;
            Database::pdo()->prepare('UPDATE checklist_items SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($params);
        }
        return Json::ok($res, ['items' => self::items((int)$it['list_id'])]);
    }

    public static function deleteItem(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $it = self::fetchItem($uid, (int)$args['itemId']);
        if (!$it) return Json::err($res, 'Not found', 404);
        Database::pdo()->prepare('DELETE FROM checklist_items WHERE id = ?')->execute([(int)$it['id']]);
        return Json::ok($res, ['items' => self::items((int)$it['list_id'])]);
    }

    /** Remove everything already ticked off — tidying a long-running list. */
    public static function clearDone(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchList($uid, $id)) return Json::err($res, 'Not found', 404);
        Database::pdo()->prepare('DELETE FROM checklist_items WHERE list_id = ? AND done = 1')->execute([$id]);
        return Json::ok($res, ['items' => self::items($id)]);
    }

    // ───────────────────────── helpers ──────────────────────────────────────

    private static function fetchList(int $uid, int $id): ?array
    {
        if ($id <= 0) return null;
        $s = Database::pdo()->prepare(
            'SELECT l.*, u.name AS created_by_name, '
            . '(SELECT COUNT(*) FROM checklist_items i WHERE i.list_id = l.id) AS total, '
            . '(SELECT COUNT(*) FROM checklist_items i WHERE i.list_id = l.id AND i.done = 1) AS done_count '
            . 'FROM checklists l LEFT JOIN users u ON u.id = l.created_by '
            . 'WHERE l.id = ? AND l.workspace_id = ?'
        );
        $s->execute([$id, WorkspaceContext::of($uid)]);
        return $s->fetch() ?: null;
    }

    /** Item mutations all gate on this, so the scoping check lives in one place. */
    private static function fetchItem(int $uid, int $itemId): ?array
    {
        if ($itemId <= 0) return null;
        $s = Database::pdo()->prepare(
            'SELECT i.* FROM checklist_items i JOIN checklists l ON l.id = i.list_id '
            . 'WHERE i.id = ? AND l.workspace_id = ?'
        );
        $s->execute([$itemId, WorkspaceContext::of($uid)]);
        return $s->fetch() ?: null;
    }

    private static function items(int $listId): array
    {
        $s = Database::pdo()->prepare(
            'SELECT i.*, u.name AS done_by_name FROM checklist_items i '
            . 'LEFT JOIN users u ON u.id = i.done_by '
            . 'WHERE i.list_id = ? ORDER BY i.done ASC, i.sort_order ASC, i.id ASC'
        );
        $s->execute([$listId]);
        return array_map(static fn(array $r) => [
            'id'           => (int)$r['id'],
            'list_id'      => (int)$r['list_id'],
            'text'         => $r['text'],
            'note'         => $r['note'],
            'done'         => (int)$r['done'] === 1,
            'done_at'      => $r['done_at'],
            'done_by_name' => $r['done_by_name'],
            'sort_order'   => (int)$r['sort_order'],
        ], $s->fetchAll());
    }

    private static function shapeList(array $l): array
    {
        if (!$l) return [];
        return [
            'id'              => (int)$l['id'],
            'name'            => $l['name'],
            'note'            => $l['note'],
            'tone'            => $l['tone'],
            'sort_order'      => (int)$l['sort_order'],
            'total'           => isset($l['total']) ? (int)$l['total'] : 0,
            'done_count'      => isset($l['done_count']) ? (int)$l['done_count'] : 0,
            'created_by_name' => $l['created_by_name'] ?? null,
            'created_at'      => $l['created_at'] ?? null,
        ];
    }

    private static function str($v, int $max): ?string
    {
        if ($v === null) return null;
        $v = trim((string)$v);
        return $v === '' ? null : mb_substr($v, 0, $max);
    }
}
