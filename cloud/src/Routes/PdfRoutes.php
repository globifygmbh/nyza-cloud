<?php
declare(strict_types=1);

namespace Nyza\Routes;

use Nyza\Json;
use Nyza\Storage;
use Nyza\Pdf\NyzaPdf;
use Nyza\Middleware\AuthMiddleware;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;
use Slim\Routing\RouteCollectorProxy;
use setasign\Fpdi\Fpdi;

/**
 * PDF toolbox — all operations run in pure PHP via FPDI/FPDF, no server
 * binaries required (works even if exec() is disabled). Pages are imported as
 * templates and re-composed; text tools (watermark/stamp/numbers) are drawn on
 * top. Poppler stays as a fallback only for the format-change of PDFs the free
 * parser can't read.
 */
final class PdfRoutes
{
    private const MAX = 80 * 1024 * 1024;
    private const SIZES = [
        'A0' => [841, 1189], 'A1' => [594, 841], 'A2' => [420, 594], 'A3' => [297, 420],
        'A4' => [210, 297], 'A5' => [148, 210], 'A6' => [105, 148],
    ];
    private const COLORS = [
        'grau' => [150, 150, 150], 'rot' => [211, 47, 47], 'blau' => [40, 90, 200],
        'gruen' => [46, 160, 90], 'schwarz' => [30, 30, 30],
    ];

    public static function mount(App $app): void
    {
        $app->group('/api/pdf', function (RouteCollectorProxy $g) {
            $g->get('/status',       [self::class, 'status']);
            $g->post('/info',        [self::class, 'info']);
            $g->post('/resize',      [self::class, 'resize']);
            $g->post('/merge',       [self::class, 'merge']);
            $g->post('/split',       [self::class, 'split']);
            $g->post('/organize',    [self::class, 'organize']);
            $g->post('/extract',     [self::class, 'extract']);
            $g->post('/nup',         [self::class, 'nup']);
            $g->post('/booklet',     [self::class, 'booklet']);
            $g->post('/margin',      [self::class, 'margin']);
            $g->post('/watermark',   [self::class, 'watermark']);
            $g->post('/pagenumbers', [self::class, 'pagenumbers']);
            $g->post('/stamp',       [self::class, 'stamp']);
            $g->post('/bates',       [self::class, 'bates']);
            $g->post('/images',      [self::class, 'images']);
        })->add(new AuthMiddleware());
    }

    // ───────────────────────── status / info ────────────────────────────────

    public static function status(Request $req, Response $res): Response
    {
        return Json::ok($res, [
            'available' => class_exists(Fpdi::class),
            'engine'    => 'fpdi',
            'formats'   => array_keys(self::SIZES),
        ]);
    }

    public static function info(Request $req, Response $res): Response
    {
        $in = self::stash($req, $res);
        if ($in instanceof Response) return $in;
        try {
            $pdf = new Fpdi();
            $count = $pdf->setSourceFile($in);
            $pages = [];
            for ($p = 1; $p <= $count; $p++) {
                $s = $pdf->getTemplateSize($pdf->importPage($p));
                $pages[] = ['n' => $p, 'width' => round($s['width'], 1), 'height' => round($s['height'], 1),
                            'landscape' => $s['width'] > $s['height']];
            }
            @unlink($in);
            return Json::ok($res, ['count' => $count, 'pages' => $pages]);
        } catch (\Throwable $e) {
            @unlink($in);
            return Json::err($res, 'PDF konnte nicht gelesen werden (evtl. komprimiert/geschützt).', 422);
        }
    }

    // ───────────────────────── format change ────────────────────────────────

    public static function resize(Request $req, Response $res): Response
    {
        $in = self::stash($req, $res, $name);
        if ($in instanceof Response) return $in;
        $fmt = strtoupper(trim((string)(self::body($req)['format'] ?? 'A4')));
        if (!isset(self::SIZES[$fmt])) { @unlink($in); return Json::err($res, 'Unbekanntes Format', 422); }
        [$mmW, $mmH] = self::SIZES[$fmt];

        $bytes = self::viaFpdi($in, $mmW, $mmH) ?? self::viaPdftocairo($in, $mmW, $mmH);
        @unlink($in);
        if ($bytes === null) return Json::err($res, 'Diese PDF konnte nicht umgewandelt werden (evtl. komprimiert oder passwortgeschützt).', 422);
        return self::send($name, $fmt, $bytes);
    }

