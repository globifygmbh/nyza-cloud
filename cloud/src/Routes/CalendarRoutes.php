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
 * Calendar events. Datetimes are stored as naive local wall-clock
 * ('Y-m-d H:i:s') — a 14:00 meeting stays 14:00 regardless of timezone. Types:
 * 'event' (timed or all-day) and 'absence' (Urlaub, usually multi-day all-day).
 */
final class CalendarRoutes
{
    private const TYPES = ['event', 'absence'];

    public static function mount(App $app): void
    {
        $app->group('/api/calendar', function (RouteCollectorProxy $g) {
            $g->get('/events',        [self::class, 'list']);
            $g->post('/events',       [self::class, 'create']);
            $g->patch('/events/{id}', [self::class, 'update']);
            $g->delete('/events/{id}',[self::class, 'delete']);
        })->add(new AuthMiddleware());
    }

    public static function list(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $qp = $req->getQueryParams();
        // Shared workspace calendar: everyone sees all events.
        $where = '1=1';
        $params = [];
        // Overlap: event starts before window end AND ends after window start.
        if (!empty($qp['from'])) { $where .= ' AND e.ends_at >= ?';   $params[] = $qp['from'] . ' 00:00:00'; }
        if (!empty($qp['to']))   { $where .= ' AND e.starts_at <= ?'; $params[] = $qp['to'] . ' 23:59:59'; }
        $stmt = Database::pdo()->prepare(
            'SELECT e.*, c.name AS contact_name, u.name AS created_by_name FROM calendar_events e '
            . 'LEFT JOIN contacts c ON c.id = e.contact_id '
            . 'LEFT JOIN users u ON u.id = e.user_id '
            . "WHERE $where ORDER BY e.starts_at ASC"
        );
        $stmt->execute($params);
        return Json::ok($res, ['events' => array_map([self::class, 'shape'], $stmt->fetchAll())]);
    }

