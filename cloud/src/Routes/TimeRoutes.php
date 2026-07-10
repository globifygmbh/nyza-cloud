<?php
declare(strict_types=1);

namespace Nyza\Routes;

use Nyza\CompanyContext;
use Nyza\Database;
use Nyza\Json;
use Nyza\Middleware\AuthMiddleware;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;
use Slim\Routing\RouteCollectorProxy;

/**
 * Zeiterfassung / time tracking. A live timer is just a row with ended_at = NULL;
 * at most one runs at a time (starting a new one stops the previous). Manual
 * entries provide both started_at and ended_at. Entries optionally reference a
 * contact (Kunde) from the contacts app.
 */
final class TimeRoutes
{
    public static function mount(App $app): void
    {
        $app->group('/api/time', function (RouteCollectorProxy $g) {
            $g->get('',           [self::class, 'list']);
            $g->get('/running',   [self::class, 'running']);
            $g->get('/billable',  [self::class, 'billable']);
            $g->post('',          [self::class, 'create']);
            $g->post('/start',    [self::class, 'start']);
            $g->post('/invoice',  [self::class, 'invoice']);
            $g->post('/{id}/stop',[self::class, 'stop']);
            $g->patch('/{id}',    [self::class, 'update']);
            $g->delete('/{id}',   [self::class, 'delete']);
        })->add(new AuthMiddleware());
    }

    public static function list(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $qp = $req->getQueryParams();
        // Members may view another member's entries via ?user_id; default = self.
        $target = !empty($qp['user_id']) ? (int)$qp['user_id'] : $uid;
        $where = 't.user_id = ?';
        $params = [$target];
        if (!empty($qp['from'])) { $where .= ' AND DATE(t.started_at) >= ?'; $params[] = (string)$qp['from']; }
        if (!empty($qp['to']))   { $where .= ' AND DATE(t.started_at) <= ?'; $params[] = (string)$qp['to']; }
        $stmt = Database::pdo()->prepare(
            'SELECT t.*, c.name AS contact_name, u.name AS user_name FROM time_entries t '
            . 'LEFT JOIN contacts c ON c.id = t.contact_id '
            . 'LEFT JOIN users u ON u.id = t.user_id '
            . "WHERE $where ORDER BY t.started_at DESC LIMIT 500"
        );
        $stmt->execute($params);
        return Json::ok($res, ['entries' => array_map([self::class, 'shape'], $stmt->fetchAll())]);
    }

    public static function running(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $row = self::runningRow($uid);
        return Json::ok($res, ['entry' => $row ? self::shape($row) : null]);
    }

    public static function start(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        // Only one timer runs at a time — close any open one first.
        Database::pdo()->prepare('UPDATE time_entries SET ended_at = NOW() WHERE user_id = ? AND ended_at IS NULL')
            ->execute([$uid]);

        $task = self::str($b['task'] ?? null);
        $note = self::str($b['note'] ?? null);
        $contact = self::contactId($uid, $b['contact_id'] ?? null);
        Database::pdo()->prepare(
            'INSERT INTO time_entries (user_id, contact_id, task, note, started_at, ended_at) VALUES (?, ?, ?, ?, NOW(), NULL)'
        )->execute([$uid, $contact, $task, $note]);
        $id = (int)Database::pdo()->lastInsertId();
        return Json::ok($res, ['entry' => self::shape(self::fetchJoined($uid, $id))], 201);
    }

