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
 * Auswertung & Statistik — cash-basis (EÜR) figures for a year: income from
 * paid invoices, expenses from paid expenses, profit, USt-Zahllast (collected
 * VAT minus deductible Vorsteuer), open/overdue receivables, recurring MRR/ARR,
 * per-customer revenue, monthly breakdown, plus a German CSV export.
 */
final class ReportRoutes
{
    public static function mount(App $app): void
    {
        $app->group('/api/reports', function (RouteCollectorProxy $g) {
            $g->get('',       [self::class, 'report']);
            $g->get('/datev', [self::class, 'datev']);
        })->add(new AuthMiddleware());
    }

    public static function report(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $year = self::year($req);
        $from = "$year-01-01"; $to = "$year-12-31";
        $pdo = Database::pdo();

        // Income: paid invoices, recognised at payment date.
        $inc = self::row($pdo, 'SELECT COALESCE(SUM(net),0) net, COALESCE(SUM(tax),0) tax, COALESCE(SUM(gross),0) gross, COUNT(*) cnt '
            . "FROM documents WHERE user_id=? AND type='invoice' AND paid_at IS NOT NULL AND DATE(paid_at) BETWEEN ? AND ?", [$uid, $from, $to]);
        // Expenses: paid expenses; Vorsteuer only counts when deductible.
        $exp = self::row($pdo, 'SELECT COALESCE(SUM(net),0) net, COALESCE(SUM(CASE WHEN deductible=1 THEN tax ELSE 0 END),0) vst, COALESCE(SUM(gross),0) gross, COUNT(*) cnt '
            . 'FROM expenses WHERE user_id=? AND paid_at IS NOT NULL AND DATE(paid_at) BETWEEN ? AND ?', [$uid, $from, $to]);

        $incomeNet = (float)$inc['net']; $incomeTax = (float)$inc['tax'];
        $expenseNet = (float)$exp['net']; $vst = (float)$exp['vst'];

        // Open / overdue receivables (current state, not year-bound).
        $term = self::paymentTermDays($uid);
        $open = self::row($pdo, "SELECT COALESCE(SUM(gross),0) total, COUNT(*) cnt FROM documents WHERE user_id=? AND type='invoice' AND paid_at IS NULL", [$uid]);
        $over = self::row($pdo, "SELECT COALESCE(SUM(gross),0) total, COUNT(*) cnt FROM documents WHERE user_id=? AND type='invoice' AND paid_at IS NULL AND doc_date IS NOT NULL AND DATE_ADD(doc_date, INTERVAL ? DAY) < CURDATE()", [$uid, $term]);

        // Recurring revenue (active subscriptions, normalised to monthly).
        $mrr = 0.0;
        $rs = $pdo->prepare('SELECT interval_unit, COALESCE(SUM(net_price),0) s, COUNT(*) c FROM subscriptions WHERE user_id=? AND active=1 GROUP BY interval_unit');
        $rs->execute([$uid]);
        $activeSubs = 0;
        foreach ($rs->fetchAll() as $r) {
            $activeSubs += (int)$r['c'];
            $div = ['monthly' => 1, 'quarterly' => 3, 'yearly' => 12][$r['interval_unit']] ?? 1;
            $mrr += (float)$r['s'] / $div;
        }
        $mrr = round($mrr, 2);

        // Revenue per customer (paid invoices in year).
        $bc = $pdo->prepare(
            'SELECT d.contact_id, c.name, COALESCE(SUM(d.net),0) net, COALESCE(SUM(d.gross),0) gross, COUNT(*) cnt '
            . 'FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id '
            . "WHERE d.user_id=? AND d.type='invoice' AND d.paid_at IS NOT NULL AND DATE(d.paid_at) BETWEEN ? AND ? "
            . 'GROUP BY d.contact_id, c.name ORDER BY net DESC LIMIT 12'
        );
        $bc->execute([$uid, $from, $to]);
        $byCustomer = array_map(static fn($r) => [
            'name'  => $r['name'] ?: 'Ohne Kunde',
            'net'   => (float)$r['net'],
            'gross' => (float)$r['gross'],
            'count' => (int)$r['cnt'],
        ], $bc->fetchAll());

        // Monthly income/expense net (cash basis).
        $monthly = [];
        for ($m = 1; $m <= 12; $m++) $monthly[$m] = ['month' => $m, 'income_net' => 0.0, 'expense_net' => 0.0, 'profit' => 0.0];
        $mi = $pdo->prepare("SELECT MONTH(paid_at) m, COALESCE(SUM(net),0) s FROM documents WHERE user_id=? AND type='invoice' AND paid_at IS NOT NULL AND YEAR(paid_at)=? GROUP BY m");
        $mi->execute([$uid, $year]);
        foreach ($mi->fetchAll() as $r) { $monthly[(int)$r['m']]['income_net'] = (float)$r['s']; }
        $me = $pdo->prepare('SELECT MONTH(paid_at) m, COALESCE(SUM(net),0) s FROM expenses WHERE user_id=? AND paid_at IS NOT NULL AND YEAR(paid_at)=? GROUP BY m');
        $me->execute([$uid, $year]);
        foreach ($me->fetchAll() as $r) { $monthly[(int)$r['m']]['expense_net'] = (float)$r['s']; }
        foreach ($monthly as &$mm) { $mm['profit'] = round($mm['income_net'] - $mm['expense_net'], 2); }
        unset($mm);

        // VAT broken down per rate. Income from invoice items (items may mix
        // rates); expense Vorsteuer from the expense rate, split deductible/not.
        $ir = $pdo->prepare(
            'SELECT i.tax_rate rate, COALESCE(SUM(ROUND(i.quantity*i.unit_price_net,2)),0) net, '
            . 'COALESCE(SUM(ROUND(ROUND(i.quantity*i.unit_price_net,2)*i.tax_rate/100,2)),0) tax '
            . 'FROM document_items i JOIN documents d ON d.id=i.document_id '
            . "WHERE d.user_id=? AND d.type='invoice' AND d.paid_at IS NOT NULL AND DATE(d.paid_at) BETWEEN ? AND ? "
            . 'GROUP BY i.tax_rate ORDER BY i.tax_rate DESC'
        );
        $ir->execute([$uid, $from, $to]);
        $incomeByRate = array_map(static fn($r) => [
            'rate' => (float)$r['rate'], 'net' => round((float)$r['net'], 2), 'tax' => round((float)$r['tax'], 2),
        ], $ir->fetchAll());

        $er = $pdo->prepare(
            'SELECT tax_rate rate, COALESCE(SUM(net),0) net, '
            . 'COALESCE(SUM(CASE WHEN deductible=1 THEN tax ELSE 0 END),0) vst, '
            . 'COALESCE(SUM(CASE WHEN deductible=0 THEN tax ELSE 0 END),0) tax_nondeduct, '
            . 'COALESCE(SUM(gross),0) gross '
            . 'FROM expenses WHERE user_id=? AND paid_at IS NOT NULL AND DATE(paid_at) BETWEEN ? AND ? '
            . 'GROUP BY tax_rate ORDER BY tax_rate DESC'
        );
        $er->execute([$uid, $from, $to]);
        $expenseByRate = array_map(static fn($r) => [
            'rate' => (float)$r['rate'], 'net' => round((float)$r['net'], 2),
            'vst' => round((float)$r['vst'], 2), 'tax_nondeduct' => round((float)$r['tax_nondeduct'], 2),
            'gross' => round((float)$r['gross'], 2),
        ], $er->fetchAll());

        return Json::ok($res, [
            'year'     => $year,
            'income'   => ['net' => round($incomeNet, 2), 'tax' => round($incomeTax, 2), 'gross' => round((float)$inc['gross'], 2), 'count' => (int)$inc['cnt']],
            'expense'  => ['net' => round($expenseNet, 2), 'vst' => round($vst, 2), 'gross' => round((float)$exp['gross'], 2), 'count' => (int)$exp['cnt']],
            'profit'   => round($incomeNet - $expenseNet, 2),
            'ust_zahllast' => round($incomeTax - $vst, 2),
            'open'     => ['total' => round((float)$open['total'], 2), 'count' => (int)$open['cnt']],
            'overdue'  => ['total' => round((float)$over['total'], 2), 'count' => (int)$over['cnt']],
            'recurring'=> ['mrr' => $mrr, 'arr' => round($mrr * 12, 2), 'active' => $activeSubs],
            'monthly'  => array_values($monthly),
            'by_customer' => $byCustomer,
            'income_by_rate' => $incomeByRate,
            'expense_by_rate' => $expenseByRate,
        ]);
    }