    // ───────────────────────── merge ────────────────────────────────────────

    public static function merge(Request $req, Response $res): Response
    {
        $files = $req->getUploadedFiles()['files'] ?? [];
        if (!is_array($files)) $files = [$files];
        $files = array_values(array_filter($files, fn($f) => $f && $f->getError() === UPLOAD_ERR_OK));
        if (count($files) < 2) return Json::err($res, 'Bitte mindestens zwei PDFs wählen', 422);
        $paths = [];
        foreach ($files as $f) {
            if ((int)$f->getSize() > self::MAX) { self::cleanup($paths); return Json::err($res, 'Datei zu groß', 413); }
            $p = Storage::temp() . '/pdfm_' . bin2hex(random_bytes(6)) . '.pdf';
            $f->moveTo($p); $paths[] = $p;
        }
        try {
            $pdf = new NyzaPdf();
            foreach ($paths as $path) {
                $n = $pdf->setSourceFile($path);
                for ($p = 1; $p <= $n; $p++) self::place($pdf, $pdf->importPage($p));
            }
            $out = $pdf->Output('S');
        } catch (\Throwable $e) { self::cleanup($paths); return Json::err($res, 'Zusammenführen fehlgeschlagen (evtl. komprimierte PDF).', 422); }
        self::cleanup($paths);
        return self::send('zusammengefuegt', '', $out);
    }

    // ───────────────────────── split → zip ──────────────────────────────────

    public static function split(Request $req, Response $res): Response
    {
        $in = self::stash($req, $res, $name);
        if ($in instanceof Response) return $in;
        $b = self::body($req);
        $mode = (string)($b['mode'] ?? 'pages');
        try {
            $probe = new Fpdi(); $count = $probe->setSourceFile($in);
            $parts = []; // each: ['label'=>, 'pages'=>[]]
            if ($mode === 'ranges' && trim((string)($b['ranges'] ?? '')) !== '') {
                foreach (preg_split('/[,\n]+/', (string)$b['ranges']) as $grp) {
                    $grp = trim($grp); if ($grp === '') continue;
                    $pages = self::parseRanges($grp, $count);
                    if ($pages) $parts[] = ['label' => str_replace(['-', ' '], ['-', ''], $grp), 'pages' => $pages];
                }
            } else {
                for ($p = 1; $p <= $count; $p++) $parts[] = ['label' => (string)$p, 'pages' => [$p]];
            }
            if (!$parts) { @unlink($in); return Json::err($res, 'Keine gültigen Seiten', 422); }

            if (count($parts) === 1) { // single result → return the PDF directly
                $out = self::buildFrom($in, $parts[0]['pages']);
                @unlink($in);
                return self::send(self::base($name) . '_' . $parts[0]['label'], '', $out);
            }
            if (!class_exists(\ZipArchive::class)) { @unlink($in); return Json::err($res, 'ZIP nicht verfügbar auf dem Server', 503); }
            $zipPath = Storage::temp() . '/pdfzip_' . bin2hex(random_bytes(6)) . '.zip';
            $zip = new \ZipArchive();
            $zip->open($zipPath, \ZipArchive::CREATE | \ZipArchive::OVERWRITE);
            $base = self::base($name);
            foreach ($parts as $part) $zip->addFromString($base . '_' . $part['label'] . '.pdf', self::buildFrom($in, $part['pages']));
            $zip->close();
            @unlink($in);
            $bytes = (string)file_get_contents($zipPath); @unlink($zipPath);
            return self::send($base . '_seiten', '', $bytes, 'application/zip', 'zip');
        } catch (\Throwable $e) { @unlink($in); return Json::err($res, 'Teilen fehlgeschlagen (evtl. komprimierte PDF).', 422); }
    }

    // ─────────────────── organize (reorder / delete / rotate) ────────────────

