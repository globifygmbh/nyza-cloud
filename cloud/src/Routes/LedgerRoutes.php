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
 * Doppelte Buchführung (Doppik / GmbH-Modus). The ledger is DERIVED on the fly
 * from invoices (accrual: booked at doc_date, paid at paid_at) and expenses,
 * combined with manually stored journal entries. No posting hooks live on the
 * invoice/expense CRUD — everything is recomputed from source data per request.
 *
 * Provides chart of accounts (defaults in code + custom rows), journal, P&L
 * (GuV), trial balance (Saldenliste), balance sheet (Bilanz as of year-end),
 * manual bookings, and a German DATEV-style CSV export (one row per line).
 */
final class LedgerRoutes
{
    /** Default chart of accounts: [number, name, type]. type in the 5 below. */
    private const DEFAULT_ACCOUNTS = [
        ['2000', 'Forderungen aus L+L',          'asset'],
        ['2500', 'Vorsteuer',                    'asset'],
        ['2800', 'Bank / Kassa',                 'asset'],
        ['3300', 'Verbindlichkeiten aus L+L',    'liability'],
        ['3500', 'Umsatzsteuer',                 'liability'],
        ['4000', 'Umsatzerlöse',                 'income'],
        ['5000', 'Wareneinsatz',                 'expense'],
        ['7100', 'Miete & Raumkosten',           'expense'],
        ['7200', 'Werbung & Marketing',          'expense'],
        ['7300', 'Reise- & Kfz-Kosten',          'expense'],
        ['7380', 'Software & Lizenzen',          'expense'],
        ['7400', 'Hardware & GWG',               'expense'],
        ['7600', 'Büro, Telefon, Internet',      'expense'],
        ['7650', 'Beratung, Recht, Gebühren',    'expense'],
        ['7700', 'Sonstiger betrieblicher Aufwand', 'expense'],
        ['9100', 'Eigenkapital / Gewinnvortrag', 'equity'],
        ['9800', 'Jahresergebnis',               'equity'],
    ];

    /** expenses.category (free text) → expense account number. */
    private const CATEGORY_ACCOUNTS = [
        'Wareneinkauf'      => '5000',
        'Hardware'          => '7400',
        'Software'          => '7380',
        'Büro'              => '7600',
        'Werbung/Marketing' => '7200',
        'Reisekosten'       => '7300',
        'Kfz'               => '7300',
        'Beratung/Recht'    => '7650',
        'Miete'             => '7100',
        'Gebühren/Bank'     => '7650',
        'Telefon/Internet'  => '7600',
        'Fortbildung'       => '7700',
    ];

    private const TYPES = ['asset', 'liability', 'equity', 'income', 'expense'];

    public static function mount(App $app): void
    {
        $app->group('/api/ledger', function (RouteCollectorProxy $g) {
            $g->get('/accounts',           [self::class, 'accounts']);
            $g->post('/accounts',          [self::class, 'createAccount']);
            $g->delete('/accounts/{number}', [self::class, 'deleteAccount']);
            $g->get('/journal',            [self::class, 'journal']);
            $g->get('/guv',                [self::class, 'guv']);
            $g->get('/balances',           [self::class, 'balances']);
            $g->get('/balance-sheet',      [self::class, 'balanceSheet']);
            $g->post('/entries',           [self::class, 'createEntry']);
            $g->delete('/entries/{id}',    [self::class, 'deleteEntry']);
            $g->get('/datev',              [self::class, 'datev']);
        })->add(new AuthMiddleware());
    }

    // ───── Chart of accounts ───────────────────────────────────────────────────
    public static function accounts(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        return Json::ok($res, ['accounts' => array_values(self::mergedAccounts($cid))]);
    }

    public static function createAccount(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $b = (array)$req->getParsedBody();
        $number = trim((string)($b['number'] ?? ''));
        $name = trim((string)($b['name'] ?? ''));
        $type = (string)($b['type'] ?? '');
        if ($number === '') return Json::err($res, 'Kontonummer fehlt', 422);
        if (!in_array($type, self::TYPES, true)) return Json::err($res, 'Ungültiger Kontotyp', 422);
        if ($name === '') $name = $number;

        // Upsert custom account (creator user_id kept; scoped per company).
        Database::pdo()->prepare(
            'INSERT INTO ledger_accounts (user_id, company_id, number, name, type) VALUES (?, ?, ?, ?, ?) '
            . 'ON DUPLICATE KEY UPDATE name = VALUES(name), type = VALUES(type), company_id = VALUES(company_id)'
        )->execute([$uid, $cid, $number, $name, $type]);

        return Json::ok($res, ['account' => ['number' => $number, 'name' => $name, 'type' => $type]], 201);
    }