    public static function datev(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $year = self::year($req);
        $from = "$year-01-01"; $to = "$year-12-31";
        $pdo = Database::pdo();

        $rows = [];
        $rows[] = ['Datum', 'Belegnummer', 'Bezeichnung', 'Partner', 'Kategorie', 'Netto', 'USt-Satz', 'USt', 'Brutto', 'Art', 'Bezahlt am'];

        $inv = $pdo->prepare('SELECT d.*, c.name AS contact_name FROM documents d LEFT JOIN contacts c ON c.id=d.contact_id '
            . "WHERE d.user_id=? AND d.type='invoice' AND d.doc_date BETWEEN ? AND ? ORDER BY d.doc_date ASC, d.id ASC");
        $inv->execute([$uid, $from, $to]);
        foreach ($inv->fetchAll() as $d) {
            $snap = json_decode((string)($d['client_snapshot'] ?? ''), true);
            $partner = $d['contact_name'] ?: (is_array($snap) ? ($snap['name'] ?? '') : '');
            $rate = self::dominantRate($d['net'], $d['tax']);
            $rows[] = [
                self::de($d['doc_date']), $d['number'], 'Rechnung', $partner, 'Erlöse',
                self::n($d['net']), $rate, self::n($d['tax']), self::n($d['gross']), 'Einnahme',
                $d['paid_at'] ? self::de(substr((string)$d['paid_at'], 0, 10)) : '',
            ];
        }

        $exp = $pdo->prepare('SELECT e.*, c.name AS contact_name FROM expenses e LEFT JOIN contacts c ON c.id=e.contact_id '
            . 'WHERE e.user_id=? AND e.exp_date BETWEEN ? AND ? ORDER BY e.exp_date ASC, e.id ASC');
        $exp->execute([$uid, $from, $to]);
        foreach ($exp->fetchAll() as $e) {
            $partner = $e['vendor'] ?: ($e['contact_name'] ?: '');
            $rows[] = [
                self::de($e['exp_date']), (string)$e['id'], $e['description'] ?: 'Ausgabe', $partner, $e['category'],
                self::n($e['net']), self::n($e['tax_rate']), self::n($e['tax']), self::n($e['gross']),
                $e['deductible'] ? 'Ausgabe' : 'Ausgabe (o. VSt)',
                $e['paid_at'] ? self::de(substr((string)$e['paid_at'], 0, 10)) : '',
            ];
        }

        $csv = "\xEF\xBB\xBF"; // UTF-8 BOM for Excel
        foreach ($rows as $r) {
            $csv .= implode(';', array_map(static fn($c) => '"' . str_replace('"', '""', (string)$c) . '"', $r)) . "\r\n";
        }

        $download = !empty($req->getQueryParams()['download']);
        while (ob_get_level() > 0) { @ob_end_clean(); }
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: ' . ($download ? 'attachment' : 'inline') . '; filename="datev-' . $year . '.csv"');
        header('Content-Length: ' . strlen($csv));
        header('Cache-Control: private, max-age=0, must-revalidate');
        echo $csv;
        exit;
    }

