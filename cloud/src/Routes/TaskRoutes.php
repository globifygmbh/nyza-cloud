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
        $qp = $req->getQueryParams();
        $pdo = Database::pdo();

        // Purge archived tasks older than a week (workspace-wide) before listing.
        $pdo->prepare('DELETE FROM tasks WHERE archived_at IS NOT NULL AND archived_at < (NOW() - INTERVAL 7 DAY)')->execute([]);

        // Shared board: all members' tasks, with optional filters.
        $where = 't.archived_at IS NULL';
        $params = [];
        if (!empty($qp['assignee'])) { $where .= ' AND t.assignee_id = ?'; $params[] = (int)$qp['assignee']; }
        if (!empty($qp['owner']))    { $where .= ' AND t.user_id = ?';     $params[] = (int)$qp['owner']; }
        if (!empty($qp['mine']))     { $where .= ' AND (t.assignee_id = ? OR t.user_id = ?)'; $params[] = $uid; $params[] = $uid; }
        $stmt = $pdo->prepare(
            'SELECT t.*, cu.name AS created_by_name, au.name AS assignee_name FROM tasks t '
            . 'LEFT JOIN users cu ON cu.id = t.user_id LEFT JOIN users au ON au.id = t.assignee_id '
            . "WHERE $where ORDER BY (t.due_date IS NULL), t.due_date ASC, t.priority DESC, t.id DESC"
        );
        $stmt->execute($params);
        return Json::ok($res, ['tasks' => array_map([self::class, 'shape'], $stmt->fetchAll())]);
    }

    public static function archived(Request $req, Response $res): Response
    {
        $stmt = Database::pdo()->prepare(
            'SELECT t.*, cu.name AS created_by_name, au.name AS assignee_name FROM tasks t '
            . 'LEFT JOIN users cu ON cu.id = t.user_id LEFT JOIN users au ON au.id = t.assignee_id '
            . 'WHERE t.archived_at IS NOT NULL ORDER BY t.archived_at DESC'
        );
        $stmt->execute([]);
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

        $dueTime = self::parseTime($b, $hasTimeErr);
        if ($hasTimeErr) return Json::err($res, 'Ungültige Uhrzeit', 422);
        if ($due === null) $dueTime = null; // a time without a date makes no sense

        $priority = self::clampPriority($b['priority'] ?? 1);
        $assignee = self::validUser($b['assignee_id'] ?? null);

        $stmt = Database::pdo()->prepare(
            'INSERT INTO tasks (user_id, title, notes, due_date, due_time, priority, assignee_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([$uid, $title, $notes, $due, $dueTime, $priority, $assignee]);
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
            // Dropping the date clears any time too.
            if ($due === null) { $sets[] = 'due_time = ?'; $params[] = null; }
        }
        if (array_key_exists('due_time', $b)) {
            $dueTime = self::parseTime($b, $hasTimeErr);
            if ($hasTimeErr) return Json::err($res, 'Ungültige Uhrzeit', 422);
            $sets[] = 'due_time = ?';
            $params[] = $dueTime;
        }
        if (array_key_exists('priority', $b)) {
            $sets[] = 'priority = ?';
            $params[] = self::clampPriority($b['priority']);
        }
        if (array_key_exists('assignee_id', $b)) {
            $sets[] = 'assignee_id = ?';
            $params[] = self::validUser($b['assignee_id']);
        }

        if ($sets) {
            $sets[] = 'updated_at = CURRENT_TIMESTAMP';
            $sql = 'UPDATE tasks SET ' . implode(', ', $sets) . ' WHERE id = ?';
            $params[] = $id;
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
            'UPDATE tasks SET done_at = CURRENT_TIMESTAMP, archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        )->execute([$id]);
        return Json::ok($res, ['task' => self::shape(self::fetchOne($uid, $id))]);
    }

    public static function restore(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchOne($uid, $id)) return Json::err($res, 'Not found', 404);

        Database::pdo()->prepare(
            'UPDATE tasks SET done_at = NULL, archived_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        )->execute([$id]);
        return Json::ok($res, ['task' => self::shape(self::fetchOne($uid, $id))]);
    }

    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchOne($uid, $id)) return Json::err($res, 'Not found', 404);

        Database::pdo()->prepare('DELETE FROM tasks WHERE id = ?')->execute([$id]);
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

    /**
     * Read the body's `due_time`: '' or null → NULL, an HH:MM(:SS) string →
     * normalised to HH:MM:SS. Sets $err on a malformed non-empty value.
     */
    private static function parseTime(array $b, ?bool &$err): ?string
    {
        $err = false;
        $v = $b['due_time'] ?? null;
        if ($v === null || $v === '') return null;
        $v = (string)$v;
        if (!preg_match('/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/', $v)) {
            $err = true;
            return null;
        }
        return strlen($v) === 5 ? $v . ':00' : $v;
    }

    /** Cast to int and clamp into the 0..2 priority range. */
    private static function clampPriority($v): int
    {
        $p = (int)$v;
        if ($p < 0) return 0;
        if ($p > 2) return 2;
        return $p;
    }

    /** Validate an assignee id is an existing user, else null. */
    private static function validUser($v): ?int
    {
        if ($v === null || $v === '' || (int)$v <= 0) return null;
        $s = Database::pdo()->prepare('SELECT 1 FROM users WHERE id = ?');
        $s->execute([(int)$v]);
        return $s->fetch() ? (int)$v : null;
    }

    private static function fetchOne(int $uid, int $id): ?array
    {
        $stmt = Database::pdo()->prepare(
            'SELECT t.*, cu.name AS created_by_name, au.name AS assignee_name FROM tasks t '
            . 'LEFT JOIN users cu ON cu.id = t.user_id LEFT JOIN users au ON au.id = t.assignee_id WHERE t.id = ?'
        );
        $stmt->execute([$id]);
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
            'due_time'    => $row['due_time'] ?? null,
            'priority'    => (int)$row['priority'],
            'done_at'     => $row['done_at'],
            'archived_at' => $row['archived_at'],
            'created_at'  => $row['created_at'],
            'assignee_id' => isset($row['assignee_id']) && $row['assignee_id'] !== null ? (int)$row['assignee_id'] : null,
            'assignee_name' => $row['assignee_name'] ?? null,
            'created_by'  => isset($row['user_id']) ? (int)$row['user_id'] : null,
            'created_by_name' => $row['created_by_name'] ?? null,
        ];
    }
}
