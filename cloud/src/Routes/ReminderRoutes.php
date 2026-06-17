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
 * Mahnungen (dunning) for unpaid invoices. Up to three stages; each adds a fee
 * (from the company profile) and a new deadline, and renders its own PDF in the
 * brand style. The cumulative open amount = invoice gross + all reminder fees.
 */
final class ReminderRoutes
{
    private const ACCENT = '#7C5CFF';

    public static function mount(App $app): void
    {
        $app->group('/api', function (RouteCollectorProxy $g) {
            $g->get('/documents/{id}/reminders',  [self::class, 'list']);
            $g->post('/documents/{id}/reminders', [self::class, 'create']);
            $g->delete('/reminders/{id}',         [self::class, 'delete']);
            $g->get('/reminders/{id}/pdf',        [self::class, 'pdf']);
        })->add(new AuthMiddleware());
    }

    public static function list(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $doc = self::doc($uid, (int)$args['id']);
        if (!$doc) return Json::err($res, 'Not found', 404);
        return Json::ok($res, ['reminders' => self::forDoc($uid, (int)$doc['id'])]);
    }

    public static function create(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $doc = self::doc($uid, (int)$args['id']);
        if (!$doc) return Json::err($res, 'Not found', 404);
        if ($doc['type'] !== 'invoice') return Json::err($res, 'Nur für Rechnungen', 422);
        if (!empty($doc['paid_at'])) return Json::err($res, 'Rechnung ist bereits bezahlt', 422);

        $existing = self::forDoc($uid, (int)$doc['id']);
        $stage = count($existing) + 1;
        if ($stage > 3) return Json::err($res, 'Maximal 3 Mahnstufen', 422);

        $company = self::company($uid);
        $fee = (float)($company['reminder_fee_' . $stage] ?? 0);
        $due = date('Y-m-d', strtotime('+14 days'));

        Database::pdo()->prepare('INSERT INTO reminders (user_id, document_id, stage, fee, due_date) VALUES (?, ?, ?, ?, ?)')
            ->execute([$uid, (int)$doc['id'], $stage, $fee, $due]);
        $id = (int)Database::pdo()->lastInsertId();
        return Json::ok($res, ['reminder' => self::one($uid, $id), 'stage' => $stage], 201);
    }

    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $r = self::one($uid, (int)$args['id']);
        if (!$r) return Json::err($res, 'Not found', 404);
        Database::pdo()->prepare('DELETE FROM reminders WHERE id = ? AND user_id = ?')->execute([(int)$r['id'], $uid]);
        return Json::ok($res, ['ok' => true]);
    }

    public static function pdf(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $r = self::one($uid, (int)$args['id']);
        if (!$r) return Json::err($res, 'Not found', 404);
        $doc = self::doc($uid, (int)$r['document_id']);
        if (!$doc) return Json::err($res, 'Not found', 404);

        $company = self::company($uid);
        $all = self::forDoc($uid, (int)$doc['id']);
        $cumFee = 0.0;
        foreach ($all as $x) { if ((int)$x['stage'] <= (int)$r['stage']) $cumFee += (float)$x['fee']; }
        $html = self::renderHtml($doc, $r, $company, $cumFee);

        $dompdf = new \Dompdf\Dompdf(['isRemoteEnabled' => false, 'isHtml5ParserEnabled' => true, 'defaultFont' => 'DejaVu Sans']);
        $dompdf->loadHtml($html, 'UTF-8');
        $dompdf->setPaper('A4', 'portrait');
        $dompdf->render();
        $pdf = $dompdf->output();

        $download = !empty($req->getQueryParams()['download']);
        $name = 'Mahnung-' . $doc['number'] . '-' . $r['stage'] . '.pdf';
        while (ob_get_level() > 0) { @ob_end_clean(); }
        header('Content-Type: application/pdf');
        header('Content-Disposition: ' . ($download ? 'attachment' : 'inline') . '; filename="' . addslashes($name) . '"');
        header('Content-Length: ' . strlen($pdf));
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: private, max-age=0, must-revalidate');
        echo $pdf;
        exit;
    }

    // ───── helpers ───────────────────────────────────────────────────────────
    private static function doc(int $uid, int $id): ?array
    {
        $s = Database::pdo()->prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?');
        $s->execute([$id, $uid]);
        return $s->fetch() ?: null;
    }

    private static function one(int $uid, int $id): ?array
    {
        $s = Database::pdo()->prepare('SELECT * FROM reminders WHERE id = ? AND user_id = ?');
        $s->execute([$id, $uid]);
        return $s->fetch() ?: null;
    }

    private static function forDoc(int $uid, int $docId): array
    {
        $s = Database::pdo()->prepare('SELECT * FROM reminders WHERE document_id = ? AND user_id = ? ORDER BY stage ASC, id ASC');
        $s->execute([$docId, $uid]);
        return array_map(static fn($r) => [
            'id' => (int)$r['id'], 'document_id' => (int)$r['document_id'], 'stage' => (int)$r['stage'],
            'fee' => (float)$r['fee'], 'due_date' => $r['due_date'], 'created_at' => $r['created_at'],
        ], $s->fetchAll());
    }

    private static function company(int $uid): array
    {
        $s = Database::pdo()->prepare("SELECT data FROM app_settings WHERE user_id = ? AND ns = 'company'");
        $s->execute([$uid]);
        $row = $s->fetch();
        if (!$row || !$row['data']) return [];
        $d = json_decode((string)$row['data'], true);
        return is_array($d) ? $d : [];
    }

    private static function e(?string $s): string { return htmlspecialchars((string)$s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }
    private static function money($n): string { return number_format((float)$n, 2, ',', '.') . ' €'; }
    private static function de(?string $ymd): string
    {
        if (!$ymd) return '';
        $d = \DateTime::createFromFormat('Y-m-d', substr($ymd, 0, 10));
        return $d ? $d->format('d.m.Y') : (string)$ymd;
    }

    private static function renderHtml(array $doc, array $r, array $co, float $cumFee): string
    {
        $accent = self::ACCENT;
        $stage = (int)$r['stage'];
        $titles = [1 => '1. Mahnung', 2 => '2. Mahnung', 3 => '3. Mahnung'];
        $title = $titles[$stage] ?? 'Mahnung';
        $snap = json_decode((string)($doc['client_snapshot'] ?? ''), true);
        if (!is_array($snap)) $snap = [];

        $cv = static fn(string $k): string => isset($co[$k]) ? (string)$co[$k] : '';
        $legalName = $cv('legal_name') !== '' ? $cv('legal_name') : $cv('brand_name');
        $senderParts = array_filter([$legalName, $cv('street'), trim($cv('zip') . ' ' . $cv('city')), $cv('country')]);
        $sender = implode(' · ', array_map([self::class, 'e'], $senderParts));

        $defaults = [
            1 => 'Die unten angeführte Rechnung ist noch offen. Wir bitten Sie, den Betrag umgehend zu begleichen. Sollten Sie die Zahlung bereits veranlasst haben, betrachten Sie dieses Schreiben als gegenstandslos.',
            2 => 'Trotz unserer ersten Mahnung ist die unten angeführte Rechnung weiterhin offen. Wir ersuchen Sie dringend, den offenen Betrag inkl. Mahnspesen bis zum unten genannten Datum zu überweisen.',
            3 => 'Trotz mehrfacher Aufforderung ist die unten angeführte Rechnung weiterhin offen. Wir fordern Sie letztmalig auf, den offenen Betrag inkl. Spesen bis zum genannten Datum zu begleichen. Andernfalls behalten wir uns weitere Schritte vor.',
        ];
        $intro = $cv('reminder_intro_' . $stage) !== '' ? $cv('reminder_intro_' . $stage) : ($defaults[$stage] ?? $defaults[1]);

        $gross = (float)$doc['gross'];
        $total = $gross + $cumFee;

        $rcpt = '<div class="r-name">' . self::e((string)($snap['name'] ?? '')) . '</div>';
        foreach (['contact_person', 'street'] as $k) { if (!empty($snap[$k])) $rcpt .= '<div>' . self::e((string)$snap[$k]) . '</div>'; }
        $cityLine = trim((string)($snap['zip'] ?? '') . ' ' . (string)($snap['city'] ?? ''));
        if ($cityLine !== '') $rcpt .= '<div>' . self::e($cityLine) . '</div>';
        if (!empty($snap['country'])) $rcpt .= '<div>' . self::e((string)$snap['country']) . '</div>';

        $feeRow = $cumFee > 0 ? '<tr><td>Mahnspesen</td><td class="c-num">' . self::money($cumFee) . '</td></tr>' : '';
        $bankFoot = implode('<br>', array_filter([
            $cv('bank_name') !== '' ? 'Bank: ' . self::e($cv('bank_name')) : '',
            $cv('iban') !== '' ? 'IBAN: ' . self::e($cv('iban')) : '',
            $cv('bic') !== '' ? 'BIC: ' . self::e($cv('bic')) : '',
        ]));
        $closing = $cv('closing') !== '' ? $cv('closing') : 'Mit freundlichen Grüßen';
        $sign = $cv('signature_name') !== '' ? '<div class="sign">' . self::e($cv('signature_name')) . '</div>' : '';
        $due = self::de($r['due_date']);
        $docDate = self::de($doc['doc_date']);
        $grossFmt = self::money($gross);
        $totalFmt = self::money($total);
        $number = self::e((string)$doc['number']);

        return <<<HTML
<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><style>
  @page { margin: 28mm 18mm; }
  body { font-family:'DejaVu Sans',sans-serif; font-size:10.5px; color:#1c1c22; }
  .sender { font-size:8px; color:#888; margin-bottom:24px; }
  .r-name { font-weight:bold; font-size:11px; }
  h1 { font-size:18px; margin:26px 0 2px; }
  .rule { height:3px; background:{$accent}; margin-bottom:14px; }
  .intro { margin:12px 0 18px; line-height:1.6; }
  table.sum { width:60%; border-collapse:collapse; margin:10px 0 0; }
  table.sum td { padding:4px 0; }
  table.sum .c-num { text-align:right; }
  table.sum tr.total td { border-top:2px solid {$accent}; font-weight:bold; font-size:13px; padding-top:7px; }
  .due { margin:18px 0; padding:10px 14px; background:#f5f3ff; border-left:3px solid {$accent}; }
  .foot { margin-top:30px; line-height:1.5; }
  .sign { margin-top:16px; font-weight:bold; }
  .bank { margin-top:24px; font-size:8.5px; color:#888; border-top:1px solid #e6e3f0; padding-top:6px; }
</style></head><body>
  <div class="sender">{$sender}</div>
  {$rcpt}
  <h1>{$title}</h1><div class="rule"></div>
  <div class="intro">{$intro}</div>
  <table class="sum">
    <tr><td>Rechnung {$number} vom {$docDate}</td><td class="c-num">{$grossFmt}</td></tr>
    {$feeRow}
    <tr class="total"><td>Offener Gesamtbetrag</td><td class="c-num">{$totalFmt}</td></tr>
  </table>
  <div class="due">Bitte überweisen Sie den offenen Betrag bis spätestens <strong>{$due}</strong>.</div>
  <div class="foot">{$closing}{$sign}</div>
  <div class="bank">{$bankFoot}</div>
</body></html>
HTML;
    }
}