    public static function deleteAccount(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $number = (string)$args['number'];
        foreach (self::DEFAULT_ACCOUNTS as $a) {
            if ($a[0] === $number) return Json::err($res, 'Standardkonto', 422);
        }
        Database::pdo()->prepare('DELETE FROM ledger_accounts WHERE company_id=? AND number=?')->execute([$cid, $number]);
        return Json::ok($res, ['ok' => true]);
    }

    // ───── Journal ─────────────────────────────────────────────────────────────
    public static function journal(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        [$year, $month, $quarter, $from, $to, $label] = self::rangeFor($req);
        $names = self::accountNameMap($cid);
        $entries = self::derive($cid, $from, $to, $names);

        // Sort by date asc, then source.
        usort($entries, static function ($a, $b) {
            return [$a['date'], $a['source']] <=> [$b['date'], $b['source']];
        });

        $td = 0.0; $tc = 0.0;
        foreach ($entries as $e) {
            foreach ($e['lines'] as $l) { $td += (float)$l['debit']; $tc += (float)$l['credit']; }
        }

        return Json::ok($res, [
            'period'  => self::periodShape($year, $month, $quarter, $from, $to, $label),
            'entries' => $entries,
            'totals'  => ['debit' => round($td, 2), 'credit' => round($tc, 2)],
        ]);
    }

    // ───── GuV (P&L) ───────────────────────────────────────────────────────────
    public static function guv(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        [$year, $month, $quarter, $from, $to, $label] = self::rangeFor($req);
        $names = self::accountNameMap($cid);
        $types = self::accountTypeMap($cid);
        $fold = self::foldByAccount(self::derive($cid, $from, $to, $names));

        $income = []; $expense = []; $ti = 0.0; $te = 0.0;
        foreach ($fold as $acc => $sums) {
            $type = $types[$acc] ?? '';
            if ($type === 'income') {
                $amt = round($sums['credit'] - $sums['debit'], 2);
                if ($amt == 0.0) continue;
                $income[] = ['account' => $acc, 'name' => $names[$acc] ?? '', 'amount' => $amt];
                $ti += $amt;
            } elseif ($type === 'expense') {
                $amt = round($sums['debit'] - $sums['credit'], 2);
                if ($amt == 0.0) continue;
                $expense[] = ['account' => $acc, 'name' => $names[$acc] ?? '', 'amount' => $amt];
                $te += $amt;
            }
        }
        usort($income, static fn($a, $b) => strcmp($a['account'], $b['account']));
        usort($expense, static fn($a, $b) => strcmp($a['account'], $b['account']));

        return Json::ok($res, [
            'period'       => self::periodShape($year, $month, $quarter, $from, $to, $label),
            'income'       => $income,
            'expense'      => $expense,
            'total_income' => round($ti, 2),
            'total_expense'=> round($te, 2),
            'result'       => round($ti - $te, 2),
        ]);
    }

    // ───── Saldenliste (trial balance) ─────────────────────────────────────────
    public static function balances(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        [$year, $month, $quarter, $from, $to, $label] = self::rangeFor($req);
        $names = self::accountNameMap($cid);
        $types = self::accountTypeMap($cid);
        $fold = self::foldByAccount(self::derive($cid, $from, $to, $names));

        $rows = []; $td = 0.0; $tc = 0.0;
        foreach ($fold as $acc => $sums) {
            $d = round($sums['debit'], 2); $c = round($sums['credit'], 2);
            $rows[] = [
                'account' => $acc,
                'name'    => $names[$acc] ?? '',
                'type'    => $types[$acc] ?? '',
                'debit'   => $d,
                'credit'  => $c,
                'balance' => round($d - $c, 2),
            ];
            $td += $d; $tc += $c;
        }
        usort($rows, static fn($a, $b) => strcmp($a['account'], $b['account']));

        return Json::ok($res, [
            'period'   => self::periodShape($year, $month, $quarter, $from, $to, $label),
            'accounts' => $rows,
            'totals'   => ['debit' => round($td, 2), 'credit' => round($tc, 2)],
        ]);
    }

