<?php
declare(strict_types=1);

namespace Nyza\Routes;

use Nyza\CompanyContext;
use Nyza\Database;
use Nyza\Json;
use Nyza\Middleware\AuthMiddleware;
use Nyza\Storage;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;
use Slim\Routing\RouteCollectorProxy;

/**
 * One-off migration import for a specific pair of legacy export formats
 * (Rechnungen / Belege, semicolon-CSV, German dates + decimal commas). Unlike
 * the generic ImportRoutes column-mapper, the column layout here is fixed and
 * known in advance, so both files are parsed server-side with no user mapping
 * step — just upload → preview → confirm.
 *
 * Only ledger numbers are written (documents / expenses) so quarterly and
 * annual reports (cash-basis, keyed off paid_at) come out correct. No PDFs are
 * generated, no mail is sent, no receipt files are touched — the historical
 * documents themselves stay wherever the user has them archived.
 *
 * Idempotent by design: invoices skip numbers that already exist for the
 * company; expenses skip rows that already match on vendor+date+amount+category.
 * Re-uploading the same file (or committing twice) does not duplicate rows.
 */
final class LegacyImportRoutes
{
    private const MAX_ROWS = 20000;

    public static function mount(App $app): void
    {
        $app->group('/api/import/legacy', function (RouteCollectorProxy $g) {
            $g->post('/invoices/preview', [self::class, 'invoicesPreview']);
            $g->post('/invoices/commit',  [self::class, 'invoicesCommit']);
            $g->post('/vouchers/preview', [self::class, 'vouchersPreview']);
            $g->post('/vouchers/commit',  [self::class, 'vouchersCommit']);
            $g->delete('/invoices',       [self::class, 'wipeInvoices']);
            $g->delete('/expenses',       [self::class, 'wipeExpenses']);
        })->add(new AuthMiddleware());
    }

    // ───── Wipe (for a clean re-import) ─────────────────────────────────────

    /** Deletes every invoice for the active company — for starting a legacy import over from scratch. */
    public static function wipeInvoices(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $pdo = Database::pdo();
        $n = $pdo->prepare('DELETE FROM documents WHERE company_id = ? AND type = ?');
        $n->execute([$cid, 'invoice']);
        $deleted = $n->rowCount();
        $pdo->prepare('DELETE FROM counters WHERE company_id = ? AND name = ?')->execute([$cid, 'invoice']);
        return Json::ok($res, ['deleted' => $deleted]);
    }

    /** Deletes every expense + every voucher-derived income entry for the active company. */
    public static function wipeExpenses(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $pdo = Database::pdo();

        $s = $pdo->prepare('SELECT receipt_path FROM expenses WHERE company_id = ? AND receipt_path IS NOT NULL');
        $s->execute([$cid]);
        foreach ($s->fetchAll() as $row) { Storage::deleteRel($row['receipt_path']); }

        $e = $pdo->prepare('DELETE FROM expenses WHERE company_id = ?');
        $e->execute([$cid]);
        $deletedExpenses = $e->rowCount();

        $d = $pdo->prepare("DELETE FROM documents WHERE company_id = ? AND type = 'invoice' AND number LIKE 'BELEG-%'");
        $d->execute([$cid]);
        $deletedIncome = $d->rowCount();

        return Json::ok($res, ['deleted_expenses' => $deletedExpenses, 'deleted_income' => $deletedIncome]);
    }

    // ───── Rechnungen ────────────────────────────────────────────────────────

    public static function invoicesPreview(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $rows = self::readCsv($req, $res);
        if ($rows instanceof Response) return $rows;
        [$records, $warnings] = self::parseInvoiceRows($rows);
        return Json::ok($res, self::invoicesSummary($cid, $records, $warnings));
    }