    public static function organize(Request $req, Response $res): Response
    {
        $in = self::stash($req, $res, $name);
        if ($in instanceof Response) return $in;
        $spec = json_decode((string)(self::body($req)['pages'] ?? ''), true);
        if (!is_array($spec) || !$spec) { @unlink($in); return Json::err($res, 'Keine Seiten angegeben', 422); }
        try {
            $probe = new Fpdi(); $count = $probe->setSourceFile($in);
            $pages = []; $rot = [];
            foreach ($spec as $item) {
                $p = (int)($item['p'] ?? 0); if ($p < 1 || $p > $count) continue;
                $r = (int)($item['r'] ?? 0); $r = ((($r % 360) + 360) % 360);
                if (!in_array($r, [0, 90, 180, 270], true)) $r = 0;
                $pages[] = $p; $rot[] = $r;
            }
            if (!$pages) { @unlink($in); return Json::err($res, 'Alle Seiten entfernt – nichts zu speichern', 422); }
            $out = self::buildFrom($in, $pages, $rot);
            @unlink($in);
            return self::send(self::base($name) . '_bearbeitet', '', $out);
        } catch (\Throwable $e) { @unlink($in); return Json::err($res, 'Bearbeiten fehlgeschlagen.', 422); }
    }

    // ───────────────────────── extract ──────────────────────────────────────

    public static function extract(Request $req, Response $res): Response
    {
        $in = self::stash($req, $res, $name);
        if ($in instanceof Response) return $in;
        try {
            $probe = new Fpdi(); $count = $probe->setSourceFile($in);
            $pages = self::parseRanges((string)(self::body($req)['pages'] ?? ''), $count);
            if (!$pages) { @unlink($in); return Json::err($res, 'Keine gültigen Seiten (z. B. 1,3,5-7)', 422); }
            $out = self::buildFrom($in, $pages);
            @unlink($in);
            return self::send(self::base($name) . '_auszug', '', $out);
        } catch (\Throwable $e) { @unlink($in); return Json::err($res, 'Extrahieren fehlgeschlagen.', 422); }
    }

    // ───────────────────────── N-up ─────────────────────────────────────────

    public static function nup(Request $req, Response $res): Response
    {
        $in = self::stash($req, $res, $name);
        if ($in instanceof Response) return $in;
        $b = self::body($req);
        $n = (int)($b['n'] ?? 2); if (!in_array($n, [2, 4], true)) $n = 2;
        $fmt = strtoupper(trim((string)($b['format'] ?? 'A4'))); if (!isset(self::SIZES[$fmt])) $fmt = 'A4';
        [$mmW, $mmH] = self::SIZES[$fmt];
        // 2-up on landscape (2×1), 4-up on portrait (2×2).
        $cols = 2; $rows = $n === 2 ? 1 : 2;
        $orient = $n === 2 ? 'L' : 'P';
        [$pageW, $pageH] = $orient === 'L' ? [max($mmW, $mmH), min($mmW, $mmH)] : [min($mmW, $mmH), max($mmW, $mmH)];
        $gap = 6; $pad = 8;
        $cellW = ($pageW - 2 * $pad - ($cols - 1) * $gap) / $cols;
        $cellH = ($pageH - 2 * $pad - ($rows - 1) * $gap) / $rows;
        try {
            $pdf = new NyzaPdf($orient, 'mm', [$pageW, $pageH]);
            $count = $pdf->setSourceFile($in);
            for ($p = 1; $p <= $count; $p += $n) {
                $pdf->AddPage($orient, [$pageW, $pageH]);
                for ($k = 0; $k < $n; $k++) {
                    $src = $p + $k; if ($src > $count) break;
                    $tpl = $pdf->importPage($src); $s = $pdf->getTemplateSize($tpl);
                    $col = $k % $cols; $row = intdiv($k, $cols);
                    $cx = $pad + $col * ($cellW + $gap);
                    $cy = $pad + $row * ($cellH + $gap);
                    $scale = min($cellW / $s['width'], $cellH / $s['height']);
                    $w = $s['width'] * $scale; $h = $s['height'] * $scale;
                    $pdf->useTemplate($tpl, $cx + ($cellW - $w) / 2, $cy + ($cellH - $h) / 2, $w, $h);
                }
            }
            $out = $pdf->Output('S');
            @unlink($in);
            return self::send(self::base($name) . '_' . $n . 'up', '', $out);
        } catch (\Throwable $e) { @unlink($in); return Json::err($res, 'N-up fehlgeschlagen.', 422); }
    }

