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

/**
 * PDF tools. First tool: change the paper format (A0–A6) of an uploaded PDF —
 * every page is scaled to the chosen ISO A size via `pdftocairo` (poppler,
 * already present for OCR). Compression / merge / split come later.
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
        return Json::ok($res, ['available' => self::which('pdftocairo') !== null, 'formats' => array_keys(self::SIZES)]);
    }

    public static function resize(Request $req, Response $res): Response
    {
        if (self::which('pdftocairo') === null) return Json::err($res, 'PDF-Tools nicht verfügbar (poppler/pdftocairo fehlt)', 503);
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
        $ptW = (int)round($mmW * 72 / 25.4);
        $ptH = (int)round($mmH * 72 / 25.4);

        $in = Storage::temp() . '/pdfin_' . bin2hex(random_bytes(6)) . '.pdf';
        $out = Storage::temp() . '/pdfout_' . bin2hex(random_bytes(6)) . '.pdf';
        $file->moveTo($in);

        // Match the source orientation so a landscape page maps to landscape paper.
        if (self::isLandscape($in)) { $t = $ptW; $ptW = $ptH; $ptH = $t; }

        $cmd = 'pdftocairo -pdf -paperw ' . $ptW . ' -paperh ' . $ptH . ' -expand '
             . escapeshellarg($in) . ' ' . escapeshellarg($out) . ' 2>&1';
        $o = []; $code = 1; @exec($cmd, $o, $code);
        @unlink($in);
        if ($code !== 0 || !is_file($out) || filesize($out) === 0) {
            @unlink($out);
            return Json::err($res, 'Konvertierung fehlgeschlagen', 500);
        }
        $bytes = (string)file_get_contents($out);
        @unlink($out);

        $base = preg_replace('/\.pdf$/i', '', $name);
        while (ob_get_level() > 0) { @ob_end_clean(); }
        header('Content-Type: application/pdf');
        header('Content-Disposition: attachment; filename="' . addslashes($base) . '_' . $fmt . '.pdf"');
        header('Content-Length: ' . strlen($bytes));
        header('Cache-Control: private, max-age=0, must-revalidate');
        echo $bytes;
        exit;
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
        $out = []; $code = 1;
        @exec('command -v ' . escapeshellarg($bin) . ' 2>/dev/null', $out, $code);
        return ($code === 0 && !empty($out[0])) ? trim($out[0]) : null;
    }
}
