<?php
declare(strict_types=1);

namespace Nyza\Routes;

use Nyza\Database;
use Nyza\Json;
use Nyza\Middleware\AuthMiddleware;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;
use Slim\Routing\RouteCollectorProxy;

/**
 * Tags / labels. A per-user palette attachable to DMS files, documents
 * (invoices/offers) and expenses through polymorphic taggings. The client loads
 * the tag list once and a {entity_id: [tagId,…]} map per view, then assigns /
 * unassigns and filters locally — so the heavy list endpoints stay untouched.
 */
final class TagRoutes
{
    private const TYPES = ['file', 'document', 'expense'];

    public static function mount(App $app): void
    {
        $app->group('/api/tags', function (RouteCollectorProxy $g) {
            $g->get('',               [self::class, 'list']);
            $g->post('',              [self::class, 'create']);
            $g->get('/map',           [self::class, 'map']);
            $g->patch('/{id}',        [self::class, 'update']);
            $g->delete('/{id}',       [self::class, 'delete']);
            $g->post('/{id}/assign',  [self::class, 'assign']);
            $g->post('/{id}/unassign',[self::class, 'unassign']);
        })->add(new AuthMiddleware());
    }

    public static function list(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $s = Database::pdo()->prepare(
            'SELECT t.id, t.name, t.color, COUNT(tg.id) AS count
             FROM tags t LEFT JOIN taggings tg ON tg.tag_id = t.id
             WHERE t.user_id = ? GROUP BY t.id ORDER BY t.name'
        );
        $s->execute([$uid]);
        $tags = array_map(static fn($r) => [
            'id' => (int)$r['id'], 'name' => $r['name'], 'color' => $r['color'], 'count' => (int)$r['count'],
        ], $s->fetchAll());
        return Json::ok($res, ['tags' => $tags]);
    }

    public static function create(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array)$req->getParsedBody();
        $name = trim((string)($b['name'] ?? ''));
        if ($name === '') return Json::err($res, 'Name fehlt', 422);
        $name = mb_substr($name, 0, 48);
        $color = self::color($b['color'] ?? 'violet');
        $pdo = Database::pdo();
        // Idempotent: reuse an existing same-named tag instead of erroring.
        $ex = $pdo->prepare('SELECT id, name, color FROM tags WHERE user_id = ? AND name = ?');
        $ex->execute([$uid, $name]);
        if ($row = $ex->fetch()) {
            return Json::ok($res, ['tag' => ['id' => (int)$row['id'], 'name' => $row['name'], 'color' => $row['color'], 'count' => 0]]);
        }
        $pdo->prepare('INSERT INTO tags (user_id, name, color) VALUES (?, ?, ?)')->execute([$uid, $name, $color]);
        $id = (int)$pdo->lastInsertId();
        return Json::ok($res, ['tag' => ['id' => $id, 'name' => $name, 'color' => $color, 'count' => 0]], 201);
    }

    public static function update(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $b = (array)$req->getParsedBody();
        if (!self::owned($uid, $id)) return Json::err($res, 'Not found', 404);
        $sets = []; $vals = [];
        if (isset($b['name']) && trim((string)$b['name']) !== '') { $sets[] = 'name = ?'; $vals[] = mb_substr(trim((string)$b['name']), 0, 48); }
        if (isset($b['color'])) { $sets[] = 'color = ?'; $vals[] = self::color($b['color']); }
        if (!$sets) return Json::err($res, 'Nichts zu ändern', 422);
        $vals[] = $id; $vals[] = $uid;
        Database::pdo()->prepare('UPDATE tags SET ' . implode(', ', $sets) . ' WHERE id = ? AND user_id = ?')->execute($vals);
        return Json::ok($res, ['ok' => true]);
    }

    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::owned($uid, $id)) return Json::err($res, 'Not found', 404);
        Database::pdo()->prepare('DELETE FROM tags WHERE id = ? AND user_id = ?')->execute([$id, $uid]); // taggings cascade
        return Json::ok($res, ['ok' => true]);
    }

    /** {map: {entityId: [tagId,…]}} for one entity type — drives chips + filters. */
    public static function map(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $type = (string)($req->getQueryParams()['type'] ?? 'file');
        if (!in_array($type, self::TYPES, true)) return Json::err($res, 'Bad type', 422);
        $s = Database::pdo()->prepare(
            'SELECT tg.entity_id, tg.tag_id FROM taggings tg
             JOIN tags t ON t.id = tg.tag_id
             WHERE t.user_id = ? AND tg.entity_type = ?'
        );
        $s->execute([$uid, $type]);
        $map = [];
        foreach ($s->fetchAll() as $r) {
            $map[(string)(int)$r['entity_id']][] = (int)$r['tag_id'];
        }
        return Json::ok($res, ['map' => (object)$map]);
    }

    public static function assign(Request $req, Response $res, array $args): Response
    {
        return self::toggle($req, $res, (int)$args['id'], true);
    }

    public static function unassign(Request $req, Response $res, array $args): Response
    {
        return self::toggle($req, $res, (int)$args['id'], false);
    }

    private static function toggle(Request $req, Response $res, int $tagId, bool $on): Response
    {
        $uid = (int)$req->getAttribute('uid');
        if (!self::owned($uid, $tagId)) return Json::err($res, 'Not found', 404);
        $b = (array)$req->getParsedBody();
        $type = (string)($b['type'] ?? '');
        $eid = (int)($b['id'] ?? 0);
        if (!in_array($type, self::TYPES, true) || $eid <= 0) return Json::err($res, 'Bad target', 422);
        $pdo = Database::pdo();
        if ($on) {
            $pdo->prepare('INSERT IGNORE INTO taggings (tag_id, entity_type, entity_id) VALUES (?, ?, ?)')
                ->execute([$tagId, $type, $eid]);
        } else {
            $pdo->prepare('DELETE FROM taggings WHERE tag_id = ? AND entity_type = ? AND entity_id = ?')
                ->execute([$tagId, $type, $eid]);
        }
        return Json::ok($res, ['ok' => true]);
    }

    private static function owned(int $uid, int $id): bool
    {
        $s = Database::pdo()->prepare('SELECT 1 FROM tags WHERE id = ? AND user_id = ?');
        $s->execute([$id, $uid]);
        return (bool)$s->fetch();
    }

    private static function color($v): string
    {
        $c = strtolower(trim((string)$v));
        $ok = ['violet', 'blue', 'green', 'amber', 'red', 'pink', 'teal', 'slate'];
        return in_array($c, $ok, true) ? $c : 'violet';
    }
}