    public static function create(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        $title = trim((string)($b['title'] ?? ''));
        if ($title === '') return Json::err($res, 'Titel erforderlich', 422);
        $f = self::fields($b, true);
        Database::pdo()->prepare(
            'INSERT INTO calendar_events (user_id, title, type, all_day, starts_at, ends_at, location, note, color, contact_id, person) '
            . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([$uid, mb_substr($title, 0, 300), $f['type'], $f['all_day'], $f['starts_at'], $f['ends_at'], $f['location'], $f['note'], $f['color'], $f['contact_id'], $f['person']]);
        $id = (int)Database::pdo()->lastInsertId();
        return Json::ok($res, ['event' => self::shape(self::joined($uid, $id))], 201);
    }

    public static function update(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchOne($uid, $id)) return Json::err($res, 'Not found', 404);
        $b = (array) $req->getParsedBody();
        if (array_key_exists('title', $b) && trim((string)$b['title']) === '') return Json::err($res, 'Titel erforderlich', 422);
        $map = self::fields($b, false);
        if (array_key_exists('title', $b)) $map['title'] = mb_substr(trim((string)$b['title']), 0, 300);
        if ($map) {
            $sets = implode(', ', array_map(static fn($k) => "$k = ?", array_keys($map)));
            Database::pdo()->prepare("UPDATE calendar_events SET $sets WHERE id = ?")
                ->execute(array_merge(array_values($map), [$id]));
        }
        return Json::ok($res, ['event' => self::shape(self::joined($uid, $id))]);
    }

    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchOne($uid, $id)) return Json::err($res, 'Not found', 404);
        Database::pdo()->prepare('DELETE FROM calendar_events WHERE id = ?')->execute([$id]);
        return Json::ok($res, ['ok' => true]);
    }

    // ───── helpers ───────────────────────────────────────────────────────────
    private static function fields(array $b, bool $defaults): array
    {
        $out = [];
        if (array_key_exists('type', $b) || $defaults) { $v = $b['type'] ?? 'event'; $out['type'] = in_array($v, self::TYPES, true) ? $v : 'event'; }
        if (array_key_exists('all_day', $b) || $defaults) $out['all_day'] = !empty($b['all_day']) ? 1 : 0;
        if (array_key_exists('starts_at', $b) || $defaults) $out['starts_at'] = self::dt($b['starts_at'] ?? null) ?? date('Y-m-d H:i:s');
        if (array_key_exists('ends_at', $b) || $defaults) $out['ends_at'] = self::dt($b['ends_at'] ?? null) ?? ($out['starts_at'] ?? date('Y-m-d H:i:s'));
        if (array_key_exists('location', $b) || $defaults) $out['location'] = self::str($b['location'] ?? null, 255);
        if (array_key_exists('note', $b) || $defaults) $out['note'] = self::str($b['note'] ?? null, 5000);
        if (array_key_exists('color', $b) || $defaults) { $v = trim((string)($b['color'] ?? 'violet')); $out['color'] = $v === '' ? 'violet' : mb_substr($v, 0, 20); }
        if (array_key_exists('contact_id', $b) || $defaults) { $v = $b['contact_id'] ?? null; $out['contact_id'] = ($v !== null && $v !== '' && (int)$v > 0) ? (int)$v : null; }
        if (array_key_exists('person', $b) || $defaults) $out['person'] = self::str($b['person'] ?? null, 120);
        // Guard: ensure end >= start.
        if (isset($out['starts_at'], $out['ends_at']) && strtotime($out['ends_at']) < strtotime($out['starts_at'])) {
            $out['ends_at'] = $out['starts_at'];
        }
        return $out;
    }

    private static function str($v, int $max): ?string
    {
        if ($v === null) return null;
        $v = trim((string)$v);
        return $v === '' ? null : mb_substr($v, 0, $max);
    }

    /** Accept 'Y-m-d H:i(:s)' or 'Y-m-dTH:i' → 'Y-m-d H:i:s' (naive, no tz shift). */
    private static function dt($v): ?string
    {
        if ($v === null || $v === '') return null;
        $v = str_replace('T', ' ', (string)$v);
        if (preg_match('/^(\d{4}-\d{2}-\d{2})[ ](\d{2}):(\d{2})(?::(\d{2}))?$/', $v, $m)) {
            return $m[1] . ' ' . $m[2] . ':' . $m[3] . ':' . ($m[4] ?? '00');
        }
        if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $v)) return $v . ' 00:00:00';
        $ts = strtotime($v);
        return $ts !== false ? date('Y-m-d H:i:s', $ts) : null;
    }

    private static function fetchOne(int $uid, int $id): ?array
    {
        // Shared calendar: any member may load/edit/delete any event.
        $s = Database::pdo()->prepare('SELECT * FROM calendar_events WHERE id = ?');
        $s->execute([$id]);
        return $s->fetch() ?: null;
    }

    private static function joined(int $uid, int $id): array
    {
        $s = Database::pdo()->prepare('SELECT e.*, c.name AS contact_name, u.name AS created_by_name FROM calendar_events e LEFT JOIN contacts c ON c.id = e.contact_id LEFT JOIN users u ON u.id = e.user_id WHERE e.id = ?');
        $s->execute([$id]);
        return $s->fetch() ?: [];
    }

    private static function shape(array $r): array
    {
        return [
            'id'           => (int)$r['id'],
            'title'        => $r['title'],
            'type'         => $r['type'],
            'all_day'      => (int)$r['all_day'],
            'starts_at'    => $r['starts_at'],
            'ends_at'      => $r['ends_at'],
            'location'     => $r['location'],
            'note'         => $r['note'],
            'color'        => $r['color'],
            'contact_id'   => $r['contact_id'] !== null ? (int)$r['contact_id'] : null,
            'contact_name' => $r['contact_name'] ?? null,
            'person'       => $r['person'],
            'created_by'   => isset($r['user_id']) ? (int)$r['user_id'] : null,
            'created_by_name' => $r['created_by_name'] ?? null,
        ];
    }
}
