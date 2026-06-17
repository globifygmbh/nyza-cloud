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
 * Recurring billing — subscriptions spawn periods (one billing cycle each).
 * Exactly one open (unpaid) period exists per active subscription; paying it
 * advances the cycle and creates the next. A period can be turned into a real
 * invoice document (DocumentRoutes::createInvoice).
 */
final class SubscriptionRoutes
{
    private const INTERVALS = ['monthly', 'quarterly', 'yearly'];

    public static function mount(App $app): void
    {
        $app->group('/api/subscriptions', function (RouteCollectorProxy $g) {
            $g->get('',                [self::class, 'list']);
            $g->post('',               [self::class, 'create']);
            $g->get('/{id}/periods',   [self::class, 'periods']);
            $g->patch('/{id}',         [self::class, 'update']);
            $g->delete('/{id}',        [self::class, 'delete']);
        })->add(new AuthMiddleware());

        $app->group('/api/periods', function (RouteCollectorProxy $g) {
            $g->post('/{id}/mark-paid',   [self::class, 'periodMarkPaid']);
            $g->post('/{id}/unmark-paid', [self::class, 'periodUnmarkPaid']);
            $g->post('/{id}/invoice',     [self::class, 'periodInvoice']);
        })->add(new AuthMiddleware());
    }

    public static function list(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $pdo = Database::pdo();
        // Keep one open period per active subscription before listing.
        $all = $pdo->prepare('SELECT * FROM subscriptions WHERE company_id = ?');
        $all->execute([$cid]);
        $subs = $all->fetchAll();
        foreach ($subs as $s) { if ((int)$s['active'] === 1) self::ensureCurrentPeriod($s); }

        $stmt = $pdo->prepare(
            'SELECT s.*, c.name AS contact_name FROM subscriptions s '
            . 'LEFT JOIN contacts c ON c.id = s.contact_id WHERE s.company_id = ? '
            . 'ORDER BY s.active DESC, s.name ASC'
        );
        $stmt->execute([$cid]);
        $out = array_map([self::class, 'shape'], $stmt->fetchAll());
        return Json::ok($res, ['subscriptions' => $out]);
    }

    public static function create(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $b = (array) $req->getParsedBody();
        $name = trim((string)($b['name'] ?? ''));
        if ($name === '') return Json::err($res, 'Name erforderlich', 422);

        $f = self::fields($b, true);
        $pdo = Database::pdo();
        $pdo->prepare(
            'INSERT INTO subscriptions (user_id, company_id, contact_id, name, description, interval_unit, net_price, tax_rate, active, start_date) '
            . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([$uid, $cid, $f['contact_id'], mb_substr($name, 0, 255), $f['description'], $f['interval_unit'], $f['net_price'], $f['tax_rate'], $f['active'], $f['start_date']]);
        $id = (int)$pdo->lastInsertId();
        $row = self::fetchOne($cid, $id);
        if ((int)$row['active'] === 1) self::ensureCurrentPeriod($row);
        return Json::ok($res, ['subscription' => self::shape(self::joined($cid, $id))], 201);
    }

    public static function update(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $id = (int)$args['id'];
        if (!self::fetchOne($cid, $id)) return Json::err($res, 'Not found', 404);
        $b = (array) $req->getParsedBody();
        if (array_key_exists('name', $b) && trim((string)$b['name']) === '') return Json::err($res, 'Name erforderlich', 422);

        $map = self::fields($b, false);
        if ($map) {
            $sets = implode(', ', array_map(static fn($k) => "$k = ?", array_keys($map)));
            $params = array_merge(array_values($map), [$id, $cid]);
            Database::pdo()->prepare("UPDATE subscriptions SET $sets WHERE id = ? AND company_id = ?")->execute($params);
        }
        $row = self::fetchOne($cid, $id);
        if ((int)$row['active'] === 1) self::ensureCurrentPeriod($row);
        return Json::ok($res, ['subscription' => self::shape(self::joined($cid, $id))]);
    }

    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $id = (int)$args['id'];
        if (!self::fetchOne($cid, $id)) return Json::err($res, 'Not found', 404);
        Database::pdo()->prepare('DELETE FROM subscriptions WHERE id = ? AND company_id = ?')->execute([$id, $cid]);
        return Json::ok($res, ['ok' => true]);
    }

    public static function periods(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $id = (int)$args['id'];
        if (!self::fetchOne($cid, $id)) return Json::err($res, 'Not found', 404);
        $stmt = Database::pdo()->prepare('SELECT * FROM subscription_periods WHERE subscription_id = ? AND company_id = ? ORDER BY due_date DESC, id DESC');
        $stmt->execute([$id, $cid]);
        return Json::ok($res, ['periods' => array_map([self::class, 'shapePeriod'], $stmt->fetchAll())]);
    }

