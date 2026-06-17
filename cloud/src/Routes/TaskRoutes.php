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

final class TaskRoutes
{
    public static function mount(App $app): void
    {
        $app->group('/api/tasks', function (RouteCollectorProxy $g) {
            $g->get('',              [self::class, 'list']);
            $g->get('/archived',     [self::class, 'archived']);
            $g->post('',             [self::class, 'create']);
            $g->patch('/{id}',       [self::class, 'update']);
            $g->post('/{id}/done',   [self::class, 'done']);
            $g->post('/{id}/restore',[self::class, 'restore']);
            $g->delete('/{id}',      [self::class, 'delete']);
        })->add(new AuthMiddleware());
    }

    public static function list(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $pdo = Database::pdo();

        // Purge archived tasks older than a week before listing the active ones.
        $pdo->prepare('DELETE FROM tasks WHERE user_id = ? AND archived_at IS NOT NULL AND archived_at < (NOW() - INTERVAL 7 DAY)')
            ->execute([$uid]);

        $stmt = $pdo->prepare(
            'SELECT * FROM tasks WHERE user_id = ? AND archived_at IS NULL '
            . 'ORDER BY (due_date IS NULL), due_date ASC, priority DESC, id DESC'
        );
        $stmt->execute([$uid]);
        return Json::ok($res, ['tasks' => array_map([self::class, 'shape'], $stmt->fetchAll())]);
    }

    public static function archived(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $stmt = Database::pdo()->prepare(
            'SELECT * FROM tasks WHERE user_id = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC'
        );
        $stmt->execute([$uid]);
        return Json::ok($res, ['tasks' => array_map([self::class, 'shape'], $stmt->fetchAll())]);
    }

    public static function create(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();

        $title = trim((string)($b['title'] ?? ''));
        if ($title === '') return Json::err($res, 'Titel erforderlich', 422);
        if (mb_strlen($title) > 500) $title = mb_substr($title, 0, 500);

        $notes = isset($b['notes']) && $b['notes'] !== null ? (string)$b['notes'] : null;

        $due = self::parseDue($b, $hasDueErr);
        if ($hasDueErr) return Json::err($res, 'Ungültiges Datum', 422);

        $priority = self::clampPriority($b['priority'] ?? 1);

        $stmt = Database::pdo()->prepare(
            'INSERT INTO tasks (user_id, title, notes, due_date, priority) VALUES (?, ?, ?, ?, ?)'
        );
        $stmt->execute([$uid, $title, $notes, $due, $priority]);
        $id = (int)Database::pdo()->lastInsertId();
        return Json::ok($res, ['task' => self::shape(self::fetchOne($uid, $id))], 201);
    }

    public static function update(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $row = self::fetchOne($uid, $id);
        if (!$row) return Json::err($res, 'Not found', 404);

        $b = (array) $req->getParsedBody();
        $sets = [];
        $params = [];

        if (array_key_exists('title', $b)) {
            $title = trim((string)$b['title']);
            if ($title === '') return Json::err($res, 'Titel erforderlich', 422);
            if (mb_strlen($title) > 500) $title = mb_substr($title, 0, 500);
            $sets[] = 'title = ?';
            $params[] = $title;
        }
        if (array_key_exists('notes', $b)) {
            $sets[] = 'notes = ?';
            $params[] = ($b['notes'] !== null && $b['notes'] !== '') ? (string)$b['notes'] : null;
        }
        if (array_key_exists('due_date', $b)) {
            $due = self::parseDue($b, $hasDueErr);
            if ($hasDueErr) return Json::err($res, 'Ungültiges Datum', 422);
            $sets[] = 'due_date = ?';
            $params[] = $due;
        }
        if (array_key_exists('priority', $b)) {
            $sets[] = 'priority = ?';
            $params[] = self::clampPriority($b['priority']);
        }

        if ($sets) {
            $sets[] = 'updated_at = CURRENT_TIMESTAMP';
            $sql = 'UPDATE tasks SET ' . implode(', ', $sets) . ' WHERE id = ? AND user_id = ?';
            $params[] = $id;
            $params[] = $uid;
            Database::pdo()->prepare($sql)->execute($params);
        }
        return Json::ok($res, ['task' => self::shape(self::fetchOne($uid, $id))]);
    }

    public static function done(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchOne($uid, $id)) return Json::err($res, 'Not found', 404);

        Database::pdo()->prepare(
            'UPDATE tasks SET done_at = CURRENT_TIMESTAMP, archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?'
        )->execute([$id, $uid]);
        return Json::ok($res, ['task' => self::shape(self::fetchOne($uid, $id))]);
    }

    public static function restore(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchOne($uid, $id)) return Json::err($res, 'Not found', 404);

        Database::pdo()->prepare(
            'UPDATE tasks SET done_at = NULL, archived_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?'
        )->execute([$id, $uid]);
        return Json::ok($res, ['task' => self::shape(self::fetchOne($uid, $id))]);
    }

    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchOne($uid, $id)) return Json::err($res, 'Not found', 404);

        Database::pdo()->prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?')->execute([$id, $uid]);
        return Json::ok($res, ['ok' => true]);
    }

    /**
     * Read the body's `due_date`: '' or null → NULL, a YYYY-MM-DD string → as-is.
     * Sets $err to true on a malformed (non-empty, non-matching) value.
     */
    private static function parseDue(array $b, ?bool &$err): ?string
    {
        $err = false;
        $v = $b['due_date'] ?? null;
        if ($v === null || $v === '') return null;
        $v = (string)$v;
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $v)) {
            $err = true;
            return null;
        }
        return $v;
    }

    /** Cast to int and clamp into the 0..2 priority range. */
    private static function clampPriority($v): int
    {
        $p = (int)$v;
        if ($p < 0) return 0;
        if ($p > 2) return 2;
        return $p;
    }

    private static function fetchOne(int $uid, int $id): ?array
    {
        $stmt = Database::pdo()->prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?');
        $stmt->execute([$id, $uid]);
        $t = $stmt->fetch();
        return $t ?: null;
    }

    private static function shape(array $row): array
    {
        return [
            'id'          => (int)$row['id'],
            'title'       => $row['title'],
            'notes'       => $row['notes'],
            'due_date'    => $row['due_date'],
            'priority'    => (int)$row['priority'],
            'done_at'     => $row['done_at'],
            'archived_at' => $row['archived_at'],
            'created_at'  => $row['created_at'],
        ];
    }
}