    // ───── helpers ───────────────────────────────────────────────────────────
    private static function year(Request $req): int
    {
        $y = (int)($req->getQueryParams()['year'] ?? 0);
        return ($y >= 2000 && $y <= 2100) ? $y : (int)date('Y');
    }

    private static function row(\PDO $pdo, string $sql, array $params): array
    {
        $s = $pdo->prepare($sql);
        $s->execute($params);
        return $s->fetch() ?: [];
    }

    private static function paymentTermDays(int $uid): int
    {
        $s = Database::pdo()->prepare("SELECT data FROM app_settings WHERE user_id=? AND ns='company'");
        $s->execute([$uid]);
        $row = $s->fetch();
        if ($row && $row['data']) {
            $d = json_decode((string)$row['data'], true);
            if (is_array($d) && !empty($d['payment_term_days']) && (int)$d['payment_term_days'] > 0) return (int)$d['payment_term_days'];
        }
        return 14;
    }

    /** Approximate the headline VAT rate from net + tax (for the export column). */
    private static function dominantRate($net, $tax): string
    {
        $net = (float)$net; $tax = (float)$tax;
        if ($net <= 0) return '0';
        $r = round($tax / $net * 100);
        return (string)(int)$r;
    }

    private static function n($v): string { return number_format((float)$v, 2, ',', ''); }

    private static function de(?string $ymd): string
    {
        if (!$ymd) return '';
        $d = \DateTime::createFromFormat('Y-m-d', substr($ymd, 0, 10));
        return $d ? $d->format('d.m.Y') : (string)$ymd;
    }
}