    public static function stop(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchOne($uid, $id)) return Json::err($res, 'Not found', 404);
        Database::pdo()->prepare('UPDATE time_entries SET ended_at = NOW() WHERE id = ? AND user_id = ? AND ended_at IS NULL')
            ->execute([$id, $uid]);
        return Json::ok($res, ['entry' => self::shape(self::fetchJoined($uid, $id))]);
    }

    public static function create(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        $start = self::parseDt($b['started_at'] ?? null, $e1);
        $end   = self::parseDt($b['ended_at'] ?? null, $e2);
        if ($e1 || $start === null) return Json::err($res, 'Startzeit erforderlich', 422);
        if ($e2 || $end === null)   return Json::err($res, 'Endzeit erforderlich', 422);
        if (strtotime($end) < strtotime($start)) return Json::err($res, 'Ende liegt vor dem Start', 422);

        $task = self::str($b['task'] ?? null);
        $note = self::str($b['note'] ?? null);
        $contact = self::contactId($uid, $b['contact_id'] ?? null);
        Database::pdo()->prepare(
            'INSERT INTO time_entries (user_id, contact_id, task, note, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)'
        )->execute([$uid, $contact, $task, $note, $start, $end]);
        $id = (int)Database::pdo()->lastInsertId();
        return Json::ok($res, ['entry' => self::shape(self::fetchJoined($uid, $id))], 201);
    }

    public static function update(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchOne($uid, $id)) return Json::err($res, 'Not found', 404);
        $b = (array) $req->getParsedBody();

        $sets = []; $params = [];
        if (array_key_exists('task', $b))    { $sets[] = 'task = ?'; $params[] = self::str($b['task']); }
        if (array_key_exists('note', $b))    { $sets[] = 'note = ?'; $params[] = self::str($b['note']); }
        if (array_key_exists('contact_id', $b)) { $sets[] = 'contact_id = ?'; $params[] = self::contactId($uid, $b['contact_id']); }
        if (array_key_exists('started_at', $b)) {
            $v = self::parseDt($b['started_at'], $er); if ($er || $v === null) return Json::err($res, 'Ungültige Startzeit', 422);
            $sets[] = 'started_at = ?'; $params[] = $v;
        }
        if (array_key_exists('ended_at', $b)) {
            if ($b['ended_at'] === null || $b['ended_at'] === '') { $sets[] = 'ended_at = NULL'; }
            else { $v = self::parseDt($b['ended_at'], $er); if ($er || $v === null) return Json::err($res, 'Ungültige Endzeit', 422); $sets[] = 'ended_at = ?'; $params[] = $v; }
        }
        if ($sets) {
            $params[] = $id; $params[] = $uid;
            Database::pdo()->prepare('UPDATE time_entries SET ' . implode(', ', $sets) . ' WHERE id = ? AND user_id = ?')->execute($params);
        }
        return Json::ok($res, ['entry' => self::shape(self::fetchJoined($uid, $id))]);
    }

    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchOne($uid, $id)) return Json::err($res, 'Not found', 404);
        Database::pdo()->prepare('DELETE FROM time_entries WHERE id = ? AND user_id = ?')->execute([$id, $uid]);
        return Json::ok($res, ['ok' => true]);
    }

    // ───── helpers ───────────────────────────────────────────────────────────
    private static function str($v): ?string
    {
        if ($v === null) return null;
        $v = trim((string)$v);
        return $v === '' ? null : mb_substr($v, 0, 2000);
    }

    /** Validate a contact id belongs to the user; otherwise null. */
    private static function contactId(int $uid, $v): ?int
    {
        if ($v === null || $v === '' || (int)$v <= 0) return null;
        $s = Database::pdo()->prepare('SELECT 1 FROM contacts WHERE id = ? AND user_id = ?');
        $s->execute([(int)$v, $uid]);
        return $s->fetch() ? (int)$v : null;
    }

    /**
     * Parse an incoming datetime (ISO 8601 with offset/Z, or naive) into a UTC
     * 'Y-m-d H:i:s' string so stored times match MySQL NOW() (UTC) and the
     * frontend's UTC-based display. The frontend sends ISO 'Z' for manual
     * entries; strtotime honours the offset, gmdate normalises to UTC.
     */
    private static function parseDt($v, ?bool &$err): ?string
    {
        $err = false;
        if ($v === null || $v === '') return null;
        $ts = strtotime((string)$v);
        if ($ts === false) { $err = true; return null; }
        return gmdate('Y-m-d H:i:s', $ts);
    }

    private static function runningRow(int $uid): ?array
    {
        $s = Database::pdo()->prepare(
            'SELECT t.*, c.name AS contact_name FROM time_entries t LEFT JOIN contacts c ON c.id = t.contact_id '
            . 'WHERE t.user_id = ? AND t.ended_at IS NULL ORDER BY t.started_at DESC LIMIT 1'
        );
        $s->execute([$uid]);
        return $s->fetch() ?: null;
    }

    private static function fetchOne(int $uid, int $id): ?array
    {
        $s = Database::pdo()->prepare('SELECT * FROM time_entries WHERE id = ? AND user_id = ?');
        $s->execute([$id, $uid]);
        return $s->fetch() ?: null;
    }

    private static function fetchJoined(int $uid, int $id): array
    {
        $s = Database::pdo()->prepare(
            'SELECT t.*, c.name AS contact_name FROM time_entries t LEFT JOIN contacts c ON c.id = t.contact_id WHERE t.id = ? AND t.user_id = ?'
        );
        $s->execute([$id, $uid]);
        return $s->fetch() ?: [];
    }

    private static function shape(array $r): array
    {
        $start = $r['started_at'] ?? null;
        $end = $r['ended_at'] ?? null;
        $dur = ($start && $end) ? max(0, strtotime($end) - strtotime($start)) : null;
        return [
            'id'           => (int)$r['id'],
            'contact_id'   => $r['contact_id'] !== null ? (int)$r['contact_id'] : null,
            'contact_name' => $r['contact_name'] ?? null,
            'task'         => $r['task'] ?? null,
            'note'         => $r['note'] ?? null,
            'started_at'   => $start,
            'ended_at'     => $end,
            'duration'     => $dur,
            'running'      => $end === null,
            'invoice_id'   => isset($r['invoice_id']) && $r['invoice_id'] !== null ? (int)$r['invoice_id'] : null,
            'user_id'      => isset($r['user_id']) ? (int)$r['user_id'] : null,
            'user_name'    => $r['user_name'] ?? null,
        ];
    }

    // ───── Billing: time entries → invoice ────────────────────────────────────
    /** Completed entries for a contact, with billing status (for the popup). */
    public static function billable(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $qp = $req->getQueryParams();
        $cid = isset($qp['contact_id']) && $qp['contact_id'] !== '' ? (int)$qp['contact_id'] : 0;
        if ($cid <= 0) return Json::ok($res, ['entries' => []]);
        $stmt = Database::pdo()->prepare(
            'SELECT t.*, d.number AS invoice_number FROM time_entries t '
            . 'LEFT JOIN documents d ON d.id = t.invoice_id '
            . 'WHERE t.user_id = ? AND t.contact_id = ? AND t.ended_at IS NOT NULL '
            . 'ORDER BY t.started_at ASC'
        );
        $stmt->execute([$uid, $cid]);
        $out = array_map(static function (array $r): array {
            $s = self::shape($r);
            $s['invoice_number'] = $r['invoice_number'] ?? null;
            return $s;
        }, $stmt->fetchAll());
        return Json::ok($res, ['entries' => $out]);
    }

    /** Create an invoice from selected (unbilled) time entries at an hourly rate. */
    public static function invoice(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        $cid = (int)($b['contact_id'] ?? 0);
        if ($cid <= 0) return Json::err($res, 'Kunde erforderlich', 422);
        $rate = round((float)($b['hourly_rate'] ?? 0), 2);
        $taxRate = round((float)($b['tax_rate'] ?? 20), 2);
        $ids = array_values(array_unique(array_filter(array_map('intval', (array)($b['entry_ids'] ?? [])), static fn($n) => $n > 0)));
        if (!$ids) return Json::err($res, 'Keine Einträge gewählt', 422);

        $place = implode(',', array_fill(0, count($ids), '?'));
        $stmt = Database::pdo()->prepare(
            "SELECT * FROM time_entries WHERE user_id = ? AND contact_id = ? AND ended_at IS NOT NULL "
            . "AND invoice_id IS NULL AND id IN ($place) ORDER BY started_at ASC"
        );
        $stmt->execute(array_merge([$uid, $cid], $ids));
        $entries = $stmt->fetchAll();
        if (!$entries) return Json::err($res, 'Keine abrechenbaren Einträge', 422);

        $items = [];
        $eligible = [];
        foreach ($entries as $e) {
            $eligible[] = (int)$e['id'];
            $seconds = max(0, strtotime((string)$e['ended_at']) - strtotime((string)$e['started_at']));
            $hours = round($seconds / 3600, 2);
            $when = self::deRange((string)$e['started_at'], (string)$e['ended_at']);
            $task = trim((string)($e['task'] ?? '')) !== '' ? (string)$e['task'] : 'Zeiterfassung';
            $items[] = [
                'description'    => $task . ' (' . $when . ')',
                'quantity'       => $hours,
                'unit'           => 'Std',
                'unit_price_net' => $rate,
                'tax_rate'       => $taxRate,
            ];
        }

        $companyId = CompanyContext::active($req, $uid);
        $pdo = Database::pdo();
        $pdo->beginTransaction();
        try {
            $docId = DocumentRoutes::createInvoice($uid, $companyId, $cid, $items);
            $ph = implode(',', array_fill(0, count($eligible), '?'));
            $pdo->prepare("UPDATE time_entries SET invoice_id = ? WHERE user_id = ? AND id IN ($ph)")
                ->execute(array_merge([$docId, $uid], $eligible));
            $pdo->commit();
        } catch (\Throwable $ex) {
            $pdo->rollBack();
            throw $ex;
        }
        $num = $pdo->prepare('SELECT number FROM documents WHERE id = ?');
        $num->execute([$docId]);
        $number = ($r = $num->fetch()) ? $r['number'] : '';
        return Json::ok($res, ['invoice_id' => $docId, 'number' => $number, 'count' => count($eligible)], 201);
    }

    /** Format a UTC start/end pair as Berlin-local "d.m.Y H:i–H:i". */
    private static function deRange(string $start, string $end): string
    {
        try {
            $tz = new \DateTimeZone(date_default_timezone_get());
            $s = (new \DateTime($start, new \DateTimeZone('UTC')))->setTimezone($tz);
            $e = (new \DateTime($end, new \DateTimeZone('UTC')))->setTimezone($tz);
            return $s->format('d.m.Y H:i') . '–' . $e->format('H:i');
        } catch (\Throwable $ex) {
            return substr($start, 0, 10);
        }
    }
}
