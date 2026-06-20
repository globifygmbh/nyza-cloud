<?php
declare(strict_types=1);

namespace Nyza\Routes;

use Nyza\CompanyContext;
use Nyza\Database;
use Nyza\Json;
use Nyza\Storage;
use Nyza\Middleware\AuthMiddleware;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;
use Slim\Psr7\Stream;
use Slim\Routing\RouteCollectorProxy;

/**
 * E-signature requests. The owner creates a request (optionally bound to a DMS
 * PDF/image); the signer opens a public token link, draws a signature and
 * confirms. We then render a signature certificate PDF (drawn signature + audit
 * trail: name, time, IP, SHA-256 of the source) and archive it in the owner's
 * DMS under "Signaturen". True in-place PDF stamping would need FPDI; the
 * certificate approach works for any document with only Dompdf.
 */
final class SignatureRoutes
{
    public static function mount(App $app): void
    {
        $app->group('/api/signatures', function (RouteCollectorProxy $g) {
            $g->get('',         [self::class, 'list']);
            $g->post('',        [self::class, 'create']);
            $g->delete('/{id}', [self::class, 'delete']);
        })->add(new AuthMiddleware());

        // Public (no auth) — the signer side.
        $app->get('/api/sign/{token}',       [self::class, 'publicInfo']);
        $app->get('/api/sign/{token}/file',  [self::class, 'publicFile']);
        $app->post('/api/sign/{token}',      [self::class, 'publicSign']);
    }

    public static function list(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $s = Database::pdo()->prepare(
            'SELECT s.*, f.name AS file_name FROM signature_requests s
             LEFT JOIN files f ON f.id = s.file_id
             WHERE s.user_id = ? ORDER BY s.created_at DESC LIMIT 200'
        );
        $s->execute([$uid]);
        return Json::ok($res, ['requests' => array_map([self::class, 'shape'], $s->fetchAll())]);
    }

    public static function create(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $b = (array)$req->getParsedBody();
        $title = trim((string)($b['title'] ?? ''));
        $fileId = (int)($b['file_id'] ?? 0);
        $docId = (int)($b['document_id'] ?? 0);
        $hash = null;

        if ($docId > 0) {
            $d = DocumentRoutes::docForSignature($cid, $docId);
            if (!$d) return Json::err($res, 'Dokument nicht gefunden', 404);
            if ($title === '') $title = ($d['type'] === 'offer' ? 'Angebot ' : 'Rechnung ') . $d['number'];
            $fileId = 0;
        } elseif ($fileId > 0) {
            $f = self::ownedFile($uid, $fileId);
            if (!$f) return Json::err($res, 'Datei nicht gefunden', 404);
            if ($title === '') $title = (string)$f['name'];
            $abs = Storage::abs($f['storage_path']);
            if (is_file($abs)) $hash = hash_file('sha256', $abs);
        }
        if ($title === '') return Json::err($res, 'Titel erforderlich', 422);

        $token = bin2hex(random_bytes(20));
        Database::pdo()->prepare(
            'INSERT INTO signature_requests (user_id, company_id, file_id, document_id, title, signer_name, signer_email, message, token, source_hash) '
            . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([
            $uid, $cid, $fileId > 0 ? $fileId : null, $docId > 0 ? $docId : null, mb_substr($title, 0, 255),
            self::str($b['signer_name'] ?? null, 255), self::str($b['signer_email'] ?? null, 255),
            self::str($b['message'] ?? null, 2000), $token, $hash,
        ]);
        $id = (int)Database::pdo()->lastInsertId();
        $row = self::fetchOwned($uid, $id);
        return Json::ok($res, ['request' => self::shape($row)], 201);
    }

    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        Database::pdo()->prepare('DELETE FROM signature_requests WHERE id = ? AND user_id = ?')
            ->execute([(int)$args['id'], $uid]);
        return Json::ok($res, ['ok' => true]);
    }

    // ───── public signer side ────────────────────────────────────────────────
    public static function publicInfo(Request $req, Response $res, array $args): Response
    {
        $r = self::byToken((string)$args['token']);
        if (!$r) return Json::err($res, 'Nicht gefunden', 404);
        $isDoc = $r['document_id'] !== null;
        return Json::ok($res, ['request' => [
            'title'       => $r['title'],
            'message'     => $r['message'],
            'signer_name' => $r['signer_name'],
            'status'      => $r['status'],
            'signed_at'   => $r['signed_at'],
            'has_file'    => $isDoc || $r['file_id'] !== null,
            'file_name'   => $isDoc ? ($r['title'] . '.pdf') : ($r['file_name'] ?? null),
            'file_mime'   => $isDoc ? 'application/pdf' : ($r['file_mime'] ?? null),
        ]]);
    }