    // ───── Bilanz (balance sheet, as of year-end, cumulative) ──────────────────
    public static function balanceSheet(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $year = self::year($req);
        $to = "$year-12-31";
        $names = self::accountNameMap($cid);
        $types = self::accountTypeMap($cid);
        // Cumulative: from beginning of time through year-end.
        $fold = self::foldByAccount(self::derive($cid, '1900-01-01', $to, $names));

        $assets = []; $liabilities = []; $equity = [];
        $totalAssets = 0.0; $resultIncome = 0.0; $resultExpense = 0.0; $equitySum = 0.0;
        foreach ($fold as $acc => $sums) {
            $type = $types[$acc] ?? '';
            $d = (float)$sums['debit']; $c = (float)$sums['credit'];
            if ($type === 'asset') {
                $amt = round($d - $c, 2);
                if ($amt != 0.0) { $assets[] = ['account' => $acc, 'name' => $names[$acc] ?? '', 'amount' => $amt]; $totalAssets += $amt; }
            } elseif ($type === 'liability') {
                $amt = round($c - $d, 2);
                if ($amt != 0.0) { $liabilities[] = ['account' => $acc, 'name' => $names[$acc] ?? '', 'amount' => $amt]; }
            } elseif ($type === 'equity') {
                $amt = round($c - $d, 2);
                if ($amt != 0.0) { $equity[] = ['account' => $acc, 'name' => $names[$acc] ?? '', 'amount' => $amt]; $equitySum += $amt; }
            } elseif ($type === 'income') {
                $resultIncome += ($c - $d);
            } elseif ($type === 'expense') {
                $resultExpense += ($d - $c);
            }
        }
        $result = round($resultIncome - $resultExpense, 2);
        // Synthetic retained result as an equity line.
        $equity[] = ['account' => '9800', 'name' => 'Jahresergebnis', 'amount' => $result];
        $equitySum += $result;

        usort($assets, static fn($a, $b) => strcmp($a['account'], $b['account']));
        usort($liabilities, static fn($a, $b) => strcmp($a['account'], $b['account']));
        usort($equity, static fn($a, $b) => strcmp($a['account'], $b['account']));

        $totalLiab = 0.0;
        foreach ($liabilities as $l) $totalLiab += $l['amount'];

        return Json::ok($res, [
            'as_of'        => $to,
            'assets'       => $assets,
            'liabilities'  => $liabilities,
            'equity'       => $equity,
            'result'       => $result,
            'total_assets' => round($totalAssets, 2),
            'total_equity_liabilities' => round($totalLiab + $equitySum, 2),
        ]);
    }

    // ───── Manual entries ──────────────────────────────────────────────────────
    public static function createEntry(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $b = (array)$req->getParsedBody();
        $date = trim((string)($b['entry_date'] ?? ''));
        $desc = trim((string)($b['description'] ?? ''));
        $linesIn = is_array($b['lines'] ?? null) ? $b['lines'] : [];

        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) return Json::err($res, 'Datum ungültig', 422);
        if (count($linesIn) < 2) return Json::err($res, 'Mindestens zwei Zeilen erforderlich', 422);

        $lines = []; $sd = 0.0; $sc = 0.0;
        foreach ($linesIn as $l) {
            $acc = trim((string)($l['account'] ?? ''));
            $debit = round((float)($l['debit'] ?? 0), 2);
            $credit = round((float)($l['credit'] ?? 0), 2);
            if ($acc === '') return Json::err($res, 'Konto fehlt', 422);
            if ($debit < 0 || $credit < 0) return Json::err($res, 'Beträge dürfen nicht negativ sein', 422);
            if (($debit > 0) === ($credit > 0)) return Json::err($res, 'Jede Zeile braucht entweder Soll oder Haben', 422);
            $lines[] = ['account' => $acc, 'debit' => $debit, 'credit' => $credit];
            $sd += $debit; $sc += $credit;
        }
        $sd = round($sd, 2); $sc = round($sc, 2);
        if ($sd <= 0 || $sd !== $sc) return Json::err($res, 'Buchung nicht ausgeglichen', 422);