    // ───────────────────────── booklet ──────────────────────────────────────

    public static function booklet(Request $req, Response $res): Response
    {
        $in = self::stash($req, $res, $name);
        if ($in instanceof Response) return $in;
        try {
            $pdf = new NyzaPdf('L', 'mm', 'A4');
            $count = $pdf->setSourceFile($in);
            $total = (int)ceil($count / 4) * 4;      // pad to multiple of 4
            $order = [];                              // saddle-stitch imposition
            $l = 1; $r = $total;
            while ($l < $r) { $order[] = $r; $order[] = $l; $order[] = $l + 1; $order[] = $r - 1; $l += 2; $r -= 2; }
            [$pw, $ph] = [297.0, 210.0];              // A4 landscape
            $half = $pw / 2; $pad = 6;
            for ($i = 0; $i < count($order); $i += 2) {
                $pdf->AddPage('L', [$pw, $ph]);
                for ($side = 0; $side < 2; $side++) {
                    $src = $order[$i + $side]; if ($src < 1 || $src > $count) continue; // blank
                    $tpl = $pdf->importPage($src); $s = $pdf->getTemplateSize($tpl);
                    $cellW = $half - 1.5 * $pad; $cellH = $ph - 2 * $pad;
                    $scale = min($cellW / $s['width'], $cellH / $s['height']);
                    $w = $s['width'] * $scale; $h = $s['height'] * $scale;
                    $cx = $side === 0 ? $pad : $half + $pad / 2;
                    $pdf->useTemplate($tpl, $cx + ($cellW - $w) / 2, $pad + ($cellH - $h) / 2, $w, $h);
                }
            }
            $out = $pdf->Output('S');
            @unlink($in);
            return self::send(self::base($name) . '_broschuere', '', $out);
        } catch (\Throwable $e) { @unlink($in); return Json::err($res, 'Broschüre fehlgeschlagen.', 422); }
    }

    // ───────────────────────── margin ──────────────────────────────────────

    public static function margin(Request $req, Response $res): Response
    {
        $in = self::stash($req, $res, $name);
        if ($in instanceof Response) return $in;
        $mm = (float)(self::body($req)['mm'] ?? 10); $mm = max(0, min(80, $mm));
        try {
            $pdf = new NyzaPdf();
            $count = $pdf->setSourceFile($in);
            for ($p = 1; $p <= $count; $p++) {
                $tpl = $pdf->importPage($p); $s = $pdf->getTemplateSize($tpl);
                $land = $s['width'] > $s['height'];
                $pdf->AddPage($land ? 'L' : 'P', [$s['width'], $s['height']]);
                $iw = max(1, $s['width'] - 2 * $mm); $ih = max(1, $s['height'] - 2 * $mm);
                $scale = min($iw / $s['width'], $ih / $s['height']);
                $w = $s['width'] * $scale; $h = $s['height'] * $scale;
                $pdf->useTemplate($tpl, ($s['width'] - $w) / 2, ($s['height'] - $h) / 2, $w, $h);
            }
            $out = $pdf->Output('S');
            @unlink($in);
            return self::send(self::base($name) . '_rand', '', $out);
        } catch (\Throwable $e) { @unlink($in); return Json::err($res, 'Rand fehlgeschlagen.', 422); }
    }

    // ───────────────────────── watermark ────────────────────────────────────

