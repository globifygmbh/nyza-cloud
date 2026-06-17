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
 * Ausgaben (expenses) — receipts/costs with VAT (Vorsteuer) tracking. Amounts
 * are entered gross; net and tax are derived. Each expense may carry one
 * uploaded receipt (image/PDF). Feeds the later EÜR/UVA evaluation.
 */
final class ExpenseRoutes
{
    private const RECEIPT_MAX = 20 * 1024 * 1024; // 20 MB

    public static function mount(App $app): void
    {
        $app->group('/api/expenses', function (RouteCollectorProxy $g) {
            $g->get('',                  [self::class, 'list']);
            $g->post('',                 [self::class, 'create']);
            $g->patch('/{id}',           [self::class, 'update']);
            $g->delete('/{id}',          [self::class, 'delete']);
            $g->post('/{id}/mark-paid',  [self::class, 'markPaid']);
            $g->post('/{id}/unmark-paid',[self::class, 'unmarkPaid']);
            $g->post('/{id}/receipt',    [self::class, 'uploadReceipt']);
            $g->get('/{id}/receipt',     [self::class, 'getReceipt']);
            $g->delete('/{id}/receipt',  [self::class, 'deleteReceipt']);
        })->add(new AuthMiddleware());
    }

    public static function list(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $qp = $req->getQueryParams();
        $where = 'e.user_id = ?';
        $params = [$uid];
        if (!empty($qp['from']))     { $where .= ' AND e.exp_date >= ?'; $params[] = (string)$qp['from']; }
        if (!empty($qp['to']))       { $where .= ' AND e.exp_date <= ?'; $params[] = (string)$qp['to']; }
        if (!empty($qp['category'])) { $where .= ' AND e.category = ?';  $params[] = (string)$qp['category']; }
        $stmt = Database::pdo()->prepare(
            'SELECT e.*, c.name AS contact_name FROM expenses e '
            . 'LEFT JOIN contacts c ON c.id = e.contact_id '
            . "WHERE $where ORDER BY e.exp_date DESC, e.id DESC LIMIT 1000"
        );
        $stmt->execute($params);
        return Json::ok($res, ['expenses' => array_map([self::class, 'shape'], $stmt->fetchAll())]);
    }

    public static function create(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        $f = self::fields($b, true);
        Database::pdo()->prepare(
            'INSERT INTO expenses (user_id, contact_id, exp_date, vendor, description, category, net, tax_rate, tax, gross, deductible, paid_at) '
            . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([
            $uid, $f['contact_id'], $f['exp_date'], $f['vendor'], $f['description'], $f['category'],
            $f['net'], $f['tax_rate'], $f['tax'], $f['gross'], $f['deductible'], $f['paid_at'],
        ]);
        $id = (int)Database::pdo()->lastInsertId();
        return Json::ok($res, ['expense' => self::shape(self::joined($uid, $id))], 201);
    }

    public static function update(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $cur = self::fetchOne($uid, $id);
        if (!$cur) return Json::err($res, 'Not found', 404);
        $b = (array) $req->getParsedBody();
        // Recompute money if any money-relevant field is present.
        $f = self::fields($b, false, $cur);
        if ($f) {
            $sets = implode(', ', array_map(static fn($k) => "$k = ?", array_keys($f)));
            Database::pdo()->prepare("UPDATE expenses SET $sets WHERE id = ? AND user_id = ?")
                ->execute(array_merge(array_values($f), [$id, $uid]));
        }
        return Json::ok($res, ['expense' => self::shape(self::joined($uid, $id))]);
    }

    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $cur = self::fetchOne($uid, $id);
        if (!$cur) return Json::err($res, 'Not found', 404);
        if (!empty($cur['receipt_path'])) Storage::deleteRel($cur['receipt_path']);
        Database::pdo()->prepare('DELETE FROM expenses WHERE id = ? AND user_id = ?')->execute([$id, $uid]);
        return Json::ok($res, ['ok' => true]);
    }