    public static function periodMarkPaid(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $p = self::fetchPeriod($cid, (int)$args['id']);
        if (!$p) return Json::err($res, 'Not found', 404);
        $b = (array) $req->getParsedBody();
        $date = self::parseDate($b['paid_date'] ?? null);
        $paidAt = $date !== null ? $date . ' 00:00:00' : date('Y-m-d H:i:s');
        Database::pdo()->prepare('UPDATE subscription_periods SET paid_at = ? WHERE id = ? AND company_id = ?')
            ->execute([$paidAt, (int)$p['id'], $cid]);
        // Paying the open period rolls the cycle forward.
        $sub = self::fetchOne($cid, (int)$p['subscription_id']);
        if ($sub && (int)$sub['active'] === 1) self::ensureCurrentPeriod($sub);
        return Json::ok($res, ['period' => self::shapePeriod(self::fetchPeriod($cid, (int)$p['id']))]);
    }

    public static function periodUnmarkPaid(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $p = self::fetchPeriod($cid, (int)$args['id']);
        if (!$p) return Json::err($res, 'Not found', 404);
        Database::pdo()->prepare('UPDATE subscription_periods SET paid_at = NULL WHERE id = ? AND company_id = ?')
            ->execute([(int)$p['id'], $cid]);
        return Json::ok($res, ['period' => self::shapePeriod(self::fetchPeriod($cid, (int)$p['id']))]);
    }

    public static function periodInvoice(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $p = self::fetchPeriod($cid, (int)$args['id']);
        if (!$p) return Json::err($res, 'Not found', 404);
        $sub = self::fetchOne($cid, (int)$p['subscription_id']);
        $name = $sub ? $sub['name'] : 'Leistung';
        $period = self::deDate($p['due_date']);
        $docId = DocumentRoutes::createInvoice($uid, $cid, $p['contact_id'] !== null ? (int)$p['contact_id'] : null, [
            ['description' => $name . ' — Abrechnung ' . $period, 'quantity' => 1, 'unit' => 'Pausch.', 'unit_price_net' => (float)$p['net_price'], 'tax_rate' => (float)$p['tax_rate']],
        ]);
        Database::pdo()->prepare('UPDATE subscription_periods SET invoice_id = ? WHERE id = ? AND company_id = ?')
            ->execute([$docId, (int)$p['id'], $cid]);
        return Json::ok($res, ['invoice_id' => $docId], 201);
    }

    // ───── period engine ─────────────────────────────────────────────────────
    /** Ensure exactly one open (unpaid) period exists for an active subscription. */
    private static function ensureCurrentPeriod(array $sub): void
    {
        $pdo = Database::pdo();
        $uid = (int)$sub['user_id'];
        $sid = (int)$sub['id'];
        $latest = $pdo->prepare('SELECT * FROM subscription_periods WHERE subscription_id = ? ORDER BY due_date DESC, id DESC LIMIT 1');
        $latest->execute([$sid]);
        $row = $latest->fetch();

        if (!$row) {
            $due = !empty($sub['start_date']) ? (string)$sub['start_date'] : date('Y-m-d');
            self::insertPeriod($sub, $due);
            return;
        }
        // Only advance when the latest is settled — keep one open period at a time.
        if (!empty($row['paid_at'])) {
            $next = self::advance((string)$row['due_date'], (string)$sub['interval_unit']);
            self::insertPeriod($sub, $next);
        }
    }

    private static function insertPeriod(array $sub, string $due): void
    {
        Database::pdo()->prepare(
            'INSERT INTO subscription_periods (subscription_id, user_id, contact_id, due_date, net_price, tax_rate) VALUES (?, ?, ?, ?, ?, ?)'
        )->execute([(int)$sub['id'], (int)$sub['user_id'], $sub['contact_id'], $due, $sub['net_price'], $sub['tax_rate']]);
    }

    private static function advance(string $date, string $interval): string
    {
        $map = ['monthly' => '+1 month', 'quarterly' => '+3 months', 'yearly' => '+1 year'];
        $mod = $map[$interval] ?? '+1 month';
        try { return (new \DateTimeImmutable($date))->modify($mod)->format('Y-m-d'); }
        catch (\Throwable $e) { return $date; }
    }