    public static function publicFile(Request $req, Response $res, array $args): Response
    {
        $r = self::byToken((string)$args['token']);
        if (!$r) return Json::err($res, 'Nicht gefunden', 404);
        // Invoice/offer: render the live document PDF.
        if ($r['document_id'] !== null) {
            $d = DocumentRoutes::docForSignature((int)$r['company_id'], (int)$r['document_id']);
            if (!$d) return Json::err($res, 'Nicht gefunden', 404);
            $bytes = DocumentRoutes::pdfBytesFor((int)$r['user_id'], (int)$r['company_id'], $d);
            $res->getBody()->write($bytes);
            return $res->withHeader('Content-Type', 'application/pdf')
                ->withHeader('Content-Disposition', 'inline; filename="' . addslashes((string)$d['number']) . '.pdf"')
                ->withStatus(200);
        }
        if ($r['file_id'] === null) return Json::err($res, 'Nicht gefunden', 404);
        $abs = Storage::abs($r['storage_path']);
        if (!is_file($abs)) return Json::err($res, 'Nicht gefunden', 404);
        $mime = $r['file_mime'] ?: 'application/octet-stream';
        return $res
            ->withHeader('Content-Type', $mime)
            ->withHeader('Content-Disposition', 'inline; filename="' . addslashes((string)$r['file_name']) . '"')
            ->withHeader('X-Content-Type-Options', 'nosniff')
            ->withBody(new Stream(fopen($abs, 'rb')))
            ->withStatus(200);
    }

    public static function publicSign(Request $req, Response $res, array $args): Response
    {
        $r = self::byToken((string)$args['token']);
        if (!$r) return Json::err($res, 'Nicht gefunden', 404);
        if ($r['status'] !== 'pending') return Json::err($res, 'Bereits abgeschlossen', 409);
        $b = (array)$req->getParsedBody();
        $name = trim((string)($b['name'] ?? ''));
        $sig = (string)($b['signature'] ?? '');
        if ($name === '') return Json::err($res, 'Bitte Namen eingeben', 422);
        if (!preg_match('#^data:image/png;base64,#', $sig)) return Json::err($res, 'Unterschrift fehlt', 422);
        if (strlen($sig) > 2_000_000) return Json::err($res, 'Unterschrift zu groß', 413);

        $ip = self::clientIp($req);
        $when = date('Y-m-d H:i:s');

        if ($r['document_id'] !== null) {
            // Embed the signature into the invoice/offer PDF and replace the
            // document's archived PDF + mark it signed.
            $d = DocumentRoutes::docForSignature((int)$r['company_id'], (int)$r['document_id']);
            if (!$d) return Json::err($res, 'Dokument nicht gefunden', 404);
            $bytes = DocumentRoutes::pdfBytesFor((int)$r['user_id'], (int)$r['company_id'], $d, [
                'image' => $sig, 'name' => $name, 'date' => date('d.m.Y H:i', strtotime($when)) . ' Uhr', 'ip' => $ip,
            ]);
            $fileId = DocumentRoutes::applySignedPdf((int)$r['user_id'], (int)$r['company_id'], $d, $bytes);
        } else {
            $fileId = self::buildCertificate($r, $name, $sig, $ip, $when);
        }

        Database::pdo()->prepare(
            'UPDATE signature_requests SET status = ?, signed_name = ?, signed_at = ?, signer_ip = ?, signed_file_id = ? WHERE id = ?'
        )->execute(['signed', mb_substr($name, 0, 255), $when, $ip, $fileId, (int)$r['id']]);

        return Json::ok($res, ['ok' => true]);
    }

    // ───── certificate ───────────────────────────────────────────────────────
    private static function buildCertificate(array $r, string $name, string $sigDataUrl, string $ip, string $when): ?int
    {
        $uid = (int)$r['user_id'];
        $esc = static fn($s) => htmlspecialchars((string)$s, ENT_QUOTES);
        $hash = $r['source_hash'] ? $esc($r['source_hash']) : '—';
        $whenDe = date('d.m.Y H:i', strtotime($when));
        $html = '<!doctype html><html><head><meta charset="utf-8"><style>'
            . 'body{font-family:DejaVu Sans,Arial,sans-serif;color:#1a1a1a;padding:32px;}'
            . 'h1{font-size:20px;margin:0 0 4px;} .sub{color:#666;font-size:12px;margin-bottom:24px;}'
            . '.box{border:1px solid #ddd;border-radius:8px;padding:18px 20px;margin-bottom:18px;}'
            . '.row{font-size:13px;margin:6px 0;} .lbl{color:#888;display:inline-block;width:150px;}'
            . '.sig{border:1px solid #ddd;border-radius:8px;padding:10px;text-align:center;}'
            . '.sig img{max-height:120px;max-width:380px;} .hash{font-family:DejaVu Sans Mono,monospace;font-size:9px;word-break:break-all;color:#666;}'
            . '</style></head><body>'
            . '<h1>Unterschriften-Zertifikat</h1>'
            . '<div class="sub">Elektronisch signiert &uuml;ber Nyza Cloud</div>'
            . '<div class="box"><div class="row"><span class="lbl">Dokument</span>' . $esc($r['title']) . '</div>'
            . ($r['file_name'] ? '<div class="row"><span class="lbl">Datei</span>' . $esc($r['file_name']) . '</div>' : '')
            . '<div class="row"><span class="lbl">Unterzeichner</span>' . $esc($name) . '</div>'
            . ($r['signer_email'] ? '<div class="row"><span class="lbl">E-Mail</span>' . $esc($r['signer_email']) . '</div>' : '')
            . '<div class="row"><span class="lbl">Zeitpunkt</span>' . $esc($whenDe) . ' Uhr</div>'
            . '<div class="row"><span class="lbl">IP-Adresse</span>' . $esc($ip) . '</div>'
            . '<div class="row"><span class="lbl">Dokument-Hash (SHA-256)</span></div><div class="hash">' . $hash . '</div>'
            . '</div>'
            . '<div class="sig"><img src="' . $sigDataUrl . '"><div style="font-size:11px;color:#888;margin-top:6px;">Unterschrift &middot; ' . $esc($name) . '</div></div>'
            . '</body></html>';

        $dompdf = new \Dompdf\Dompdf(['isRemoteEnabled' => true, 'defaultFont' => 'DejaVu Sans']);
        $dompdf->loadHtml($html, 'UTF-8');
        $dompdf->setPaper('A4');
        $dompdf->render();
        $bytes = $dompdf->output();

        $folderId = self::findOrCreateFolder($uid, null, 'Signaturen');
        $base = preg_replace('/\.[A-Za-z0-9]+$/', '', (string)$r['title']);
        $fname = self::safe($base) . ' – signiert.pdf';
        $tmp = Storage::temp() . '/sig_' . bin2hex(random_bytes(6)) . '.pdf';
        if (file_put_contents($tmp, $bytes) === false) return null;
        try {
            $file = FileRoutes::ingestPath($uid, $folderId, $fname, $tmp, 'application/pdf');
            return (int)($file['id'] ?? 0) ?: null;
        } catch (\Throwable $e) {
            @unlink($tmp);
            return null;
        }
    }