    public static function watermark(Request $req, Response $res): Response
    {
        $in = self::stash($req, $res, $name);
        if ($in instanceof Response) return $in;
        $b = self::body($req);
        $text = trim((string)($b['text'] ?? 'ENTWURF')); if ($text === '') $text = 'ENTWURF';
        [$r, $g, $bl] = self::COLORS[strtolower((string)($b['color'] ?? 'grau'))] ?? self::COLORS['grau'];
        $size = (int)($b['size'] ?? 60); $size = max(8, min(200, $size));
        $angle = (float)($b['angle'] ?? 45); $angle = max(-90, min(90, $angle));
        try {
            $pdf = new NyzaPdf();
            $count = $pdf->setSourceFile($in);
            for ($p = 1; $p <= $count; $p++) {
                $tpl = $pdf->importPage($p); $s = $pdf->getTemplateSize($tpl);
                $land = $s['width'] > $s['height'];
                $pdf->AddPage($land ? 'L' : 'P', [$s['width'], $s['height']]);
                $pdf->useTemplate($tpl, 0, 0, $s['width'], $s['height']);
                $pdf->SetFont('Helvetica', 'B', $size);
                $pdf->SetTextColor($r, $g, $bl);
                $tw = $pdf->GetStringWidth(NyzaPdf::enc($text));
                $rad = $angle * M_PI / 180;
                $cx = $s['width'] / 2 - cos($rad) * $tw / 2;
                $cy = $s['height'] / 2 + sin($rad) * $tw / 2;
                $pdf->rotatedText($cx, $cy, NyzaPdf::enc($text), $angle);
            }
            $out = $pdf->Output('S');
            @unlink($in);
            return self::send(self::base($name) . '_wasserzeichen', '', $out);
        } catch (\Throwable $e) { @unlink($in); return Json::err($res, 'Wasserzeichen fehlgeschlagen.', 422); }
    }

    // ───────────────────────── page numbers ─────────────────────────────────

    public static function pagenumbers(Request $req, Response $res): Response
    {
        $in = self::stash($req, $res, $name);
        if ($in instanceof Response) return $in;
        $b = self::body($req);
        $pos = (string)($b['position'] ?? 'unten-mitte');
        $tpl_fmt = (string)($b['format'] ?? '{n} / {N}');
        $start = (int)($b['start'] ?? 1);
        $header = trim((string)($b['header'] ?? ''));
        try {
            $pdf = new NyzaPdf();
            $count = $pdf->setSourceFile($in);
            for ($p = 1; $p <= $count; $p++) {
                $tpl = $pdf->importPage($p); $s = $pdf->getTemplateSize($tpl);
                $land = $s['width'] > $s['height'];
                $pdf->AddPage($land ? 'L' : 'P', [$s['width'], $s['height']]);
                $pdf->useTemplate($tpl, 0, 0, $s['width'], $s['height']);
                $pdf->SetFont('Helvetica', '', 10);
                $pdf->SetTextColor(60, 60, 60);
                $label = str_replace(['{n}', '{N}'], [(string)($start + $p - 1), (string)($count + $start - 1)], $tpl_fmt);
                self::placeText($pdf, $s['width'], $s['height'], $pos, NyzaPdf::enc($label));
                if ($header !== '') self::placeText($pdf, $s['width'], $s['height'], 'oben-mitte', NyzaPdf::enc($header));
            }
            $out = $pdf->Output('S');
            @unlink($in);
            return self::send(self::base($name) . '_nummeriert', '', $out);
        } catch (\Throwable $e) { @unlink($in); return Json::err($res, 'Seitenzahlen fehlgeschlagen.', 422); }
    }

    // ───────────────────────── stamp ────────────────────────────────────────

    public static function stamp(Request $req, Response $res): Response
    {
        $in = self::stash($req, $res, $name);
        if ($in instanceof Response) return $in;
        $b = self::body($req);
        $text = trim((string)($b['text'] ?? 'BEZAHLT')); if ($text === '') $text = 'BEZAHLT';
        $pos = (string)($b['position'] ?? 'oben-rechts');
        [$r, $g, $bl] = self::COLORS[strtolower((string)($b['color'] ?? 'rot'))] ?? self::COLORS['rot'];
        $withDate = in_array((string)($b['date'] ?? ''), ['1', 'true', 'on'], true);
        $label = $text . ($withDate ? '  ' . date('d.m.Y') : '');
        try {
            $pdf = new NyzaPdf();
            $count = $pdf->setSourceFile($in);
            for ($p = 1; $p <= $count; $p++) {
                $tpl = $pdf->importPage($p); $s = $pdf->getTemplateSize($tpl);
                $land = $s['width'] > $s['height'];
                $pdf->AddPage($land ? 'L' : 'P', [$s['width'], $s['height']]);
                $pdf->useTemplate($tpl, 0, 0, $s['width'], $s['height']);
                self::drawStamp($pdf, $s['width'], $s['height'], $pos, NyzaPdf::enc($label), $r, $g, $bl);
            }
            $out = $pdf->Output('S');
            @unlink($in);
            return self::send(self::base($name) . '_stempel', '', $out);
        } catch (\Throwable $e) { @unlink($in); return Json::err($res, 'Stempel fehlgeschlagen.', 422); }
    }

