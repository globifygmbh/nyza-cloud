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
 * CSV import for migrating old bookkeeping. /parse reads an uploaded CSV
 * (delimiter + encoding auto-detected) and returns columns + rows for the
 * client-side column-mapping UI; /commit inserts already-normalised records as
 * expenses (Ausgaben) or paid invoices (Einnahmen). Receipt files are not
 * handled here — the user archives those separately.
 */
final class ImportRoutes
{
    private const MAX_ROWS = 10000;

    public static function mount(App $app): void
    {
        $app->group('/api/import', function (RouteCollectorProxy $g) {
            $g->post('/parse',  [self::class, 'parse']);
            $g->post('/commit', [self::class, 'commit']);
        })->add(new AuthMiddleware());
    }

    public static function parse(Request $req, Response $res): Response
    {
        $file = $req->getUploadedFiles()['file'] ?? null;
        if (!$file || $file->getError() !== UPLOAD_ERR_OK) return Json::err($res, 'Keine Datei', 422);
        $content = (string) $file->getStream()->getContents();
        if ($content === '') return Json::err($res, 'Datei leer', 422);

        // Strip BOM, normalise encoding to UTF-8.
        $content = preg_replace('/^\xEF\xBB\xBF/', '', $content);
        if (!mb_check_encoding($content, 'UTF-8')) {
            $content = mb_convert_encoding($content, 'UTF-8', 'Windows-1252');
        }

        $delim = self::detectDelimiter($content);
        $fh = fopen('php://temp', 'r+');
        fwrite($fh, $content);
        rewind($fh);
        $rows = [];
        while (($r = fgetcsv($fh, 0, $delim)) !== false) {
            if (count($r) === 1 && ($r[0] === null || $r[0] === '')) continue; // skip blank lines
            $rows[] = array_map(static fn($c) => $c === null ? '' : trim((string)$c), $r);
            if (count($rows) > self::MAX_ROWS + 1) break;
        }
        fclose($fh);
        if (!$rows) return Json::err($res, 'Keine Zeilen erkannt', 422);

        $columns = array_shift($rows);
        return Json::ok($res, ['columns' => $columns, 'rows' => $rows, 'delimiter' => $delim, 'count' => count($rows)]);
    }

    public static function commit(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        $records = $b['records'] ?? null;
        if (!is_array($records) || !$records) return Json::err($res, 'Keine Datensätze', 422);
        if (count($records) > self::MAX_ROWS) return Json::err($res, 'Zu viele Zeilen (max ' . self::MAX_ROWS . ')', 413);

        $pdo = Database::pdo();
        $income = 0; $expense = 0; $skipped = 0;
        $pdo->beginTransaction();
        try {
            $insExp = $pdo->prepare(
                'INSERT INTO expenses (user_id, exp_date, vendor, description, category, net, tax_rate, tax, gross, deductible, paid_at) '
                . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            );
            $insDoc = $pdo->prepare(
                'INSERT INTO documents (user_id, type, number, contact_id, client_snapshot, doc_date, intro_text, net, tax, gross, paid_at) '
                . 'VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)'
            );
            $insItem = $pdo->prepare(
                'INSERT INTO document_items (document_id, position, description, quantity, unit, unit_price_net, tax_rate) VALUES (?, 1, ?, 1, ?, ?, ?)'
            );

            foreach ($records as $r) {
                if (!is_array($r)) { $skipped++; continue; }
                $kind = ($r['kind'] ?? 'expense') === 'income' ? 'income' : 'expense';
                $date = self::date($r['date'] ?? null);
                $net = round((float)($r['net'] ?? 0), 2);
                $rate = round((float)($r['tax_rate'] ?? 0), 2);
                $gross = round((float)($r['gross'] ?? 0), 2);
                if ($gross <= 0 && $net <= 0) { $skipped++; continue; }
                if ($gross <= 0) $gross = round($net * (1 + $rate / 100), 2);
                if ($net <= 0)   $net = $rate > 0 ? round($gross / (1 + $rate / 100), 2) : $gross;
                $tax = round($gross - $net, 2);
                $partner = self::str($r['partner'] ?? null, 255);
                $desc = self::str($r['description'] ?? null, 500);
                $paid = !empty($r['paid']) || $r['paid'] ?? true; // default paid (historical)
                $paidAt = $date ? $date . ' 00:00:00' : date('Y-m-d H:i:s');

                if ($kind === 'expense') {
                    $cat = self::str($r['category'] ?? null, 64) ?? 'Import';
                    $insExp->execute([$uid, $date, $partner, $desc, $cat, $net, $rate, $tax, $gross, 1, $paidAt]);
                    $expense++;
                } else {
                    $number = self::str($r['number'] ?? null, 32);
                    if ($number === null || $number === '') $number = self::nextInvoiceNumber($uid);
                    $snap = json_encode(['name' => $partner ?: ''], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                    $insDoc->execute([$uid, 'invoice', $number, $snap, $date, $desc, $net, $tax, $gross, $paidAt]);
                    $docId = (int)$pdo->lastInsertId();
                    $insItem->execute([$docId, $desc ?: ($partner ?: 'Position'), 'Pausch.', $net, $rate]);
                    $income++;
                }
            }
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            return Json::err($res, 'Import fehlgeschlagen: ' . $e->getMessage(), 500);
        }
        return Json::ok($res, ['imported' => $income + $expense, 'income' => $income, 'expense' => $expense, 'skipped' => $skipped], 201);
    }

    // ───── helpers ───────────────────────────────────────────────────────────
    private static function detectDelimiter(string $content): string
    {
        $line = strtok($content, "\r\n") ?: '';
        $best = ','; $bestN = -1;
        foreach ([';', ',', "\t", '|'] as $d) {
            $n = substr_count($line, $d);
            if ($n > $bestN) { $bestN = $n; $best = $d; }
        }
        return $best;
    }

    private static function nextInvoiceNumber(int $uid): string
    {
        $pdo = Database::pdo();
        $pdo->prepare('INSERT INTO counters (user_id, name, value) VALUES (?, ?, 1000) ON DUPLICATE KEY UPDATE value = value + 1')
            ->execute([$uid, 'invoice']);
        $s = $pdo->prepare('SELECT value FROM counters WHERE user_id = ? AND name = ?');
        $s->execute([$uid, 'invoice']);
        return 'RE-' . (int)$s->fetch()['value'];
    }

    private static function str($v, int $max): ?string
    {
        if ($v === null) return null;
        $v = trim((string)$v);
        return $v === '' ? null : mb_substr($v, 0, $max);
    }

    private static function date($v): ?string
    {
        if ($v === null || $v === '') return null;
        $v = trim((string)$v);
        if (preg_match('/^(\d{4})-(\d{2})-(\d{2})/', $v, $m)) return "$m[1]-$m[2]-$m[3]";
        if (preg_match('#^(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})#', $v, $m)) {
            $y = strlen($m[3]) === 2 ? '20' . $m[3] : $m[3];
            return sprintf('%04d-%02d-%02d', (int)$y, (int)$m[2], (int)$m[1]);
        }
        $ts = strtotime($v);
        return $ts !== false ? date('Y-m-d', $ts) : null;
    }
}