    // ───── helpers ───────────────────────────────────────────────────────────
    private static function fields(array $b, bool $defaults): array
    {
        $out = [];
        if (array_key_exists('contact_id', $b) || $defaults) {
            $v = $b['contact_id'] ?? null;
            $out['contact_id'] = ($v !== null && $v !== '' && (int)$v > 0) ? (int)$v : null;
        }
        if (array_key_exists('name', $b)) $out['name'] = mb_substr(trim((string)$b['name']), 0, 255);
        if (array_key_exists('description', $b) || $defaults) { $v = trim((string)($b['description'] ?? '')); $out['description'] = $v === '' ? null : $v; }
        if (array_key_exists('interval_unit', $b) || $defaults) { $v = $b['interval_unit'] ?? 'monthly'; $out['interval_unit'] = in_array($v, self::INTERVALS, true) ? $v : 'monthly'; }
        if (array_key_exists('net_price', $b) || $defaults) $out['net_price'] = round((float)($b['net_price'] ?? 0), 2);
        if (array_key_exists('tax_rate', $b) || $defaults) $out['tax_rate'] = round((float)($b['tax_rate'] ?? 20), 2);
        if (array_key_exists('active', $b) || $defaults) $out['active'] = !empty($b['active']) || (!array_key_exists('active', $b) && $defaults) ? 1 : 0;
        if (array_key_exists('start_date', $b) || $defaults) $out['start_date'] = self::parseDate($b['start_date'] ?? null);
        return $out;
    }

    private static function parseDate($v): ?string
    {
        if ($v === null || $v === '') return null;
        $v = (string)$v;
        return preg_match('/^\d{4}-\d{2}-\d{2}$/', $v) ? $v : null;
    }

    private static function deDate(?string $ymd): string
    {
        if (!$ymd) return '';
        $d = \DateTime::createFromFormat('Y-m-d', substr($ymd, 0, 10));
        return $d ? $d->format('d.m.Y') : (string)$ymd;
    }

    private static function fetchOne(int $uid, int $id): ?array
    {
        $s = Database::pdo()->prepare('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?');
        $s->execute([$id, $uid]);
        return $s->fetch() ?: null;
    }

    private static function joined(int $uid, int $id): array
    {
        $s = Database::pdo()->prepare('SELECT s.*, c.name AS contact_name FROM subscriptions s LEFT JOIN contacts c ON c.id = s.contact_id WHERE s.id = ? AND s.user_id = ?');
        $s->execute([$id, $uid]);
        return $s->fetch() ?: [];
    }

    private static function fetchPeriod(int $uid, int $id): ?array
    {
        $s = Database::pdo()->prepare('SELECT * FROM subscription_periods WHERE id = ? AND user_id = ?');
        $s->execute([$id, $uid]);
        return $s->fetch() ?: null;
    }

    /** Current open (unpaid) period for a subscription, or null. */
    private static function openPeriod(int $sid): ?array
    {
        $s = Database::pdo()->prepare('SELECT * FROM subscription_periods WHERE subscription_id = ? AND paid_at IS NULL ORDER BY due_date ASC, id ASC LIMIT 1');
        $s->execute([$sid]);
        return $s->fetch() ?: null;
    }

    private static function shape(array $r): array
    {
        $open = self::openPeriod((int)$r['id']);
        return [
            'id'            => (int)$r['id'],
            'contact_id'    => $r['contact_id'] !== null ? (int)$r['contact_id'] : null,
            'contact_name'  => $r['contact_name'] ?? null,
            'name'          => $r['name'],
            'description'   => $r['description'],
            'interval_unit' => $r['interval_unit'],
            'net_price'     => (float)$r['net_price'],
            'tax_rate'      => (float)$r['tax_rate'],
            'gross_price'   => round((float)$r['net_price'] * (1 + (float)$r['tax_rate'] / 100), 2),
            'active'        => (int)$r['active'],
            'start_date'    => $r['start_date'],
            'current_period'=> $open ? self::shapePeriod($open) : null,
            'created_at'    => $r['created_at'],
        ];
    }

    private static function shapePeriod(array $p): array
    {
        $gross = round((float)$p['net_price'] * (1 + (float)$p['tax_rate'] / 100), 2);
        return [
            'id'              => (int)$p['id'],
            'subscription_id' => (int)$p['subscription_id'],
            'due_date'        => $p['due_date'],
            'net_price'       => (float)$p['net_price'],
            'tax_rate'        => (float)$p['tax_rate'],
            'gross_price'     => $gross,
            'paid_at'         => $p['paid_at'],
            'invoice_id'      => $p['invoice_id'] !== null ? (int)$p['invoice_id'] : null,
            'status'          => self::periodStatus($p),
        ];
    }

    private static function periodStatus(array $p): string
    {
        if (!empty($p['paid_at'])) return 'paid';
        try {
            $due = new \DateTimeImmutable((string)$p['due_date']);
            $today = new \DateTimeImmutable(date('Y-m-d'));
        } catch (\Throwable $e) { return 'upcoming'; }
        $diff = (int)$today->diff($due)->format('%r%a');
        if ($diff < 0) return 'overdue';
        if ($diff <= 30) return 'due_soon';
        return 'upcoming';
    }
}
