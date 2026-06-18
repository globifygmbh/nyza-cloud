<?php
declare(strict_types=1);

namespace Nyza\Routes;

use Nyza\Database;
use Nyza\Json;
use Nyza\Ocr;
use Nyza\Storage;
use Nyza\Middleware\AuthMiddleware;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;
use Slim\Routing\RouteCollectorProxy;

/**
 * Receipt OCR endpoints. Run an uploaded file or an existing DMS file through
 * Tesseract/pdftotext and return suggested expense fields for the form to
 * prefill. Reading-only — nothing is stored here.
 */
final class OcrRoutes
{
    private const MAX = 20 * 1024 * 1024;

    public static function mount(App $app): void
    {
        $app->group('/api/ocr', function (RouteCollectorProxy $g) {
            $g->get('/status',       [self::class, 'status']);
            $g->post('/receipt',     [self::class, 'receipt']);
            $g->post('/receipt-file',[self::class, 'receiptFile']);
        })->add(new AuthMiddleware());
    }

    public static function status(Request $req, Response $res): Response
    {
        return Json::ok($res, ['available' => Ocr::available()]);
    }

    public static function receipt(Request $req, Response $res): Response
    {
        if (!Ocr::available()) return Json::err($res, 'OCR ist auf dem Server nicht verfügbar', 503);
        $file = $req->getUploadedFiles()['file'] ?? null;
        if (!$file || $file->getError() !== UPLOAD_ERR_OK) return Json::err($res, 'Keine Datei', 422);
        if ((int)$file->getSize() > self::MAX) return Json::err($res, 'Datei zu groß (max 20 MB)', 413);
        $mime = $file->getClientMediaType() ?: 'application/octet-stream';
        $tmp = Storage::temp() . '/ocrup_' . bin2hex(random_bytes(8));
        $file->moveTo($tmp);
        try {
            $text = Ocr::extractText($tmp, $mime);
        } finally {
            @unlink($tmp);
        }
        return self::result($res, $text);
    }

    public static function receiptFile(Request $req, Response $res): Response
    {
        if (!Ocr::available()) return Json::err($res, 'OCR ist auf dem Server nicht verfügbar', 503);
        $uid = (int)$req->getAttribute('uid');
        $b = (array)$req->getParsedBody();
        $fileId = (int)($b['file_id'] ?? 0);
        if ($fileId <= 0) return Json::err($res, 'Keine Datei', 422);
        $s = Database::pdo()->prepare('SELECT storage_path, mime_type, size FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL');
        $s->execute([$fileId, $uid]);
        $f = $s->fetch();
        if (!$f) return Json::err($res, 'Datei nicht gefunden', 404);
        if ((int)$f['size'] > self::MAX) return Json::err($res, 'Datei zu groß (max 20 MB)', 413);
        $abs = Storage::abs($f['storage_path']);
        if (!is_file($abs)) return Json::err($res, 'Datei nicht gefunden', 404);
        $text = Ocr::extractText($abs, (string)($f['mime_type'] ?: 'application/octet-stream'));
        return self::result($res, $text);
    }

    private static function result(Response $res, string $text): Response
    {
        if (trim($text) === '') return Json::err($res, 'Kein Text erkannt — Beleg evtl. zu unscharf', 422);
        return Json::ok($res, ['suggestion' => Ocr::parse($text)]);
    }
}