    private static function findOrCreateFolder(int $uid, ?int $parent, string $name): int
    {
        $pdo = Database::pdo();
        $s = $pdo->prepare('SELECT id FROM folders WHERE user_id = ? AND parent_id <=> ? AND name = ? AND deleted_at IS NULL LIMIT 1');
        $s->execute([$uid, $parent, $name]);
        if ($row = $s->fetch()) return (int)$row['id'];
        $pdo->prepare('INSERT INTO folders (user_id, parent_id, name, kind, tone) VALUES (?, ?, ?, ?, ?)')
            ->execute([$uid, $parent, $name, 'normal', 'teal']);
        return (int)$pdo->lastInsertId();
    }

    // ───── helpers ───────────────────────────────────────────────────────────
    private static function byToken(string $token): ?array
    {
        $s = Database::pdo()->prepare(
            'SELECT s.*, f.name AS file_name, f.mime_type AS file_mime, f.storage_path AS storage_path
             FROM signature_requests s LEFT JOIN files f ON f.id = s.file_id
             WHERE s.token = ? LIMIT 1'
        );
        $s->execute([$token]);
        return $s->fetch() ?: null;
    }

    private static function fetchOwned(int $uid, int $id): array
    {
        $s = Database::pdo()->prepare(
            'SELECT s.*, f.name AS file_name FROM signature_requests s LEFT JOIN files f ON f.id = s.file_id WHERE s.id = ? AND s.user_id = ?'
        );
        $s->execute([$id, $uid]);
        return $s->fetch() ?: [];
    }

    private static function ownedFile(int $uid, int $id): ?array
    {
        $s = Database::pdo()->prepare('SELECT id, name, storage_path, mime_type FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL');
        $s->execute([$id, $uid]);
        return $s->fetch() ?: null;
    }

    private static function shape(array $r): array
    {
        return [
            'id'            => (int)$r['id'],
            'title'         => $r['title'],
            'signer_name'   => $r['signer_name'],
            'signer_email'  => $r['signer_email'],
            'status'        => $r['status'],
            'token'         => $r['token'],
            'file_id'       => $r['file_id'] !== null ? (int)$r['file_id'] : null,
            'file_name'     => $r['file_name'] ?? null,
            'signed_name'   => $r['signed_name'] ?? null,
            'signed_at'     => $r['signed_at'] ?? null,
            'signed_file_id'=> isset($r['signed_file_id']) && $r['signed_file_id'] !== null ? (int)$r['signed_file_id'] : null,
            'created_at'    => $r['created_at'] ?? null,
        ];
    }

    private static function str($v, int $max): ?string
    {
        if ($v === null) return null;
        $v = trim((string)$v);
        return $v === '' ? null : mb_substr($v, 0, $max);
    }

    private static function safe(string $s): string
    {
        $s = preg_replace('/[\/\\\\:*?"<>|]+/', '_', trim($s));
        return mb_substr($s === '' ? 'Dokument' : $s, 0, 100);
    }

    private static function clientIp(Request $req): string
    {
        $h = $req->getHeaderLine('X-Forwarded-For');
        if ($h !== '') return trim(explode(',', $h)[0]);
        $sp = $req->getServerParams();
        return (string)($sp['REMOTE_ADDR'] ?? '');
    }
}
