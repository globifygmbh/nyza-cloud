<?php
declare(strict_types=1);

namespace Nyza\Routes;

use Nyza\Json;
use Nyza\Storage;
use Nyza\Middleware\AuthMiddleware;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;
use Slim\Routing\RouteCollectorProxy;
use setasign\Fpdi\Fpdi;

/**
 * PDF tools. First tool: change the paper format (A0–A6) of an uploaded PDF —
 * every page is scaled to the chosen ISO A size.
 *
 * Engine: FPDI (pure PHP, vendored via composer) — needs NO system binaries and
 * works even if exec() is disabled on the host. Each source page is imported as
 * a template and placed, centred and aspect-preserving, onto a new page of the
 * target size. A compressed/encrypted PDF that the free parser cannot read falls
 * back to `pdftocairo` (poppler) when that binary happens to be available.
 */
final class PdfRoutes
{
    private const MAX = 60 * 1024 * 1024;
    // ISO A sizes in millimetres (portrait).
    private const SIZES = [
        'A0' => [841, 1189], 'A1' => [594, 841], 'A2' => [420, 594], 'A3' => [297, 420],
        'A4' => [210, 297], 'A5' => [148, 210], 'A6' => [105, 148],
    ];

    public static function mount(App $app): void
    {
        $app->group('/api/pdf', function (RouteCollectorProxy $g) {
            $g->get('/status',  [self::class, 'status']);
            $g->post('/resize', [self::class, 'resize']);
        })->add(new AuthMiddleware());
    }

    public static function status(Request $req, Response $res): Response
    {
        // FPDI is bundled, so the tool is always available — no server install needed.
        return Json::ok($res, [
            'available' => class_exists(Fpdi::class),
            'engine'    => class_exists(Fpdi::class) ? 'fpdi' : 'none',
            'formats'   => array_keys(self::SIZES),
        ]);
    }

    public static function resize(Request $req, Response $res): Response
    {
        $file = $req->getUploadedFiles()['file'] ?? null;
        if (!$file || $file->getError() !== UPLOAD_ERR_OK) return Json::err($res, 'Keine Datei', 422);
        if ((int)$file->getSize() > self::MAX) return Json::err($res, 'Datei zu groß (max 60 MB)', 413);
        $mime = strtolower((string)($file->getClientMediaType() ?: ''));
        $name = (string)($file->getClientFilename() ?: 'dokument.pdf');
        if (!str_contains($mime, 'pdf') && !preg_match('/\.pdf$/i', $name)) return Json::err($res, 'Bitte eine PDF-Datei hochladen', 415);

        $b = (array)$req->getParsedBody();
        $fmt = strtoupper(trim((string)($b['format'] ?? 'A4')));
        if (!isset(self::SIZES[$fmt])) return Json::err($res, 'Unbekanntes Format', 422);
        [$mmW, $mmH] = self::SIZES[$fmt];

        $in = Storage::temp() . '/pdfin_' . bin2hex(random_bytes(6)) . '.pdf';
        $file->moveTo($in);

        // 1) Pure-PHP path (no binaries). Handles the vast majority of PDFs.
        $bytes = self::viaFpdi($in, $mmW, $mmH);

        // 2) Compressed / encrypted PDF the free parser can't read → try poppler if present.
        if ($bytes === null) $bytes = self::viaPdftocairo($in, $mmW, $mmH);

        @unlink($in);
        if ($bytes === null) {
            return Json::err($res, 'Diese PDF konnte nicht umgewandelt werden (evtl. komprimiert oder passwortgeschützt).', 422);
        }

        $base = preg_replace('/\.pdf$/i', '', $name);
        while (ob_get_level() > 0) { @ob_end_clean(); }
        header('Content-Type: application/pdf');
        header('Content-Disposition: attachment; filename="' . addslashes($base) . '_' . $fmt . '.pdf"');
        header('Content-Length: ' . strlen($bytes));
        header('Cache-Control: private, max-age=0, must-revalidate');
        echo $bytes;
        exit;
    }

    /** Rebuild the PDF with FPDI, one target page per source page. Returns bytes or null on failure. */
    private static function viaFpdi(string $in, float $mmW, float $mmH): ?string
    {
        if (!class_exists(Fpdi::class)) return null;
        try {
            $pdf = new Fpdi('P', 'mm');       // orientation is set per page below
            $pages = $pdf->setSourceFile($in);
            for ($p = 1; $p <= $pages; $p++) {
                $tpl  = $pdf->importPage($p);
                $size = $pdf->getTemplateSize($tpl); // width/height in mm
                $landscape = $size['width'] > $size['height'];
                // FPDF portrait-normalises the size array, then applies the orientation letter.
                $pdf->AddPage($landscape ? 'L' : 'P', [$mmW, $mmH]);
                $pageW = $pdf->GetPageWidth();
                $pageH = $pdf->GetPageHeight();
                $scale = min($pageW / $size['width'], $pageH / $size['height']);
                $w = $size['width']  * $scale;
                $h = $size['height'] * $scale;
                $pdf->useTemplate($tpl, ($pageW - $w) / 2, ($pageH - $h) / 2, $w, $h);
            }
            $out = $pdf->Output('S');
            return ($out !== '' ) ? $out : null;
        } catch (\Throwable $e) {
            return null;
        }
    }

    /** Poppler fallback for PDFs FPDI can't parse. Returns bytes or null when unavailable/failed. */
    private static function viaPdftocairo(string $in, float $mmW, float $mmH): ?string
    {
        if (self::which('pdftocairo') === null) return null;
        $ptW = (int)round($mmW * 72 / 25.4);
        $ptH = (int)round($mmH * 72 / 25.4);
        if (self::isLandscape($in)) { $t = $ptW; $ptW = $ptH; $ptH = $t; }
        $out = Storage::temp() . '/pdfout_' . bin2hex(random_bytes(6)) . '.pdf';
        $cmd = 'pdftocairo -pdf -paperw ' . $ptW . ' -paperh ' . $ptH . ' -expand '
             . escapeshellarg($in) . ' ' . escapeshellarg($out) . ' 2>&1';
        $o = []; $code = 1; @exec($cmd, $o, $code);
        if ($code !== 0 || !is_file($out) || filesize($out) === 0) { @unlink($out); return null; }
        $bytes = (string)file_get_contents($out);
        @unlink($out);
        return $bytes !== '' ? $bytes : null;
    }

    private static function isLandscape(string $path): bool
    {
        if (self::which('pdfinfo') === null) return false;
        $o = []; $c = 1;
        @exec('pdfinfo ' . escapeshellarg($path) . ' 2>/dev/null', $o, $c);
        if ($c !== 0) return false;
        foreach ($o as $line) {
            if (preg_match('/^Page size:\s*([\d.]+)\s*x\s*([\d.]+)/i', $line, $m)) {
                return (float)$m[1] > (float)$m[2];
            }
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