    public static function invoicesCommit(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $force = !empty(((array)$req->getParsedBody())['force'] ?? null);
        $rows = self::readCsv($req, $res);
        if ($rows instanceof Response) return $rows;
        [$records, $warnings] = self::parseInvoiceRows($rows);
        if (!$records) return Json::err($res, 'Keine gültigen Zeilen gefunden', 422);

        $pdo = Database::pdo();
        $exists = $pdo->prepare('SELECT 1 FROM documents WHERE company_id = ? AND type = ? AND number = ?');
        $insDoc = $pdo->prepare(
            'INSERT INTO documents (user_id, company_id, type, number, contact_id, client_snapshot, doc_date, intro_text, net, tax, gross, paid_at) '
            . 'VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)'
        );
        $insItem = $pdo->prepare(
            'INSERT INTO document_items (document_id, position, description, quantity, unit, unit_price_net, tax_rate) VALUES (?, 1, ?, 1, ?, ?, ?)'
        );

        $imported = 0; $skipped = 0; $maxNum = 0;
        $pdo->beginTransaction();
        try {
            foreach ($records as $r) {
                // Credit notes (Stornorechnungen) come through with negative net/gross —
                // still type=invoice, so cash-basis reporting nets them out naturally.
                if (!$force) {
                    $exists->execute([$cid, 'invoice', $r['number']]);
                    if ($exists->fetch()) { $skipped++; continue; }
                }

                $snap = json_encode(['name' => $r['snapshot_name']], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                $insDoc->execute([$uid, $cid, 'invoice', $r['number'], $snap, $r['doc_date'], $r['subject'], $r['net'], $r['tax'], $r['gross'], $r['paid_at']]);
                $docId = (int)$pdo->lastInsertId();
                $rate = $r['net'] != 0.0 ? round($r['tax'] / $r['net'] * 100, 2) : 20.0;
                $insItem->execute([$docId, $r['subject'] ?: 'Position', 'Pausch.', $r['net'], $rate]);
                $imported++;

                if (preg_match('/(\d+)\s*$/', $r['number'], $m)) $maxNum = max($maxNum, (int)$m[1]);
            }
            if ($maxNum > 0) {
                $pdo->prepare('INSERT INTO counters (company_id, name, value) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = GREATEST(value, VALUES(value))')
                    ->execute([$cid, 'invoice', $maxNum]);
            }
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            return Json::err($res, 'Import fehlgeschlagen: ' . $e->getMessage(), 500);
        }
        return Json::ok($res, ['imported' => $imported, 'skipped' => $skipped, 'warnings' => $warnings], 201);
    }

    private static function parseInvoiceRows(array $rows): array
    {
        $records = []; $warnings = []; $seen = [];
        foreach ($rows as $i => $row) {
            $line = $i + 2; // +1 header, +1 for 1-based
            $number = trim((string)($row[0] ?? ''));
            if ($number === '') { $warnings[] = "Zeile $line: keine Rechnungsnummer, übersprungen"; continue; }
            $docDate = self::deDate($row[1] ?? '');
            if ($docDate === null) { $warnings[] = "Zeile $line ($number): kein gültiges Rechnungsdatum, übersprungen"; continue; }
            $paidRaw = self::deDate($row[3] ?? '');
            $subject = mb_substr(trim((string)($row[4] ?? '')), 0, 500);
            $net = self::deAmount($row[5] ?? '0');
            $gross = self::deAmount($row[6] ?? '0');
            $tax = round($gross - $net, 2);
            $kdnr = trim((string)($row[8] ?? ''));
            $addr = trim((string)($row[9] ?? ''));
            $land = trim((string)($row[10] ?? ''));
            $snapshotName = $addr !== '' ? $addr : ($land !== '' ? $land : 'Unbekannt');

            // Same number twice in the source file (seen in real exports, e.g. a
            // re-numbered Abschlagsrechnung) — never drop the line, suffix it so
            // both amounts still land in the ledger, and flag it for a manual look.
            $finalNumber = $number;
            if (isset($seen[$number])) {
                $seen[$number]++;
                $finalNumber = $number . '-' . $seen[$number];
                $warnings[] = "Zeile $line: Rechnungsnummer $number kommt mehrfach vor — als $finalNumber importiert, bitte prüfen";
            } else {
                $seen[$number] = 1;
            }

            $records[] = [
                'number' => mb_substr($finalNumber, 0, 32), 'doc_date' => $docDate,
                'paid_at' => $paidRaw ? $paidRaw . ' 00:00:00' : null,
                'subject' => $subject, 'net' => $net, 'tax' => $tax, 'gross' => $gross,
                'snapshot_name' => mb_substr($snapshotName, 0, 500), 'kdnr' => $kdnr,
            ];
        }
        return [$records, $warnings];
    }

    private static function invoicesSummary(int $cid, array $records, array $warnings): array
    {
        $pdo = Database::pdo();
        $existing = 0; $paid = 0; $open = 0; $sumGross = 0.0; $minDate = null; $maxDate = null;
        $exists = $pdo->prepare('SELECT 1 FROM documents WHERE company_id = ? AND type = ? AND number = ?');
        foreach ($records as $r) {
            $exists->execute([$cid, 'invoice', $r['number']]);
            if ($exists->fetch()) $existing++;
            if ($r['paid_at']) $paid++; else $open++;
            $sumGross += $r['gross'];
            if ($minDate === null || $r['doc_date'] < $minDate) $minDate = $r['doc_date'];
            if ($maxDate === null || $r['doc_date'] > $maxDate) $maxDate = $r['doc_date'];
        }
        return [
            'count' => count($records), 'new' => count($records) - $existing, 'existing' => $existing,
            'paid' => $paid, 'open' => $open, 'sum_gross' => round($sumGross, 2),
            'min_date' => $minDate, 'max_date' => $maxDate,
            'sample' => array_slice($records, 0, 8),
            'warnings' => $warnings,
        ];
    }

    // ───── Belege ────────────────────────────────────────────────────────────

    public static function vouchersPreview(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $rows = self::readCsv($req, $res);
        if ($rows instanceof Response) return $rows;
        [$expenses, $income, $warnings] = self::parseVoucherRows($rows);
        return Json::ok($res, [
            'expenses' => self::expensesSummary($cid, $expenses),
            'income'   => self::incomeSummary($cid, $income),
            'warnings' => $warnings,
        ]);
    }

    public static function vouchersCommit(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $force = !empty(((array)$req->getParsedBody())['force'] ?? null);
        $rows = self::readCsv($req, $res);
        if ($rows instanceof Response) return $rows;
        [$expenses, $income, $warnings] = self::parseVoucherRows($rows);
        if (!$expenses && !$income) return Json::err($res, 'Keine gültigen Zeilen gefunden', 422);

        $pdo = Database::pdo();
        $existsExp = $pdo->prepare('SELECT 1 FROM expenses WHERE company_id = ? AND vendor <=> ? AND exp_date <=> ? AND category = ? AND gross = ?');
        $insExp = $pdo->prepare(
            'INSERT INTO expenses (user_id, company_id, exp_date, vendor, description, category, net, tax_rate, tax, gross, deductible, paid_at) '
            . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)'
        );
        $existsDoc = $pdo->prepare('SELECT 1 FROM documents WHERE company_id = ? AND type = ? AND number = ?');
        $insDoc = $pdo->prepare(
            'INSERT INTO documents (user_id, company_id, type, number, contact_id, client_snapshot, doc_date, intro_text, net, tax, gross, paid_at) '
            . 'VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)'
        );
        $insItem = $pdo->prepare(
            'INSERT INTO document_items (document_id, position, description, quantity, unit, unit_price_net, tax_rate) VALUES (?, 1, ?, 1, ?, ?, ?)'
        );

        $impExp = 0; $skipExp = 0; $impInc = 0; $skipInc = 0;
        $pdo->beginTransaction();
        try {
            foreach ($expenses as $r) {
                if (!$force) {
                    $existsExp->execute([$cid, $r['vendor'], $r['exp_date'], $r['category'], $r['gross']]);
                    if ($existsExp->fetch()) { $skipExp++; continue; }
                }
                $insExp->execute([$uid, $cid, $r['exp_date'], $r['vendor'], $r['description'], $r['category'], $r['net'], $r['tax_rate'], $r['tax'], $r['gross'], $r['paid_at']]);
                $impExp++;
            }
            foreach ($income as $r) {
                if (!$force) {
                    $existsDoc->execute([$cid, 'invoice', $r['number']]);
                    if ($existsDoc->fetch()) { $skipInc++; continue; }
                }
                $snap = json_encode(['name' => $r['vendor']], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                $insDoc->execute([$uid, $cid, 'invoice', $r['number'], $snap, $r['exp_date'], $r['description'] ?: $r['vendor'], $r['net'], $r['tax'], $r['gross'], $r['paid_at']]);
                $docId = (int)$pdo->lastInsertId();
                $insItem->execute([$docId, $r['description'] ?: $r['vendor'], 'Pausch.', $r['net'], $r['tax_rate']]);
                $impInc++;
            }
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            return Json::err($res, 'Import fehlgeschlagen: ' . $e->getMessage(), 500);
        }
        return Json::ok($res, [
            'imported_expenses' => $impExp, 'skipped_expenses' => $skipExp,
            'imported_income' => $impInc, 'skipped_income' => $skipInc,
            'warnings' => $warnings,
        ], 201);
    }

    /**
     * Header row (Status set) starts a voucher; following rows with an empty
     * Status are its position lines. Almost every line is a cost, but this
     * export also carries the occasional revenue posting (streaming/royalty
     * payouts booked as a "Beleg" instead of a numbered invoice) — recognised
     * by category and routed to $income instead of $expenses so it lands in
     * documents (taxable revenue) rather than deductible costs.
     */
    private static function parseVoucherRows(array $rows): array
    {
        $expenses = []; $income = []; $warnings = [];
        $header = null;
        foreach ($rows as $i => $row) {
            $line = $i + 2;
            $belegnr = trim((string)($row[0] ?? ''));
            $status = trim((string)($row[1] ?? ''));
            $position = trim((string)($row[2] ?? ''));

            if ($status !== '') {
                // New voucher header.
                $docDate = self::deDate($row[6] ?? '');
                $paidRaw = self::deDate($row[8] ?? '');
                $header = [
                    'belegnr' => $belegnr, 'vendor' => mb_substr(trim((string)($row[3] ?? '')), 0, 255) ?: 'Unbekannt',
                    'exp_date' => $docDate, 'paid_at' => (strtolower($status) === 'bezahlt' && $paidRaw) ? $paidRaw . ' 00:00:00' : null,
                    'line' => $line,
                ];
                if ($docDate === null && $belegnr !== '') $warnings[] = "Zeile $line (Beleg $belegnr): kein gültiges Datum, Positionen werden übersprungen";
                continue;
            }

            if ($position === '' || $header === null) continue; // stray row, not a position line
            if ($header['exp_date'] === null) continue; // header had no usable date

            $gross = self::deAmount($row[10] ?? '0');
            if ($gross == 0.0) { if ($header['belegnr'] !== '') $warnings[] = "Zeile $line (Beleg {$header['belegnr']}): Betrag 0, übersprungen"; continue; }
            $rate = self::deAmount($row[12] ?? '0');
            $net = $rate > 0 ? round($gross / (1 + $rate / 100), 2) : $gross;
            $tax = round($gross - $net, 2);
            $category = trim((string)($row[4] ?? '')) ?: 'Sonstiges';
            $desc = trim((string)($row[5] ?? ''));

            if (stripos($category, 'einnahme') !== false || stripos($category, 'erlös') !== false) {
                $income[] = [
                    'number' => 'BELEG-' . ($header['belegnr'] ?: 'x' . $line), 'vendor' => $header['vendor'],
                    'exp_date' => $header['exp_date'], 'paid_at' => $header['paid_at'],
                    'description' => mb_substr($desc, 0, 500), 'net' => $net, 'tax_rate' => $rate, 'tax' => $tax, 'gross' => $gross,
                ];
                continue;
            }

            $expenses[] = [
                'vendor' => $header['vendor'], 'exp_date' => $header['exp_date'], 'paid_at' => $header['paid_at'],
                'category' => mb_substr($category, 0, 64), 'description' => mb_substr($desc, 0, 500) ?: null,
                'net' => $net, 'tax_rate' => $rate, 'tax' => $tax, 'gross' => $gross,
            ];
        }
        return [$expenses, $income, $warnings];
    }

    private static function expensesSummary(int $cid, array $records): array
    {
        $pdo = Database::pdo();
        $existing = 0; $paid = 0; $open = 0; $sumGross = 0.0; $minDate = null; $maxDate = null;
        $exists = $pdo->prepare('SELECT 1 FROM expenses WHERE company_id = ? AND vendor <=> ? AND exp_date <=> ? AND category = ? AND gross = ?');
        foreach ($records as $r) {
            $exists->execute([$cid, $r['vendor'], $r['exp_date'], $r['category'], $r['gross']]);
            if ($exists->fetch()) $existing++;
            if ($r['paid_at']) $paid++; else $open++;
            $sumGross += $r['gross'];
            if ($minDate === null || $r['exp_date'] < $minDate) $minDate = $r['exp_date'];
            if ($maxDate === null || $r['exp_date'] > $maxDate) $maxDate = $r['exp_date'];
        }
        return [
            'count' => count($records), 'new' => count($records) - $existing, 'existing' => $existing,
            'paid' => $paid, 'open' => $open, 'sum_gross' => round($sumGross, 2),
            'min_date' => $minDate, 'max_date' => $maxDate, 'sample' => array_slice($records, 0, 8),
        ];
    }

    private static function incomeSummary(int $cid, array $records): array
    {
        $pdo = Database::pdo();
        $existing = 0; $sumGross = 0.0;
        $exists = $pdo->prepare('SELECT 1 FROM documents WHERE company_id = ? AND type = ? AND number = ?');
        foreach ($records as $r) {
            $exists->execute([$cid, 'invoice', $r['number']]);
            if ($exists->fetch()) $existing++;
            $sumGross += $r['gross'];
        }
        return [
            'count' => count($records), 'new' => count($records) - $existing, 'existing' => $existing,
            'sum_gross' => round($sumGross, 2), 'sample' => array_slice($records, 0, 8),
        ];
    }

    // ───── shared helpers ────────────────────────────────────────────────────

    /** @return array<int,array<int,string>>|Response */
    private static function readCsv(Request $req, Response $res)
    {
        $file = $req->getUploadedFiles()['file'] ?? null;
        if (!$file || $file->getError() !== UPLOAD_ERR_OK) {
            return Json::err($res, 'Keine Datei', 422);
        }
        $content = (string)$file->getStream()->getContents();
        if ($content === '') return Json::err($res, 'Datei leer', 422);
        $content = preg_replace('/^\xEF\xBB\xBF/', '', $content);
        if (!mb_check_encoding($content, 'UTF-8')) {
            $content = mb_convert_encoding($content, 'UTF-8', 'Windows-1252');
        }
        $fh = fopen('php://temp', 'r+');
        fwrite($fh, $content);
        rewind($fh);
        $rows = [];
        $header = fgetcsv($fh, 0, ';'); // discard column header row
        while (($r = fgetcsv($fh, 0, ';')) !== false) {
            if (count($r) === 1 && ($r[0] === null || $r[0] === '')) continue;
            $rows[] = array_map(static fn($c) => $c === null ? '' : trim((string)$c), $r);
            if (count($rows) > self::MAX_ROWS) break;
        }
        fclose($fh);
        return $rows;
    }

    private static function deDate($v): ?string
    {
        $v = trim((string)$v);
        if ($v === '') return null;
        if (preg_match('#^(\d{1,2})\.(\d{1,2})\.(\d{2,4})#', $v, $m)) {
            $y = strlen($m[3]) === 2 ? '20' . $m[3] : $m[3];
            return sprintf('%04d-%02d-%02d', (int)$y, (int)$m[2], (int)$m[1]);
        }
        return null;
    }

    private static function deAmount($v): float
    {
        $v = trim((string)$v);
        if ($v === '') return 0.0;
        $v = str_replace('.', '', $v);
        $v = str_replace(',', '.', $v);
        return (float)$v;
    }
}
