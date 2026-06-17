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
 * Roadmap — a chronological list of steps (milestones) ordered by date, each
 * with free-text labels, a colour, a completion flag and embedded sub-tasks
 * (checklist). Progress per step is derived from its sub-tasks.
 */
final class RoadmapRoutes
{
    private const COLORS = ['violet', 'blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'gray'];

    public static function mount(App $app): void
    {
        $app->group('/api/roadmap', function (RouteCollectorProxy $g) {
            $g->get('',                    [self::class, 'list']);
            $g->post('',                   [self::class, 'create']);
            $g->patch('/{id}',             [self::class, 'update']);
            $g->delete('/{id}',            [self::class, 'delete']);
            $g->post('/{id}/tasks',        [self::class, 'addTask']);
            $g->patch('/{id}/tasks/{tid}', [self::class, 'updateTask']);
            $g->delete('/{id}/tasks/{tid}',[self::class, 'deleteTask']);
        })->add(new AuthMiddleware());
    }

    public static function list(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $pdo = Database::pdo();
        $steps = $pdo->prepare(
            'SELECT * FROM roadmap_steps WHERE user_id = ? ORDER BY (date IS NULL), date ASC, sort_order ASC, id ASC'
        );
        $steps->execute([$uid]);
        $rows = $steps->fetchAll();
        if (!$rows) return Json::ok($res, ['steps' => []]);

        $ids = array_map(static fn($r) => (int)$r['id'], $rows);
        $place = implode(',', array_fill(0, count($ids), '?'));
        $ts = $pdo->prepare("SELECT * FROM roadmap_tasks WHERE step_id IN ($place) ORDER BY sort_order ASC, id ASC");
        $ts->execute($ids);
        $byStep = [];
        foreach ($ts->fetchAll() as $t) { $byStep[(int)$t['step_id']][] = $t; }

        $out = array_map(static fn($r) => self::shape($r, $byStep[(int)$r['id']] ?? []), $rows);
        return Json::ok($res, ['steps' => $out]);
    }

    public static function create(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        $title = trim((string)($b['title'] ?? ''));
        if ($title === '') return Json::err($res, 'Titel erforderlich', 422);

        Database::pdo()->prepare(
            'INSERT INTO roadmap_steps (user_id, title, description, date, labels, color) VALUES (?, ?, ?, ?, ?, ?)'
        )->execute([
            $uid, mb_substr($title, 0, 300), self::str($b['description'] ?? null),
            self::date($b['date'] ?? null), self::labels($b['labels'] ?? null), self::color($b['color'] ?? null),
        ]);
        $id = (int)Database::pdo()->lastInsertId();
        return Json::ok($res, ['step' => self::shape(self::fetchStep($uid, $id), [])], 201);
    }

    public static function update(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchStep($uid, $id)) return Json::err($res, 'Not found', 404);
        $b = (array) $req->getParsedBody();

        $sets = []; $params = [];
        if (array_key_exists('title', $b)) { $t = trim((string)$b['title']); if ($t === '') return Json::err($res, 'Titel erforderlich', 422); $sets[] = 'title = ?'; $params[] = mb_substr($t, 0, 300); }
        if (array_key_exists('description', $b)) { $sets[] = 'description = ?'; $params[] = self::str($b['description']); }
        if (array_key_exists('date', $b)) { $sets[] = 'date = ?'; $params[] = self::date($b['date']); }
        if (array_key_exists('labels', $b)) { $sets[] = 'labels = ?'; $params[] = self::labels($b['labels']); }
        if (array_key_exists('color', $b)) { $sets[] = 'color = ?'; $params[] = self::color($b['color']); }
        if (array_key_exists('completed', $b)) {
            $done = !empty($b['completed']);
            $sets[] = 'completed = ?'; $params[] = $done ? 1 : 0;
            $sets[] = 'completed_at = ' . ($done ? 'CURRENT_TIMESTAMP' : 'NULL');
        }
        if ($sets) { $params[] = $id; $params[] = $uid; Database::pdo()->prepare('UPDATE roadmap_steps SET ' . implode(', ', $sets) . ' WHERE id = ? AND user_id = ?')->execute($params); }
        return Json::ok($res, ['step' => self::shape(self::fetchStep($uid, $id), self::tasksFor($id))]);
    }

    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchStep($uid, $id)) return Json::err($res, 'Not found', 404);
        Database::pdo()->prepare('DELETE FROM roadmap_steps WHERE id = ? AND user_id = ?')->execute([$id, $uid]);
        return Json::ok($res, ['ok' => true]);
    }

    public static function addTask(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchStep($uid, $id)) return Json::err($res, 'Not found', 404);
        $b = (array) $req->getParsedBody();
        $title = trim((string)($b['title'] ?? ''));
        if ($title === '') return Json::err($res, 'Titel erforderlich', 422);
        Database::pdo()->prepare('INSERT INTO roadmap_tasks (step_id, user_id, title) VALUES (?, ?, ?)')
            ->execute([$id, $uid, mb_substr($title, 0, 300)]);
        return Json::ok($res, ['step' => self::shape(self::fetchStep($uid, $id), self::tasksFor($id))], 201);
    }

    public static function updateTask(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id']; $tid = (int)$args['tid'];
        if (!self::fetchStep($uid, $id)) return Json::err($res, 'Not found', 404);
        $b = (array) $req->getParsedBody();
        $sets = []; $params = [];
        if (array_key_exists('title', $b)) { $t = trim((string)$b['title']); if ($t === '') return Json::err($res, 'Titel erforderlich', 422); $sets[] = 'title = ?'; $params[] = mb_substr($t, 0, 300); }
        if (array_key_exists('completed', $b)) {
            $done = !empty($b['completed']);
            $sets[] = 'completed = ?'; $params[] = $done ? 1 : 0;
            $sets[] = 'completed_at = ' . ($done ? 'CURRENT_TIMESTAMP' : 'NULL');
        }
        if ($sets) { $params[] = $tid; $params[] = $id; $params[] = $uid; Database::pdo()->prepare('UPDATE roadmap_tasks SET ' . implode(', ', $sets) . ' WHERE id = ? AND step_id = ? AND user_id = ?')->execute($params); }
        return Json::ok($res, ['step' => self::shape(self::fetchStep($uid, $id), self::tasksFor($id))]);
    }

    public static function deleteTask(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id']; $tid = (int)$args['tid'];
        if (!self::fetchStep($uid, $id)) return Json::err($res, 'Not found', 404);
        Database::pdo()->prepare('DELETE FROM roadmap_tasks WHERE id = ? AND step_id = ? AND user_id = ?')->execute([$tid, $id, $uid]);
        return Json::ok($res, ['step' => self::shape(self::fetchStep($uid, $id), self::tasksFor($id))]);
    }

    // ───── helpers ───────────────────────────────────────────────────────────
    private static function str($v): ?string { if ($v === null) return null; $v = trim((string)$v); return $v === '' ? null : $v; }
    private static function date($v): ?string { if ($v === null || $v === '') return null; $v = (string)$v; return preg_match('/^\d{4}-\d{2}-\d{2}$/', $v) ? $v : null; }
    private static function color($v): string { return in_array($v, self::COLORS, true) ? (string)$v : 'violet'; }
    private static function labels($v): ?string
    {
        if (is_array($v)) $v = implode(',', $v);
        $v = trim((string)($v ?? ''));
        if ($v === '') return null;
        $parts = array_values(array_filter(array_map('trim', explode(',', $v)), static fn($p) => $p !== ''));
        return $parts ? mb_substr(implode(',', $parts), 0, 500) : null;
    }

    private static function fetchStep(int $uid, int $id): ?array
    {
        $s = Database::pdo()->prepare('SELECT * FROM roadmap_steps WHERE id = ? AND user_id = ?');
        $s->execute([$id, $uid]);
        return $s->fetch() ?: null;
    }

    private static function tasksFor(int $stepId): array
    {
        $s = Database::pdo()->prepare('SELECT * FROM roadmap_tasks WHERE step_id = ? ORDER BY sort_order ASC, id ASC');
        $s->execute([$stepId]);
        return $s->fetchAll();
    }

    private static function shape(array $r, array $tasks): array
    {
        $items = array_map(static fn($t) => [
            'id' => (int)$t['id'], 'title' => $t['title'], 'completed' => (int)$t['completed'],
        ], $tasks);
        $total = count($items);
        $done = count(array_filter($items, static fn($t) => $t['completed']));
        return [
            'id'           => (int)$r['id'],
            'title'        => $r['title'],
            'description'  => $r['description'],
            'date'         => $r['date'],
            'labels'       => $r['labels'] ? explode(',', $r['labels']) : [],
            'color'        => $r['color'],
            'completed'    => (int)$r['completed'],
            'completed_at' => $r['completed_at'],
            'created_at'   => $r['created_at'],
            'tasks'        => $items,
            'progress'     => ['total' => $total, 'done' => $done, 'percent' => $total ? (int)round($done / $total * 100) : 0],
        ];
    }
}