    // ───────────────────────── Bates numbering ──────────────────────────────

    public static function bates(Request $req, Response $res): Response
    {
        $in = self::stash($req, $res, $name);
        if ($in instanceof Response) return $in;
        $b = self::body($req);
        $prefix = (string)($b['prefix'] ?? '');
        $start = (int)($b['start'] ?? 1);
        $digits = (int)($b['digits'] ?? 6); $digits = max(1, min(10, $digits));
        $pos = (string)($b['position'] ?? 'unten-rechts');
        try {
            $pdf = new NyzaPdf();
            $count = $pdf->setSourceFile($in);
            for ($p = 1; $p <= $count; $p++) {
                $tpl = $pdf->importPage($p); $s = $pdf->getTemplateSize($tpl);
                $land = $s['width'] > $s['height'];
                $pdf->AddPage($land ? 'L' : 'P', [$s['width'], $s['height']]);
                $pdf->useTemplate($tpl, 0, 0, $s['width'], $s['height']);
                $pdf->SetFont('Courier', 'B', 10);
                $pdf->SetTextColor(40, 40, 40);
                $num = $prefix . str_pad((string)($start + $p - 1), $digits, '0', STR_PAD_LEFT);
                self::placeText($pdf, $s['width'], $s['height'], $pos, NyzaPdf::enc($num));
            }
            $out = $pdf->Output('S');
            @unlink($in);
            return self::send(self::base($name) . '_bates', '', $out);
        } catch (\Throwable $e) { @unlink($in); return Json::err($res, 'Bates-Nummerierung fehlgeschlagen.', 422); }
    }

    // ───────────────────────── images → PDF ─────────────────────────────────

    public static function images(Request $req, Response $res): Response
    {
        $files = $req->getUploadedFiles()['files'] ?? [];
        if (!is_array($files)) $files = [$files];
        $files = array_values(array_filter($files, fn($f) => $f && $f->getError() === UPLOAD_ERR_OK));
        if (!$files) return Json::err($res, 'Bitte mindestens ein Bild wählen', 422);
        $fit = (string)(self::body($req)['fit'] ?? 'a4');
        $paths = [];
        try {
            $pdf = new NyzaPdf();
            foreach ($files as $f) {
                if ((int)$f->getSize() > self::MAX) continue;
                $mt = strtolower((string)$f->getClientMediaType());
                $ext = str_contains($mt, 'png') ? 'png' : (str_contains($mt, 'gif') ? 'gif' : 'jpg');
                $tmp = Storage::temp() . '/pdfimg_' . bin2hex(random_bytes(6)) . '.' . $ext;
                $f->moveTo($tmp); $paths[] = $tmp;
                $info = @getimagesize($tmp); if (!$info) continue;
                [$pxW, $pxH] = $info;
                $type = $info[2] === IMAGETYPE_PNG ? 'PNG' : ($info[2] === IMAGETYPE_GIF ? 'GIF' : 'JPG');
                if ($fit === 'image') {          // page = image size (96 dpi → mm)
                    $mmW = $pxW * 25.4 / 96; $mmH = $pxH * 25.4 / 96;
                    $pdf->AddPage($mmW > $mmH ? 'L' : 'P', [$mmW, $mmH]);
                    $pdf->Image($tmp, 0, 0, $mmW, $mmH, $type);
                } else {                          // fit onto A4 with margin
                    $land = $pxW > $pxH;
                    [$pw, $ph] = $land ? [297.0, 210.0] : [210.0, 297.0];
                    $pdf->AddPage($land ? 'L' : 'P', [$pw, $ph]);
                    $pad = 10; $iw = $pw - 2 * $pad; $ih = $ph - 2 * $pad;
                    $scale = min($iw / $pxW, $ih / $pxH);
                    $w = $pxW * $scale; $h = $pxH * $scale;
                    $pdf->Image($tmp, ($pw - $w) / 2, ($ph - $h) / 2, $w, $h, $type);
                }
            }
            $out = $pdf->Output('S');
            self::cleanup($paths);
            if ($out === '') return Json::err($res, 'Keine gültigen Bilder', 422);
            return self::send('bilder', '', $out);
        } catch (\Throwable $e) { self::cleanup($paths); return Json::err($res, 'Bilder-Umwandlung fehlgeschlagen.', 422); }
    }