    public static function markPaid(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchOne($uid, $id)) return Json::err($res, 'Not found', 404);
        $b = (array) $req->getParsedBody();
        $date = self::parseDate($b['paid_date'] ?? null);
        $paidAt = $date !== null ? $date . ' 00:00:00' : date('Y-m-d H:i:s');
        Database::pdo()->prepare('UPDATE expenses SET paid_at = ? WHERE id = ? AND user_id = ?')->execute([$paidAt, $id, $uid]);
        return Json::ok($res, ['expense' => self::shape(self::joined($uid, $id))]);
    }

    public static function unmarkPaid(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchOne($uid, $id)) return Json::err($res, 'Not found', 404);
        Database::pdo()->prepare('UPDATE expenses SET paid_at = NULL WHERE id = ? AND user_id = ?')->execute([$id, $uid]);
        return Json::ok($res, ['expense' => self::shape(self::joined($uid, $id))]);
    }

    public static function uploadReceipt(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $cur = self::fetchOne($uid, $id);
        if (!$cur) return Json::err($res, 'Not found', 404);
        $file = $req->getUploadedFiles()['file'] ?? null;
        if (!$file || $file->getError() !== UPLOAD_ERR_OK) return Json::err($res, 'Keine Datei', 422);
        if ((int)$file->getSize() > self::RECEIPT_MAX) return Json::err($res, 'Beleg zu groß (max 20 MB)', 413);

        $name = $file->getClientFilename() ?: 'beleg.bin';
        $mime = $file->getClientMediaType() ?: 'application/octet-stream';
        if (!empty($cur['receipt_path'])) Storage::deleteRel($cur['receipt_path']);
        $rel = Storage::relPath($uid, $name);
        $file->moveTo(Storage::abs($rel));
        Database::pdo()->prepare('UPDATE expenses SET receipt_path = ?, receipt_name = ?, receipt_mime = ? WHERE id = ? AND user_id = ?')
            ->execute([$rel, mb_substr($name, 0, 255), mb_substr($mime, 0, 100), $id, $uid]);
        return Json::ok($res, ['expense' => self::shape(self::joined($uid, $id))]);
    }

    public static function getReceipt(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $cur = self::fetchOne($uid, $id);
        if (!$cur || empty($cur['receipt_path'])) return Json::err($res, 'Not found', 404);
        $abs = Storage::abs($cur['receipt_path']);
        if (!is_file($abs)) return Json::err($res, 'Not found', 404);

        $download = !empty($req->getQueryParams()['download']);
        $data = (string) file_get_contents($abs);
        while (ob_get_level() > 0) { @ob_end_clean(); }
        header('Content-Type: ' . ($cur['receipt_mime'] ?: 'application/octet-stream'));
        header('Content-Disposition: ' . ($download ? 'attachment' : 'inline') . '; filename="' . addslashes($cur['receipt_name'] ?: 'beleg') . '"');
        header('Content-Length: ' . strlen($data));
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: private, max-age=0, must-revalidate');
        echo $data;
        exit;
    }

    public static function deleteReceipt(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $cur = self::fetchOne($uid, $id);
        if (!$cur) return Json::err($res, 'Not found', 404);
        if (!empty($cur['receipt_path'])) Storage::deleteRel($cur['receipt_path']);
        Database::pdo()->prepare('UPDATE expenses SET receipt_path = NULL, receipt_name = NULL, receipt_mime = NULL WHERE id = ? AND user_id = ?')
            ->execute([$id, $uid]);
        return Json::ok($res, ['expense' => self::shape(self::joined($uid, $id))]);
    }

    // ───── helpers ───────────────────────────────────────────────────────────
    /**
     * Build a column→value map. Money is derived from gross + tax_rate. On create
     * ($defaults), all columns are returned; on update only present keys, with
     * money recomputed if gross or tax_rate changed (using current row as base).
     */
    private static function fields(array $b, bool $defaults, ?array $cur = null): array
    {
        $out = [];
        if (array_key_exists('contact_id', $b) || $defaults) { $v = $b['contact_id'] ?? null; $out['contact_id'] = ($v !== null && $v !== '' && (int)$v > 0) ? (int)$v : null; }
        if (array_key_exists('exp_date', $b) || $defaults) $out['exp_date'] = self::parseDate($b['exp_date'] ?? null) ?? ($defaults ? date('Y-m-d') : null);
        if (array_key_exists('vendor', $b) || $defaults) $out['vendor'] = self::str($b['vendor'] ?? null, 255);
        if (array_key_exists('description', $b) || $defaults) $out['description'] = self::str($b['description'] ?? null, 500);
        if (array_key_exists('category', $b) || $defaults) $out['category'] = self::str($b['category'] ?? null, 64) ?? 'Sonstiges';
        if (array_key_exists('deductible', $b) || $defaults) $out['deductible'] = (array_key_exists('deductible', $b) ? !empty($b['deductible']) : true) ? 1 : 0;
        if (array_key_exists('paid_at', $b)) {
            if (empty($b['paid_at'])) $out['paid_at'] = null;
            else { $d = self::parseDate($b['paid_at']); $out['paid_at'] = $d !== null ? $d . ' 00:00:00' : null; }
        } elseif ($defaults) {
            $out['paid_at'] = null;
        }

        $touchesMoney = array_key_exists('gross', $b) || array_key_exists('tax_rate', $b);
        if ($touchesMoney || $defaults) {
            $gross = round((float)($b['gross'] ?? ($cur['gross'] ?? 0)), 2);
            $rate  = round((float)($b['tax_rate'] ?? ($cur['tax_rate'] ?? 20)), 2);
            $net = $rate > 0 ? round($gross / (1 + $rate / 100), 2) : $gross;
            $tax = round($gross - $net, 2);
            $out['net'] = $net;
            $out['tax_rate'] = $rate;
            $out['tax'] = $tax;
            $out['gross'] = $gross;
        }
        return $out;
    }

    private static function str($v, int $max): ?string
    {
        if ($v === null) return null;
        $v = trim((string)$v);
        return $v === '' ? null : mb_substr($v, 0, $max);
    }

    private static function parseDate($v): ?string
    {
        if ($v === null || $v === '') return null;
        $v = (string)$v;
        return preg_match('/^\d{4}-\d{2}-\d{2}/', $v) ? substr($v, 0, 10) : null;
    }

    private static function fetchOne(int $uid, int $id): ?array
    {
        $s = Database::pdo()->prepare('SELECT * FROM expenses WHERE id = ? AND user_id = ?');
        $s->execute([$id, $uid]);
        return $s->fetch() ?: null;
    }

    private static function joined(int $uid, int $id): array
    {
        $s = Database::pdo()->prepare('SELECT e.*, c.name AS contact_name FROM expenses e LEFT JOIN contacts c ON c.id = e.contact_id WHERE e.id = ? AND e.user_id = ?');
        $s->execute([$id, $uid]);
        return $s->fetch() ?: [];
    }

    private static function shape(array $r): array
    {
        return [
            'id'           => (int)$r['id'],
            'contact_id'   => $r['contact_id'] !== null ? (int)$r['contact_id'] : null,
            'contact_name' => $r['contact_name'] ?? null,
            'exp_date'     => $r['exp_date'],
            'vendor'       => $r['vendor'],
            'description'  => $r['description'],
            'category'     => $r['category'],
            'net'          => (float)$r['net'],
            'tax_rate'     => (float)$r['tax_rate'],
            'tax'          => (float)$r['tax'],
            'gross'        => (float)$r['gross'],
            'deductible'   => (int)$r['deductible'],
            'paid_at'      => $r['paid_at'],
            'has_receipt'  => !empty($r['receipt_path']),
            'receipt_name' => $r['receipt_name'] ?? null,
            'receipt_mime' => $r['receipt_mime'] ?? null,
            'created_at'   => $r['created_at'],
        ];
    }
}