        $pdo = Database::pdo();
        $pdo->prepare('INSERT INTO journal_entries (user_id, company_id, entry_date, description) VALUES (?, ?, ?, ?)')
            ->execute([$uid, $cid, $date, $desc !== '' ? $desc : null]);
        $eid = (int)$pdo->lastInsertId();
        $ins = $pdo->prepare('INSERT INTO journal_lines (entry_id, account, debit, credit) VALUES (?, ?, ?, ?)');
        foreach ($lines as $l) $ins->execute([$eid, $l['account'], $l['debit'], $l['credit']]);

        $names = self::accountNameMap($cid);
        $shaped = array_map(static fn($l) => [
            'account' => $l['account'], 'name' => $names[$l['account']] ?? '',
            'debit' => $l['debit'], 'credit' => $l['credit'],
        ], $lines);

        return Json::ok($res, ['entry' => [
            'id' => $eid, 'date' => $date, 'ref' => 'M' . $eid,
            'description' => $desc, 'source' => 'manual', 'lines' => $shaped,
        ]], 201);
    }

    public static function deleteEntry(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $id = (int)$args['id'];
        $s = Database::pdo()->prepare('SELECT id FROM journal_entries WHERE id=? AND company_id=?');
        $s->execute([$id, $cid]);
        if (!$s->fetch()) return Json::err($res, 'Not found', 404);
        Database::pdo()->prepare('DELETE FROM journal_entries WHERE id=? AND company_id=?')->execute([$id, $cid]);
        return Json::ok($res, ['ok' => true]);
    }

    // ───── DATEV-style CSV (one row per journal line) ──────────────────────────
    public static function datev(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        [$year, $month, $quarter, $from, $to, $label] = self::rangeFor($req);
        $suffix = $month ? sprintf('%04d-%02d', $year, $month) : ($quarter ? $year . '-Q' . $quarter : (string)$year);
        $names = self::accountNameMap($cid);
        $entries = self::derive($cid, $from, $to, $names);
        usort($entries, static fn($a, $b) => [$a['date'], $a['source']] <=> [$b['date'], $b['source']]);

        $rows = [];
        $rows[] = ['Datum', 'Beleg', 'Buchungstext', 'Konto', 'Kontoname', 'Soll', 'Haben'];
        foreach ($entries as $e) {
            foreach ($e['lines'] as $l) {
                $rows[] = [
                    self::de($e['date']), (string)$e['ref'], (string)$e['description'],
                    (string)$l['account'], (string)$l['name'],
                    self::money($l['debit']), self::money($l['credit']),
                ];
            }
        }

        $csv = "\xEF\xBB\xBF"; // UTF-8 BOM for Excel
        foreach ($rows as $r) {
            $csv .= implode(';', array_map(static fn($c) => '"' . str_replace('"', '""', (string)$c) . '"', $r)) . "\r\n";
        }

        $download = !empty($req->getQueryParams()['download']);
        while (ob_get_level() > 0) { @ob_end_clean(); }
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: ' . ($download ? 'attachment' : 'inline') . '; filename="ledger-' . $suffix . '.csv"');
        header('Content-Length: ' . strlen($csv));
        header('Cache-Control: private, max-age=0, must-revalidate');
        echo $csv;
        exit;
    }

    // ───── Derivation ──────────────────────────────────────────────────────────
    /**
     * Build balanced entries from invoices + expenses + manual journal entries
     * within [$from, $to]. Each entry: {date, ref, description, source, lines:[
     * {account, name, debit, credit}]}.
     */
    private static function derive(int $cid, string $from, string $to, array $names): array
    {
        $pdo = Database::pdo();
        $entries = [];

        // Invoices booked (accrual) at doc_date.
        $inv = $pdo->prepare("SELECT id, number, client_snapshot, doc_date, paid_at, net, tax, gross "
            . "FROM documents WHERE company_id=? AND type='invoice' AND doc_date BETWEEN ? AND ? "
            . "ORDER BY doc_date ASC, id ASC");
        $inv->execute([$cid, $from, $to]);
        foreach ($inv->fetchAll() as $d) {
            $snap = json_decode((string)($d['client_snapshot'] ?? ''), true);
            $client = is_array($snap) ? (string)($snap['name'] ?? '') : '';
            $net = (float)$d['net']; $tax = (float)$d['tax']; $gross = (float)$d['gross'];
            $lines = [
                self::line('2000', $names, $gross, 0),
                self::line('4000', $names, 0, $net),
            ];
            if (round($tax, 2) != 0.0) $lines[] = self::line('3500', $names, 0, $tax);
            $entries[] = [
                'date' => substr((string)$d['doc_date'], 0, 10), 'ref' => $d['number'],
                'description' => 'Rechnung ' . $client, 'source' => 'invoice', 'lines' => $lines,
            ];
        }

        // Invoice payments at paid_at.
        $pay = $pdo->prepare("SELECT number, paid_at, gross FROM documents "
            . "WHERE company_id=? AND type='invoice' AND paid_at IS NOT NULL AND DATE(paid_at) BETWEEN ? AND ? "
            . "ORDER BY paid_at ASC, id ASC");
        $pay->execute([$cid, $from, $to]);
        foreach ($pay->fetchAll() as $d) {
            $gross = (float)$d['gross'];
            $entries[] = [
                'date' => substr((string)$d['paid_at'], 0, 10), 'ref' => $d['number'],
                'description' => 'Zahlungseingang ' . $d['number'], 'source' => 'payment',
                'lines' => [self::line('2800', $names, $gross, 0), self::line('2000', $names, 0, $gross)],
            ];
        }

        // Expenses booked at exp_date.
        $exp = $pdo->prepare("SELECT id, exp_date, paid_at, vendor, category, net, tax, gross, deductible "
            . "FROM expenses WHERE company_id=? AND exp_date BETWEEN ? AND ? ORDER BY exp_date ASC, id ASC");
        $exp->execute([$cid, $from, $to]);
        foreach ($exp->fetchAll() as $e) {
            $cat = (string)$e['category'];
            $acc = self::CATEGORY_ACCOUNTS[$cat] ?? '7700';
            $net = (float)$e['net']; $tax = (float)$e['tax']; $gross = (float)$e['gross'];
            $ded = (int)$e['deductible'] === 1;
            $partner = ((string)$e['vendor']) !== '' ? (string)$e['vendor'] : $cat;
            $lines = [self::line($acc, $names, $ded ? $net : $gross, 0)];
            if ($ded && round($tax, 2) != 0.0) $lines[] = self::line('2500', $names, $tax, 0);
            $lines[] = self::line('3300', $names, 0, $gross);
            $entries[] = [
                'date' => substr((string)$e['exp_date'], 0, 10), 'ref' => 'A' . $e['id'],
                'description' => $partner, 'source' => 'expense', 'lines' => $lines,
            ];
        }

        // Expense payments at paid_at.
        $ep = $pdo->prepare("SELECT id, paid_at, vendor, category, gross FROM expenses "
            . "WHERE company_id=? AND paid_at IS NOT NULL AND DATE(paid_at) BETWEEN ? AND ? "
            . "ORDER BY paid_at ASC, id ASC");
        $ep->execute([$cid, $from, $to]);
        foreach ($ep->fetchAll() as $e) {
            $cat = (string)$e['category'];
            $partner = ((string)$e['vendor']) !== '' ? (string)$e['vendor'] : $cat;
            $gross = (float)$e['gross'];
            $entries[] = [
                'date' => substr((string)$e['paid_at'], 0, 10), 'ref' => 'A' . $e['id'],
                'description' => 'Zahlung ' . $partner, 'source' => 'expense_payment',
                'lines' => [self::line('3300', $names, $gross, 0), self::line('2800', $names, 0, $gross)],
            ];
        }

        // Manual journal entries.
        $je = $pdo->prepare('SELECT id, entry_date, description FROM journal_entries '
            . 'WHERE company_id=? AND entry_date BETWEEN ? AND ? ORDER BY entry_date ASC, id ASC');
        $je->execute([$cid, $from, $to]);
        $ml = $pdo->prepare('SELECT account, debit, credit FROM journal_lines WHERE entry_id=? ORDER BY id ASC');
        foreach ($je->fetchAll() as $m) {
            $ml->execute([(int)$m['id']]);
            $lines = array_map(static fn($l) => [
                'account' => (string)$l['account'], 'name' => $names[(string)$l['account']] ?? '',
                'debit' => round((float)$l['debit'], 2), 'credit' => round((float)$l['credit'], 2),
            ], $ml->fetchAll());
            $entries[] = [
                'date' => substr((string)$m['entry_date'], 0, 10), 'ref' => 'M' . $m['id'],
                'description' => (string)($m['description'] ?? ''), 'source' => 'manual', 'lines' => $lines,
            ];
        }

        return $entries;
    }

    /** Fold derived entries into per-account [debit, credit] sums. */
    private static function foldByAccount(array $entries): array
    {
        $fold = [];
        foreach ($entries as $e) {
            foreach ($e['lines'] as $l) {
                $acc = (string)$l['account'];
                if (!isset($fold[$acc])) $fold[$acc] = ['debit' => 0.0, 'credit' => 0.0];
                $fold[$acc]['debit'] += (float)$l['debit'];
                $fold[$acc]['credit'] += (float)$l['credit'];
            }
        }
        return $fold;
    }

    private static function line(string $account, array $names, float $debit, float $credit): array
    {
        return [
            'account' => $account, 'name' => $names[$account] ?? '',
            'debit' => round($debit, 2), 'credit' => round($credit, 2),
        ];
    }

    // ───── Account map helpers ─────────────────────────────────────────────────
    /** Merged chart: default accounts + custom rows (custom overrides by number), keyed by number, sorted. */
    private static function mergedAccounts(int $cid): array
    {
        $map = [];
        foreach (self::DEFAULT_ACCOUNTS as $a) {
            $map[$a[0]] = ['number' => $a[0], 'name' => $a[1], 'type' => $a[2]];
        }
        $s = Database::pdo()->prepare('SELECT number, name, type FROM ledger_accounts WHERE company_id=?');
        $s->execute([$cid]);
        foreach ($s->fetchAll() as $r) {
            $map[(string)$r['number']] = [
                'number' => (string)$r['number'], 'name' => (string)$r['name'], 'type' => (string)$r['type'],
            ];
        }
        uksort($map, static fn($a, $b) => strcmp((string)$a, (string)$b));
        return $map;
    }

    private static function accountNameMap(int $cid): array
    {
        $out = [];
        foreach (self::mergedAccounts($cid) as $num => $a) $out[(string)$num] = $a['name'];
        return $out;
    }

    private static function accountTypeMap(int $cid): array
    {
        $out = [];
        foreach (self::mergedAccounts($cid) as $num => $a) $out[(string)$num] = $a['type'];
        return $out;
    }

    // ───── Period / formatting helpers ─────────────────────────────────────────
    private static function year(Request $req): int
    {
        $y = (int)($req->getQueryParams()['year'] ?? 0);
        return ($y >= 2000 && $y <= 2100) ? $y : (int)date('Y');
    }

    /** [year, month(0=none), quarter(0=none), from, to, label] from query. */
    private static function rangeFor(Request $req): array
    {
        $year = self::year($req);
        $qp = $req->getQueryParams();
        $month = (int)($qp['month'] ?? 0);
        $quarter = (int)($qp['quarter'] ?? 0);
        $names = ['', 'Jänner', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
        if ($month >= 1 && $month <= 12) {
            $from = sprintf('%04d-%02d-01', $year, $month);
            $to = date('Y-m-t', strtotime($from));
            return [$year, $month, 0, $from, $to, $names[$month] . ' ' . $year];
        }
        if ($quarter >= 1 && $quarter <= 4) {
            $sm = ($quarter - 1) * 3 + 1;
            $from = sprintf('%04d-%02d-01', $year, $sm);
            $to = date('Y-m-t', strtotime(sprintf('%04d-%02d-01', $year, $sm + 2)));
            return [$year, 0, $quarter, $from, $to, 'Q' . $quarter . ' ' . $year];
        }
        return [$year, 0, 0, "$year-01-01", "$year-12-31", (string)$year];
    }

    private static function periodShape(int $year, int $month, int $quarter, string $from, string $to, string $label): array
    {
        return ['year' => $year, 'month' => $month, 'quarter' => $quarter, 'from' => $from, 'to' => $to, 'label' => $label];
    }

    /** Comma-decimal money, e.g. 1234,56. */
    private static function money($v): string { return number_format((float)$v, 2, ',', ''); }

    private static function de(?string $ymd): string
    {
        if (!$ymd) return '';
        $d = \DateTime::createFromFormat('Y-m-d', substr($ymd, 0, 10));
        return $d ? $d->format('d.m.Y') : (string)$ymd;
    }
}