    // ───────────────────────── helpers ──────────────────────────────────────

    /** Copy given source pages (with optional per-page rotation) into a new PDF. */
    private static function buildFrom(string $src, array $pages, array $rot = []): string
    {
        $pdf = new NyzaPdf();
        $pdf->setSourceFile($src);
        foreach ($pages as $i => $p) self::place($pdf, $pdf->importPage($p), $rot[$i] ?? 0);
        return $pdf->Output('S');
    }

    private static function place(NyzaPdf $pdf, $tpl, int $rotation = 0): void
    {
        $s = $pdf->getTemplateSize($tpl);
        $pdf->AddPage($s['width'] > $s['height'] ? 'L' : 'P', [$s['width'], $s['height']], $rotation);
        $pdf->useTemplate($tpl, 0, 0, $s['width'], $s['height']);
    }

    /** Place a short one-line text at a named position with an ~8mm margin. */
    private static function placeText(NyzaPdf $pdf, float $w, float $h, string $pos, string $txt): void
    {
        $m = 8; $tw = $pdf->GetStringWidth($txt);
        [$vert, $horiz] = array_pad(explode('-', $pos), 2, 'mitte');
        $y = $vert === 'oben' ? $m + 4 : $h - $m;
        $x = $horiz === 'links' ? $m : ($horiz === 'rechts' ? $w - $m - $tw : ($w - $tw) / 2);
        $pdf->Text($x, $y, $txt);
    }

    private static function drawStamp(NyzaPdf $pdf, float $w, float $h, string $pos, string $txt, int $r, int $g, int $b): void
    {
        $pdf->SetFont('Helvetica', 'B', 20);
        $tw = $pdf->GetStringWidth($txt); $bw = $tw + 12; $bh = 12; $m = 10;
        [$vert, $horiz] = array_pad(explode('-', $pos), 2, 'rechts');
        $x = $horiz === 'links' ? $m : ($horiz === 'mitte' ? ($w - $bw) / 2 : $w - $m - $bw);
        $y = $vert === 'unten' ? $h - $m - $bh : $m;
        $pdf->SetDrawColor($r, $g, $b); $pdf->SetTextColor($r, $g, $b); $pdf->SetLineWidth(0.8);
        $pdf->Rect($x, $y, $bw, $bh);
        $pdf->Text($x + 6, $y + $bh - 3.5, $txt);
    }

    private static function parseRanges(string $spec, int $max): array
    {
        $out = [];
        foreach (preg_split('/[,\s]+/', trim($spec)) as $part) {
            if ($part === '') continue;
            if (preg_match('/^(\d+)\s*-\s*(\d+)$/', $part, $m)) {
                $a = (int)$m[1]; $b = (int)$m[2]; if ($a > $b) { $t = $a; $a = $b; $b = $t; }
                for ($i = $a; $i <= $b; $i++) if ($i >= 1 && $i <= $max) $out[] = $i;
            } elseif (ctype_digit($part)) {
                $i = (int)$part; if ($i >= 1 && $i <= $max) $out[] = $i;
            }
        }
        return $out;
    }

    /** Validate + move the uploaded 'file' to a temp path. Returns path, or a Response on error. */
    private static function stash(Request $req, Response $res, &$name = null)
    {
        $file = $req->getUploadedFiles()['file'] ?? null;
        if (!$file || $file->getError() !== UPLOAD_ERR_OK) return Json::err($res, 'Keine Datei', 422);
        if ((int)$file->getSize() > self::MAX) return Json::err($res, 'Datei zu groß (max 80 MB)', 413);
        $name = (string)($file->getClientFilename() ?: 'dokument.pdf');
        $mime = strtolower((string)$file->getClientMediaType());
        if (!str_contains($mime, 'pdf') && !preg_match('/\.pdf$/i', $name)) return Json::err($res, 'Bitte eine PDF-Datei hochladen', 415);
        $in = Storage::temp() . '/pdfin_' . bin2hex(random_bytes(6)) . '.pdf';
        $file->moveTo($in);
        return $in;
    }

    private static function body(Request $req): array { return (array)$req->getParsedBody(); }
    private static function base(string $name): string { return preg_replace('/\.[a-z0-9]+$/i', '', $name) ?: 'dokument'; }
    private static function cleanup(array $paths): void { foreach ($paths as $p) @unlink($p); }

    private static function send(string $base, string $suffix, string $bytes, string $mime = 'application/pdf', string $ext = 'pdf'): Response
    {
        $fname = self::base($base) . ($suffix !== '' ? '_' . $suffix : '') . '.' . $ext;
        while (ob_get_level() > 0) { @ob_end_clean(); }
        header('Content-Type: ' . $mime);
        header('Content-Disposition: attachment; filename="' . addslashes($fname) . '"');
        header('Content-Length: ' . strlen($bytes));
        header('Cache-Control: private, max-age=0, must-revalidate');
        echo $bytes;
        exit;
    }

    // ───────────────────────── format-change engines ────────────────────────

    private static function viaFpdi(string $in, float $mmW, float $mmH): ?string
    {
        if (!class_exists(Fpdi::class)) return null;
        try {
            $pdf = new Fpdi('P', 'mm');
            $pages = $pdf->setSourceFile($in);
            for ($p = 1; $p <= $pages; $p++) {
                $tpl = $pdf->importPage($p); $s = $pdf->getTemplateSize($tpl);
                $land = $s['width'] > $s['height'];
                $pdf->AddPage($land ? 'L' : 'P', [$mmW, $mmH]);
                $pageW = $pdf->GetPageWidth(); $pageH = $pdf->GetPageHeight();
                $scale = min($pageW / $s['width'], $pageH / $s['height']);
                $w = $s['width'] * $scale; $h = $s['height'] * $scale;
                $pdf->useTemplate($tpl, ($pageW - $w) / 2, ($pageH - $h) / 2, $w, $h);
            }
            $out = $pdf->Output('S');
            return $out !== '' ? $out : null;
        } catch (\Throwable $e) { return null; }
    }

    private static function viaPdftocairo(string $in, float $mmW, float $mmH): ?string
    {
        if (self::which('pdftocairo') === null) return null;
        $ptW = (int)round($mmW * 72 / 25.4); $ptH = (int)round($mmH * 72 / 25.4);
        if (self::isLandscape($in)) { $t = $ptW; $ptW = $ptH; $ptH = $t; }
        $out = Storage::temp() . '/pdfout_' . bin2hex(random_bytes(6)) . '.pdf';
        $cmd = 'pdftocairo -pdf -paperw ' . $ptW . ' -paperh ' . $ptH . ' -expand '
             . escapeshellarg($in) . ' ' . escapeshellarg($out) . ' 2>&1';
        $o = []; $code = 1; @exec($cmd, $o, $code);
        if ($code !== 0 || !is_file($out) || filesize($out) === 0) { @unlink($out); return null; }
        $bytes = (string)file_get_contents($out); @unlink($out);
        return $bytes !== '' ? $bytes : null;
    }

    private static function isLandscape(string $path): bool
    {
        if (self::which('pdfinfo') === null) return false;
        $o = []; $c = 1;
        @exec('pdfinfo ' . escapeshellarg($path) . ' 2>/dev/null', $o, $c);
        if ($c !== 0) return false;
        foreach ($o as $line) {
            if (preg_match('/^Page size:\s*([\d.]+)\s*x\s*([\d.]+)/i', $line, $m)) return (float)$m[1] > (float)$m[2];
        }
        return false;
    }

    private static function which(string $bin): ?string
    {
        if (!function_exists('exec')) return null;
        $out = []; $code = 1;
        @exec('command -v ' . escapeshellarg($bin) . ' 2>/dev/null', $out, $code);
        return ($code === 0 && !empty($out[0])) ? trim($out[0]) : null;
    }
}
