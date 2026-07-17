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
 * Accounting documents — offers (Angebote) and invoices (Rechnungen). Each has
 * a frozen client_snapshot so historic documents never change when the linked
 * contact is later edited. Numbers come from a per-user, per-type counter that
 * starts at 1000. PDFs are rendered server-side via Dompdf in the brand style.
 */
final class DocumentRoutes
{
    private const TYPES = ['offer', 'invoice'];
    private const ACCENT = '#7C5CFF';

    public static function mount(App $app): void
    {
        $app->group('/api/documents', function (RouteCollectorProxy $g) {
            $g->get('',                  [self::class, 'list']);
            $g->post('',                 [self::class, 'create']);
            $g->get('/mail-template',    [self::class, 'getMailTemplate']);
            $g->put('/mail-template',    [self::class, 'putMailTemplate']);
            $g->post('/{id}/email',      [self::class, 'email']);
            $g->get('/{id}',             [self::class, 'show']);
            $g->patch('/{id}',           [self::class, 'update']);
            $g->delete('/{id}',          [self::class, 'delete']);
            $g->post('/{id}/mark-paid',  [self::class, 'markPaid']);
            $g->post('/{id}/unmark-paid',[self::class, 'unmarkPaid']);
            $g->post('/{id}/convert',    [self::class, 'convert']);
            $g->get('/{id}/pdf',         [self::class, 'pdf']);
            $g->post('/{id}/archive',    [self::class, 'archive']);
            $g->post('/{id}/sign-upload',  [self::class, 'signUpload']);
            $g->post('/{id}/mark-signed',  [self::class, 'markSigned']);
            $g->post('/{id}/unmark-signed',[self::class, 'unmarkSigned']);
        })->add(new AuthMiddleware());
    }

    // ───── List ──────────────────────────────────────────────────────────────
    public static function list(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $qp = $req->getQueryParams();
        $pdo = Database::pdo();

        $where = 'd.company_id = ?';
        $params = [$cid];
        if (!empty($qp['type']) && in_array($qp['type'], self::TYPES, true)) {
            $where .= ' AND d.type = ?';
            $params[] = $qp['type'];
        }
        $stmt = $pdo->prepare(
            'SELECT d.*, c.name AS contact_name, '
            . '(SELECT MAX(stage) FROM reminders rm WHERE rm.document_id = d.id) AS reminder_stage '
            . 'FROM documents d '
            . 'LEFT JOIN contacts c ON c.id = d.contact_id '
            . "WHERE $where ORDER BY d.doc_date DESC, d.id DESC"
        );
        $stmt->execute($params);

        $termDays = CompanyContext::paymentTermDays($cid);
        $out = array_map(fn(array $r) => self::shapeHeader($r, $termDays), $stmt->fetchAll());
        return Json::ok($res, ['documents' => $out]);
    }

    // ───── Show (full + items) ───────────────────────────────────────────────
    public static function show(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $d = self::fetchOne($cid, (int)$args['id']);
        if (!$d) return Json::err($res, 'Not found', 404);
        return Json::ok($res, ['document' => self::shapeFull($uid, $cid, $d)]);
    }

    // ───── Create ────────────────────────────────────────────────────────────
    public static function create(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $b = (array) $req->getParsedBody();

        $type = (string)($b['type'] ?? 'invoice');
        if (!in_array($type, self::TYPES, true)) return Json::err($res, 'Ungültiger Dokumenttyp', 422);

        $contactId = isset($b['contact_id']) && $b['contact_id'] !== null && $b['contact_id'] !== ''
            ? (int)$b['contact_id'] : null;
        $docDate = self::parseDate($b['doc_date'] ?? null) ?? date('Y-m-d');
        $deliveryDate = self::parseDate($b['delivery_date'] ?? null);
        $intro = self::textOrNull($b['intro_text'] ?? null);
        $footer = self::textOrNull($b['footer_text'] ?? null);
        $notes = self::textOrNull($b['notes'] ?? null);

        $items = self::normalizeItems($b['items'] ?? []);
        $totals = self::computeTotals($items);
        $snapshot = self::buildSnapshot($uid, $contactId);
        // Pre-fill "z. Hd." from the contact's own contact_person, but leave
        // it freely editable per-document from here on (not written back).
        $attnName = array_key_exists('attn_name', $b)
            ? self::textOrNull($b['attn_name'])
            : self::textOrNull($snapshot['contact_person'] ?? null);

        $pdo = Database::pdo();
        $pdo->beginTransaction();
        try {
            $number = self::nextNumber($cid, $type === 'offer' ? 'offer' : 'invoice', $type === 'offer' ? 'AN-' : 'RE-');
            $pdo->prepare(
                'INSERT INTO documents (user_id, company_id, type, number, contact_id, attn_name, client_snapshot, doc_date, delivery_date, '
                . 'intro_text, footer_text, notes, net, tax, gross) '
                . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            )->execute([
                $uid, $cid, $type, $number, $contactId, $attnName, json_encode($snapshot, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
                $docDate, $deliveryDate, $intro, $footer, $notes,
                $totals['net'], $totals['tax'], $totals['gross'],
            ]);
            $docId = (int)$pdo->lastInsertId();
            self::insertItems($docId, $items);
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        $d = self::fetchOne($cid, $docId);
        return Json::ok($res, ['document' => self::shapeFull($uid, $cid, $d)], 201);
    }

    // ───── Update ────────────────────────────────────────────────────────────
    public static function update(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $id = (int)$args['id'];
        $d = self::fetchOne($cid, $id);
        if (!$d) return Json::err($res, 'Not found', 404);

        $b = (array) $req->getParsedBody();
        $pdo = Database::pdo();
        $sets = [];
        $params = [];

        // Header fields (never number / type).
        if (array_key_exists('contact_id', $b)) {
            $contactId = ($b['contact_id'] !== null && $b['contact_id'] !== '') ? (int)$b['contact_id'] : null;
            $sets[] = 'contact_id = ?'; $params[] = $contactId;
            // Refresh the snapshot whenever contact_id is sent in the body.
            $snapshot = self::buildSnapshot($uid, $contactId);
            $sets[] = 'client_snapshot = ?';
            $params[] = json_encode($snapshot, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        }
        if (array_key_exists('doc_date', $b)) {
            $sets[] = 'doc_date = ?'; $params[] = self::parseDate($b['doc_date']);
        }
        if (array_key_exists('delivery_date', $b)) {
            $sets[] = 'delivery_date = ?'; $params[] = self::parseDate($b['delivery_date']);
        }
        if (array_key_exists('intro_text', $b)) {
            $sets[] = 'intro_text = ?'; $params[] = self::textOrNull($b['intro_text']);
        }
        if (array_key_exists('footer_text', $b)) {
            $sets[] = 'footer_text = ?'; $params[] = self::textOrNull($b['footer_text']);
        }
        if (array_key_exists('notes', $b)) {
            $sets[] = 'notes = ?'; $params[] = self::textOrNull($b['notes']);
        }
        if (array_key_exists('attn_name', $b)) {
            $sets[] = 'attn_name = ?'; $params[] = self::textOrNull($b['attn_name']);
        }

        $pdo->beginTransaction();
        try {
            // Replace items if provided and recompute totals from them.
            if (array_key_exists('items', $b)) {
                $items = self::normalizeItems($b['items']);
                $pdo->prepare('DELETE FROM document_items WHERE document_id = ?')->execute([$id]);
                self::insertItems($id, $items);
                $totals = self::computeTotals($items);
                $sets[] = 'net = ?';   $params[] = $totals['net'];
                $sets[] = 'tax = ?';   $params[] = $totals['tax'];
                $sets[] = 'gross = ?'; $params[] = $totals['gross'];
            }
            if ($sets) {
                $params[] = $id; $params[] = $cid;
                $pdo->prepare('UPDATE documents SET ' . implode(', ', $sets) . ' WHERE id = ? AND company_id = ?')
                    ->execute($params);
            }
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        return Json::ok($res, ['document' => self::shapeFull($uid, $cid, self::fetchOne($cid, $id))]);
    }

    // ───── Delete ────────────────────────────────────────────────────────────
    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $id = (int)$args['id'];
        if (!self::fetchOne($cid, $id)) return Json::err($res, 'Not found', 404);
        Database::pdo()->prepare('DELETE FROM documents WHERE id = ? AND company_id = ?')->execute([$id, $cid]);
        return Json::ok($res, ['ok' => true]);
    }

    // ───── Mark paid / unpaid (invoices) ─────────────────────────────────────
    public static function markPaid(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $id = (int)$args['id'];
        $d = self::fetchOne($cid, $id);
        if (!$d) return Json::err($res, 'Not found', 404);
        if ($d['type'] === 'invoice') {
            $b = (array) $req->getParsedBody();
            $date = self::parseDate($b['paid_date'] ?? null);
            $paidAt = $date !== null ? $date . ' 00:00:00' : date('Y-m-d H:i:s');
            Database::pdo()->prepare('UPDATE documents SET paid_at = ? WHERE id = ? AND company_id = ?')
                ->execute([$paidAt, $id, $cid]);
        }
        return Json::ok($res, ['document' => self::shapeFull($uid, $cid, self::fetchOne($cid, $id))]);
    }

    public static function unmarkPaid(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $id = (int)$args['id'];
        if (!self::fetchOne($cid, $id)) return Json::err($res, 'Not found', 404);
        Database::pdo()->prepare('UPDATE documents SET paid_at = NULL WHERE id = ? AND company_id = ?')
            ->execute([$id, $cid]);
        return Json::ok($res, ['document' => self::shapeFull($uid, $cid, self::fetchOne($cid, $id))]);
    }

    // ───── Convert offer → invoice ───────────────────────────────────────────
    public static function convert(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $id = (int)$args['id'];
        $offer = self::fetchOne($cid, $id);
        if (!$offer) return Json::err($res, 'Not found', 404);
        if ($offer['type'] !== 'offer') return Json::err($res, 'Nur Angebote können umgewandelt werden', 422);

        $pdo = Database::pdo();
        $items = self::loadItems($id);
        $totals = self::computeTotals($items);

        $pdo->beginTransaction();
        try {
            $number = self::nextNumber($cid, 'invoice', 'RE-');
            $pdo->prepare(
                'INSERT INTO documents (user_id, company_id, type, number, contact_id, attn_name, client_snapshot, doc_date, delivery_date, '
                . 'intro_text, footer_text, notes, net, tax, gross, converted_from_offer_id) '
                . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            )->execute([
                $uid, $cid, 'invoice', $number, $offer['contact_id'], $offer['attn_name'] ?? null, $offer['client_snapshot'],
                date('Y-m-d'), $offer['delivery_date'], $offer['intro_text'], $offer['footer_text'], $offer['notes'],
                $totals['net'], $totals['tax'], $totals['gross'], $id,
            ]);
            $newId = (int)$pdo->lastInsertId();
            // Copy items verbatim, preserving order.
            $copy = array_map(static fn(array $it) => [
                'description'    => $it['description'],
                'note'           => $it['note'] ?? null,
                'quantity'       => $it['quantity'],
                'unit'           => $it['unit'],
                'unit_price_net' => $it['unit_price_net'],
                'tax_rate'       => $it['tax_rate'],
            ], $items);
            self::insertItems($newId, $copy);
            $pdo->prepare('UPDATE documents SET converted_invoice_id = ?, accepted_at = ? WHERE id = ? AND company_id = ?')
                ->execute([$newId, date('Y-m-d H:i:s'), $id, $cid]);
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        return Json::ok($res, ['document' => self::shapeFull($uid, $cid, self::fetchOne($cid, $newId))], 201);
    }

    // ───── PDF ───────────────────────────────────────────────────────────────
    public static function pdf(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $id = (int)$args['id'];
        $d = self::fetchOne($cid, $id);
        if (!$d) return Json::err($res, 'Not found', 404);

        $pdf = self::renderPdfBytes($uid, $cid, $d);

        $download = !empty($req->getQueryParams()['download']);
        $filename = $d['number'] . '.pdf';

        while (ob_get_level() > 0) { @ob_end_clean(); }
        header('Content-Type: application/pdf');
        header('Content-Disposition: ' . ($download ? 'attachment' : 'inline') . '; filename="' . addslashes($filename) . '"');
        header('Content-Length: ' . strlen($pdf));
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: private, max-age=0, must-revalidate');
        echo $pdf;
        exit;
    }

    /**
     * Render the document to PDF bytes via Dompdf. Shared by the streaming pdf()
     * endpoint and the archive() action so both produce byte-identical output.
     */
    private static function renderPdfBytes(int $uid, int $cid, array $doc, ?array $sig = null): string
    {
        $company = CompanyContext::profile($cid);
        $items = self::loadItems((int)$doc['id']);
        $html = self::renderHtml($uid, $doc, $items, $company, $sig);

        $dompdf = new \Dompdf\Dompdf([
            'isRemoteEnabled'      => $sig !== null,
            'isHtml5ParserEnabled' => true,
            'defaultFont'          => 'DejaVu Sans',
        ]);
        $dompdf->loadHtml($html, 'UTF-8');
        $dompdf->setPaper('A4', 'portrait');
        $dompdf->render();
        return $dompdf->output();
    }

    // ───── Archive (immutable PDF copy into the DMS) ──────────────────────────
    /**
     * Render the document's PDF and store it permanently as a real file in the
     * DMS, under Buchhaltung/<Rechnungen|Angebote>/<year>, so it shows up in the
     * file manager and can be viewed/downloaded there. Records the new file id on
     * the document. Always creates a fresh file (keeps prior archives as history).
     */
    public static function archive(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $id = (int)$args['id'];
        $d = self::fetchOne($cid, $id);
        if (!$d) return Json::err($res, 'Not found', 404);

        $bytes = self::renderPdfBytes($uid, $cid, $d);

        $year = self::archiveYear($d['doc_date'] ?? null);
        $sub = $d['type'] === 'offer' ? 'Angebote' : 'Rechnungen';
        $buchhaltungId = self::findOrCreateFolder($uid, null, 'Buchhaltung');
        $subId = self::findOrCreateFolder($uid, $buchhaltungId, $sub);
        $yearId = self::findOrCreateFolder($uid, $subId, $year);

        $name = $d['number'] . '.pdf';
        $rel = Storage::relPath($uid, $name);
        if (file_put_contents(Storage::abs($rel), $bytes) === false) {
            return Json::err($res, 'Archivieren fehlgeschlagen', 500);
        }

        $fileId = self::insertArchiveFile($uid, $yearId, $name, $rel, strlen($bytes));
        Database::pdo()->prepare('UPDATE documents SET archived_file_id = ? WHERE id = ? AND company_id = ?')
            ->execute([$fileId, $id, $cid]);

        return Json::ok($res, ['file_id' => $fileId, 'folder_id' => $yearId], 201);
    }

    /** Year for the archive folder, from doc_date (YYYY-…) or the current year. */
    private static function archiveYear(?string $docDate): string
    {
        if (is_string($docDate) && preg_match('/^(\d{4})/', $docDate, $m)) return $m[1];
        return date('Y');
    }

    /** Find a child folder by (user_id, parent_id, name) or create it; returns id. */
    private static function findOrCreateFolder(int $uid, ?int $parent, string $name): int
    {
        $pdo = Database::pdo();
        if ($parent === null) {
            $s = $pdo->prepare('SELECT id FROM folders WHERE user_id = ? AND parent_id IS NULL AND name = ? LIMIT 1');
            $s->execute([$uid, $name]);
        } else {
            $s = $pdo->prepare('SELECT id FROM folders WHERE user_id = ? AND parent_id = ? AND name = ? LIMIT 1');
            $s->execute([$uid, $parent, $name]);
        }
        if ($r = $s->fetch()) return (int)$r['id'];
        $pdo->prepare('INSERT INTO folders (user_id, parent_id, name, kind, tone) VALUES (?, ?, ?, ?, ?)')
            ->execute([$uid, $parent, $name, 'normal', 'violet']);
        return (int)$pdo->lastInsertId();
    }

    /**
     * Insert a `files` row for an archived PDF, mirroring FileRoutes::insertFile so
     * the archive behaves like a normal upload (kind/hue set, storage_used bumped,
     * activity logged). taken_at/upload_link_id/uploader_name are null for a
     * server-generated PDF.
     */
    private static function insertArchiveFile(int $uid, int $folderId, string $name, string $rel, int $size): int
    {
        $pdo = Database::pdo();
        $mime = 'application/pdf';
        $kind = Storage::kindFromMime($mime);
        $hue = (crc32($name) % 360);
        $pdo->prepare(
            'INSERT INTO files (user_id, folder_id, name, storage_path, mime_type, size, kind, hue, upload_link_id, uploader_name, taken_at) '
            . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([$uid, $folderId, $name, $rel, $mime, $size, $kind, $hue, null, null, null]);
        $id = (int)$pdo->lastInsertId();
        $pdo->prepare('UPDATE users SET storage_used = storage_used + ? WHERE id = ?')->execute([$size, $uid]);
        $pdo->prepare("INSERT INTO activity (user_id, kind, payload) VALUES (?, 'file_uploaded', ?)")
            ->execute([$uid, json_encode(['file_id' => $id, 'name' => $name, 'size' => $size])]);
        return $id;
    }

    // ───── Signing (public helpers used by SignatureRoutes) ───────────────────
    /** Fetch a document owned by the active company (for the signature flow). */
    public static function docForSignature(int $cid, int $id): ?array
    {
        return self::fetchOne($cid, $id);
    }

    /** Render the document PDF, optionally with an embedded signature block. */
    public static function pdfBytesFor(int $uid, int $cid, array $doc, ?array $sig = null): string
    {
        return self::renderPdfBytes($uid, $cid, $doc, $sig);
    }

    /**
     * Persist a signed PDF (bytes) as the document's archived file, mark the
     * document signed, and return the new DMS file id.
     */
    public static function applySignedPdf(int $uid, int $cid, array $doc, string $bytes): int
    {
        $year = self::archiveYear($doc['doc_date'] ?? null);
        $sub = $doc['type'] === 'offer' ? 'Angebote' : 'Rechnungen';
        $buchhaltungId = self::findOrCreateFolder($uid, null, 'Buchhaltung');
        $subId = self::findOrCreateFolder($uid, $buchhaltungId, $sub);
        $yearId = self::findOrCreateFolder($uid, $subId, $year);
        $name = $doc['number'] . ' – signiert.pdf';
        $rel = Storage::relPath($uid, $name);
        file_put_contents(Storage::abs($rel), $bytes);
        $fileId = self::insertArchiveFile($uid, $yearId, $name, $rel, strlen($bytes));
        Database::pdo()->prepare('UPDATE documents SET signed_at = CURRENT_TIMESTAMP, signed_file_id = ?, archived_file_id = ? WHERE id = ? AND company_id = ?')
            ->execute([$fileId, $fileId, (int)$doc['id'], $cid]);
        return $fileId;
    }

    /** Upload a (manually) signed PDF, attach it and mark the document signed. */
    public static function signUpload(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $id = (int)$args['id'];
        $d = self::fetchOne($cid, $id);
        if (!$d) return Json::err($res, 'Not found', 404);
        $file = $req->getUploadedFiles()['file'] ?? null;
        if (!$file || $file->getError() !== UPLOAD_ERR_OK) return Json::err($res, 'Keine Datei', 422);
        if ((int)$file->getSize() > 20 * 1024 * 1024) return Json::err($res, 'Datei zu groß (max 20 MB)', 413);
        $bytes = (string)$file->getStream()->getContents();
        $fileId = self::applySignedPdf($uid, $cid, $d, $bytes);
        return Json::ok($res, ['document' => self::shapeFull($uid, $cid, self::fetchOne($cid, $id)), 'file_id' => $fileId]);
    }

    public static function markSigned(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $id = (int)$args['id'];
        if (!self::fetchOne($cid, $id)) return Json::err($res, 'Not found', 404);
        Database::pdo()->prepare('UPDATE documents SET signed_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?')->execute([$id, $cid]);
        return Json::ok($res, ['document' => self::shapeFull($uid, $cid, self::fetchOne($cid, $id))]);
    }

    public static function unmarkSigned(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $id = (int)$args['id'];
        if (!self::fetchOne($cid, $id)) return Json::err($res, 'Not found', 404);
        Database::pdo()->prepare('UPDATE documents SET signed_at = NULL, signed_file_id = NULL WHERE id = ? AND company_id = ?')->execute([$id, $cid]);
        return Json::ok($res, ['document' => self::shapeFull($uid, $cid, self::fetchOne($cid, $id))]);
    }

    // ───── E-mail (send invoice/offer PDF) ───────────────────────────────────
    private static function mailDefaults(): array
    {
        return [
            'invoice' => [
                'subject' => 'Rechnung {number}',
                'body' => "Sehr geehrte Damen und Herren,\n\nanbei erhalten Sie die Rechnung {number} über {betrag}.\nWir bitten um Begleichung bis {faellig}.\n\nMit freundlichen Grüßen\n{firma}",
            ],
            'offer' => [
                'subject' => 'Angebot {number}',
                'body' => "Sehr geehrte Damen und Herren,\n\nanbei unser Angebot {number} über {betrag}.\nWir freuen uns auf Ihre Rückmeldung.\n\nMit freundlichen Grüßen\n{firma}",
            ],
        ];
    }

    public static function getMailTemplate(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $s = Database::pdo()->prepare("SELECT data FROM app_settings WHERE user_id = ? AND ns = 'doc_mail'");
        $s->execute([$uid]);
        $row = $s->fetch();
        $saved = $row && $row['data'] ? json_decode((string)$row['data'], true) : [];
        $out = self::mailDefaults();
        if (is_array($saved)) {
            foreach (['invoice', 'offer'] as $t) {
                if (!empty($saved[$t]['subject'])) $out[$t]['subject'] = (string)$saved[$t]['subject'];
                if (!empty($saved[$t]['body'])) $out[$t]['body'] = (string)$saved[$t]['body'];
            }
        }
        return Json::ok($res, ['templates' => $out]);
    }

    public static function putMailTemplate(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array)$req->getParsedBody();
        $clean = [];
        foreach (['invoice', 'offer'] as $t) {
            if (isset($b[$t]) && is_array($b[$t])) {
                $clean[$t] = ['subject' => mb_substr((string)($b[$t]['subject'] ?? ''), 0, 255), 'body' => mb_substr((string)($b[$t]['body'] ?? ''), 0, 5000)];
            }
        }
        Database::pdo()->prepare("INSERT INTO app_settings (user_id, ns, data) VALUES (?, 'doc_mail', ?) ON DUPLICATE KEY UPDATE data = VALUES(data)")
            ->execute([$uid, json_encode($clean, JSON_UNESCAPED_UNICODE)]);
        return Json::ok($res, ['ok' => true]);
    }

    public static function email(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $d = self::fetchOne($cid, (int)$args['id']);
        if (!$d) return Json::err($res, 'Not found', 404);
        $b = (array)$req->getParsedBody();
        $to = trim((string)($b['to'] ?? ''));
        if ($to === '') return Json::err($res, 'Empfänger fehlt', 422);
        $mbId = (int)($b['mailbox_id'] ?? 0);
        $mbStmt = Database::pdo()->prepare('SELECT * FROM mailboxes WHERE id = ? AND user_id = ?');
        $mbStmt->execute([$mbId, $uid]);
        $mb = $mbStmt->fetch();
        if (!$mb) return Json::err($res, 'Kein Postfach gewählt', 422);

        $bytes = self::renderPdfBytes($uid, $cid, $d);
        try {
            \Nyza\Mail::send($mb, [
                'to' => $to, 'cc' => $b['cc'] ?? '',
                'subject' => (string)($b['subject'] ?? ($d['number'])),
                'body' => (string)($b['body'] ?? ''),
                'attachments' => [['name' => $d['number'] . '.pdf', 'mime' => 'application/pdf', 'data' => $bytes]],
            ]);
        } catch (\Throwable $e) {
            return Json::err($res, 'Senden fehlgeschlagen: ' . $e->getMessage(), 502);
        }
        Database::pdo()->prepare("INSERT INTO activity (user_id, kind, payload) VALUES (?, 'doc_emailed', ?)")
            ->execute([$uid, json_encode(['number' => $d['number'], 'to' => $to])]);
        return Json::ok($res, ['ok' => true]);
    }

    // ───── Number counter ────────────────────────────────────────────────────
    /**
     * Issue the next number for (user, counter name). The counter row is seeded
     * at 1000 on first use, then incremented on every subsequent call — so the
     * first issued value is exactly 1000, the second 1001, and so on, strictly
     * increasing. The INSERT…ON DUPLICATE KEY UPDATE is atomic: the seed branch
     * fires only when no row exists yet (giving 1000), and the UPDATE branch
     * fires on every later call (giving value+1). Wrapped in the caller's txn.
     */
    private static function nextNumber(int $cid, string $name, string $prefix): string
    {
        $pdo = Database::pdo();
        $pdo->prepare(
            'INSERT INTO counters (company_id, name, value) VALUES (?, ?, 1000) '
            . 'ON DUPLICATE KEY UPDATE value = value + 1'
        )->execute([$cid, $name]);
        $stmt = $pdo->prepare('SELECT value FROM counters WHERE company_id = ? AND name = ?');
        $stmt->execute([$cid, $name]);
        $value = (int)$stmt->fetch()['value'];
        return $prefix . $value;
    }

    /**
     * Create an invoice from raw data and return its id. Reused by the recurring
     * billing engine (period → invoice). Opens its own transaction only if the
     * caller hasn't already started one.
     */
    public static function createInvoice(int $uid, int $companyId, ?int $contactId, array $rawItems, array $meta = []): int
    {
        $items = self::normalizeItems($rawItems);
        $totals = self::computeTotals($items);
        $snapshot = self::buildSnapshot($uid, $contactId);
        $attnName = array_key_exists('attn_name', $meta) ? self::textOrNull($meta['attn_name']) : self::textOrNull($snapshot['contact_person'] ?? null);
        $pdo = Database::pdo();
        $ownTxn = !$pdo->inTransaction();
        if ($ownTxn) $pdo->beginTransaction();
        try {
            $number = self::nextNumber($companyId, 'invoice', 'RE-');
            $pdo->prepare(
                'INSERT INTO documents (user_id, company_id, type, number, contact_id, attn_name, client_snapshot, doc_date, delivery_date, '
                . 'intro_text, footer_text, notes, net, tax, gross) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            )->execute([
                $uid, $companyId, 'invoice', $number, $contactId, $attnName,
                json_encode($snapshot, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
                $meta['doc_date'] ?? date('Y-m-d'), $meta['delivery_date'] ?? null,
                $meta['intro_text'] ?? null, $meta['footer_text'] ?? null, $meta['notes'] ?? null,
                $totals['net'], $totals['tax'], $totals['gross'],
            ]);
            $docId = (int)$pdo->lastInsertId();
            self::insertItems($docId, $items);
            if ($ownTxn) $pdo->commit();
        } catch (\Throwable $e) {
            if ($ownTxn) $pdo->rollBack();
            throw $e;
        }
        return $docId;
    }

    // ───── Items ─────────────────────────────────────────────────────────────
    /** Coerce a raw items payload into clean rows (no position yet). */
    private static function normalizeItems($raw): array
    {
        $out = [];
        if (!is_array($raw)) return $out;
        foreach ($raw as $it) {
            if (!is_array($it)) continue;
            $note = trim((string)($it['note'] ?? ''));
            $out[] = [
                'description'    => mb_substr(trim((string)($it['description'] ?? '')), 0, 500),
                'note'           => $note !== '' ? mb_substr($note, 0, 1000) : null,
                'quantity'       => round((float)($it['quantity'] ?? 1), 3),
                'unit'           => trim((string)($it['unit'] ?? '')) !== '' ? (string)$it['unit'] : 'Stk',
                'unit_price_net' => round((float)($it['unit_price_net'] ?? 0), 2),
                'tax_rate'       => round((float)($it['tax_rate'] ?? 20), 2),
            ];
        }
        return $out;
    }

    private static function insertItems(int $docId, array $items): void
    {
        if (!$items) return;
        $stmt = Database::pdo()->prepare(
            'INSERT INTO document_items (document_id, position, description, note, quantity, unit, unit_price_net, tax_rate) '
            . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $pos = 1;
        foreach ($items as $it) {
            $stmt->execute([
                $docId, $pos, $it['description'], $it['note'] ?? null, $it['quantity'], $it['unit'], $it['unit_price_net'], $it['tax_rate'],
            ]);
            $pos++;
        }
    }

    private static function loadItems(int $docId): array
    {
        $stmt = Database::pdo()->prepare('SELECT * FROM document_items WHERE document_id = ? ORDER BY position ASC, id ASC');
        $stmt->execute([$docId]);
        return $stmt->fetchAll();
    }

    /** Per-line and document totals. line_net = qty*price; line_tax = line_net*rate/100. */
    private static function computeTotals(array $items): array
    {
        $net = 0.0; $tax = 0.0;
        foreach ($items as $it) {
            $lineNet = round((float)$it['quantity'] * (float)$it['unit_price_net'], 2);
            $lineTax = round($lineNet * (float)$it['tax_rate'] / 100, 2);
            $net += $lineNet;
            $tax += $lineTax;
        }
        $net = round($net, 2);
        $tax = round($tax, 2);
        return ['net' => $net, 'tax' => $tax, 'gross' => round($net + $tax, 2)];
    }

    // ───── Client snapshot ───────────────────────────────────────────────────
    private static function buildSnapshot(int $uid, ?int $contactId): array
    {
        if ($contactId === null) return [];
        $stmt = Database::pdo()->prepare('SELECT * FROM contacts WHERE id = ? AND user_id = ?');
        $stmt->execute([$contactId, $uid]);
        $c = $stmt->fetch();
        if (!$c) return [];
        return [
            'name'           => $c['name'],
            'contact_person' => $c['contact_person'],
            'street'         => $c['street'],
            'zip'            => $c['zip'],
            'city'           => $c['city'],
            'country'        => $c['country'],
            'vat_id'         => $c['vat_id'],
        ];
    }

    // ───── Shapes ────────────────────────────────────────────────────────────
    private static function decodeSnapshot($raw): array
    {
        if (!is_string($raw) || $raw === '') return [];
        $d = json_decode($raw, true);
        return is_array($d) ? $d : [];
    }

    /** Light shape for the list endpoint — no items array. */
    private static function shapeHeader(array $r, int $termDays): array
    {
        return [
            'id'                      => (int)$r['id'],
            'type'                    => $r['type'],
            'number'                  => $r['number'],
            'contact_id'              => $r['contact_id'] !== null ? (int)$r['contact_id'] : null,
            'contact_name'            => $r['contact_name'] ?? null,
            'attn_name'               => $r['attn_name'] ?? null,
            'client_snapshot'         => self::decodeSnapshot($r['client_snapshot']),
            'doc_date'                => $r['doc_date'],
            'delivery_date'           => $r['delivery_date'],
            'intro_text'              => $r['intro_text'],
            'footer_text'             => $r['footer_text'],
            'notes'                   => $r['notes'],
            'net'                     => (float)$r['net'],
            'tax'                     => (float)$r['tax'],
            'gross'                   => (float)$r['gross'],
            'paid_at'                 => $r['paid_at'],
            'accepted_at'             => $r['accepted_at'],
            'converted_invoice_id'    => $r['converted_invoice_id'] !== null ? (int)$r['converted_invoice_id'] : null,
            'converted_from_offer_id' => $r['converted_from_offer_id'] !== null ? (int)$r['converted_from_offer_id'] : null,
            'payment_status'          => self::paymentStatus($r, $termDays),
            'reminder_stage'          => isset($r['reminder_stage']) && $r['reminder_stage'] !== null ? (int)$r['reminder_stage'] : 0,
            'archived_file_id'        => isset($r['archived_file_id']) && $r['archived_file_id'] !== null ? (int)$r['archived_file_id'] : null,
            'signed_at'               => $r['signed_at'] ?? null,
            'signed_file_id'          => isset($r['signed_file_id']) && $r['signed_file_id'] !== null ? (int)$r['signed_file_id'] : null,
            'created_at'              => $r['created_at'],
        ];
    }

    /** Full shape for show/create/update — includes items with line_net. */
    private static function shapeFull(int $uid, int $cid, array $r): array
    {
        // Resolve contact_name fresh (the row came from fetchOne without a join).
        $contactName = null;
        if ($r['contact_id'] !== null) {
            $s = Database::pdo()->prepare('SELECT name FROM contacts WHERE id = ?');
            $s->execute([(int)$r['contact_id']]);
            $cr = $s->fetch();
            $contactName = $cr ? $cr['name'] : null;
        }
        $r['contact_name'] = $contactName;

        $base = self::shapeHeader($r, CompanyContext::paymentTermDays($cid));
        $items = array_map(static function (array $it): array {
            $lineNet = round((float)$it['quantity'] * (float)$it['unit_price_net'], 2);
            return [
                'id'             => (int)$it['id'],
                'position'       => (int)$it['position'],
                'description'    => $it['description'],
                'note'           => $it['note'] ?? null,
                'quantity'       => (float)$it['quantity'],
                'unit'           => $it['unit'],
                'unit_price_net' => (float)$it['unit_price_net'],
                'tax_rate'       => (float)$it['tax_rate'],
                'line_net'       => $lineNet,
            ];
        }, self::loadItems((int)$r['id']));
        $base['items'] = $items;
        return $base;
    }

    /**
     * payment_status:
     *  - invoice paid_at set → 'paid'
     *  - invoice unpaid: due = doc_date + term days; today>due → 'overdue';
     *    due-today<=7 → 'due_soon'; else 'open'
     *  - offer: 'accepted' if accepted_at else 'open'
     */
    private static function paymentStatus(array $r, int $termDays): string
    {
        if ($r['type'] === 'offer') {
            return !empty($r['accepted_at']) ? 'accepted' : 'open';
        }
        if (!empty($r['paid_at'])) return 'paid';
        $docDate = $r['doc_date'] ?? null;
        if (!$docDate) return 'open';
        try {
            $due = new \DateTimeImmutable($docDate);
            $due = $due->modify('+' . $termDays . ' days');
            $today = new \DateTimeImmutable(date('Y-m-d'));
        } catch (\Throwable $e) {
            return 'open';
        }
        $diffDays = (int)$today->diff($due)->format('%r%a');
        if ($diffDays < 0) return 'overdue';
        if ($diffDays <= 7) return 'due_soon';
        return 'open';
    }

    // ───── small parsers ─────────────────────────────────────────────────────
    private static function parseDate($v): ?string
    {
        if ($v === null || $v === '') return null;
        $v = (string)$v;
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $v)) return null;
        return $v;
    }

    private static function textOrNull($v): ?string
    {
        if ($v === null) return null;
        $v = (string)$v;
        return $v === '' ? null : $v;
    }

    private static function fetchOne(int $cid, int $id): ?array
    {
        $stmt = Database::pdo()->prepare('SELECT * FROM documents WHERE id = ? AND company_id = ?');
        $stmt->execute([$id, $cid]);
        $d = $stmt->fetch();
        return $d ?: null;
    }

    // ───── PDF rendering ─────────────────────────────────────────────────────
    private static function e(?string $s): string
    {
        return htmlspecialchars((string)$s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }

    /** Format an amount as de-AT "1.234,56 €". */
    private static function money($n): string
    {
        return number_format((float)$n, 2, ',', '.') . ' €';
    }

    private static function num($n): string
    {
        // Quantities: trim trailing zeros, comma decimals.
        $f = (float)$n;
        $s = rtrim(rtrim(number_format($f, 3, ',', '.'), '0'), ',');
        return $s === '' ? '0' : $s;
    }

    /** Resolve the user's logo as a data URI for embedding, or null. */
    private static function logoDataUri(int $uid): ?string
    {
        try {
            $s = Database::pdo()->prepare('SELECT logo_path FROM users WHERE id = ?');
            $s->execute([$uid]);
            $row = $s->fetch();
            if (!$row || empty($row['logo_path'])) return null;
            $abs = Storage::abs($row['logo_path']);
            if (!is_file($abs)) return null;
            $ext = strtolower(pathinfo($abs, PATHINFO_EXTENSION));
            // Dompdf can't rasterise SVG cleanly here — skip it gracefully.
            $mime = ['png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'webp' => 'image/webp', 'gif' => 'image/gif'][$ext] ?? null;
            if ($mime === null) return null;
            $data = @file_get_contents($abs);
            if ($data === false) return null;
            return 'data:' . $mime . ';base64,' . base64_encode($data);
        } catch (\Throwable $e) {
            return null;
        }
    }

    private static function renderHtml(int $uid, array $d, array $items, array $co, ?array $sig = null): string
    {
        $accent = self::ACCENT;
        $isOffer = $d['type'] === 'offer';
        $snap = self::decodeSnapshot($d['client_snapshot']);

        // Company fields (all optional).
        $cv = static fn(string $k): string => isset($co[$k]) ? (string)$co[$k] : '';
        $legalName = $cv('legal_name') !== '' ? $cv('legal_name') : $cv('company_name');
        if ($legalName === '') $legalName = $cv('name');

        // Sender one-line.
        $senderParts = array_filter([$legalName, $cv('street'), trim($cv('zip') . ' ' . $cv('city')), $cv('country')]);
        $senderLine = implode(' · ', array_map([self::class, 'e'], $senderParts));

        $logo = self::logoDataUri($uid);

        // Recipient block. attn_name is the per-document "z. Hd." override
        // (pre-filled from the contact's contact_person on create, but freely
        // editable per-document from then on); older documents created before
        // this field existed fall back to the frozen snapshot value.
        $rcptName = (string)($snap['name'] ?? '');
        $rcptPerson = trim((string)($d['attn_name'] ?? '')) !== '' ? (string)$d['attn_name'] : (string)($snap['contact_person'] ?? '');
        $rcptStreet = (string)($snap['street'] ?? '');
        $rcptCity = trim((string)($snap['zip'] ?? '') . ' ' . (string)($snap['city'] ?? ''));
        $rcptCountry = (string)($snap['country'] ?? '');
        $rcptVat = (string)($snap['vat_id'] ?? '');

        $title = ($isOffer ? 'ANGEBOT ' : 'RECHNUNG ') . self::e($d['number']);
        $numLabel = $isOffer ? 'Angebots-Nr.' : 'Rechnungs-Nr.';
        $dateLabel = $isOffer ? 'Angebotsdatum' : 'Rechnungsdatum';

        // Tax rate breakdown for the totals block.
        $byRate = [];
        $rowsHtml = '';
        foreach ($items as $it) {
            $lineNet = round((float)$it['quantity'] * (float)$it['unit_price_net'], 2);
            $rate = (float)$it['tax_rate'];
            $lineTax = round($lineNet * $rate / 100, 2);
            $key = number_format($rate, 2, '.', '');
            if (!isset($byRate[$key])) $byRate[$key] = ['rate' => $rate, 'net' => 0.0, 'tax' => 0.0];
            $byRate[$key]['net'] += $lineNet;
            $byRate[$key]['tax'] += $lineTax;
            $note = trim((string)($it['note'] ?? ''));
            $descHtml = nl2br(self::e($it['description']));
            if ($note !== '') $descHtml .= '<div class="c-note">' . nl2br(self::e($note)) . '</div>';
            $rowsHtml .= '<tr>'
                . '<td class="c-pos">' . (int)$it['position'] . '</td>'
                . '<td class="c-desc">' . $descHtml . '</td>'
                . '<td class="c-num">' . self::num($it['quantity']) . '</td>'
                . '<td class="c-unit">' . self::e($it['unit']) . '</td>'
                . '<td class="c-num">' . self::money($it['unit_price_net']) . '</td>'
                . '<td class="c-num">' . self::money($lineNet) . '</td>'
                . '</tr>';
        }

        $net = (float)$d['net'];
        $tax = (float)$d['tax'];
        $gross = (float)$d['gross'];

        // USt rows: single rate → one line with rate; mixed → per rate.
        $taxRowsHtml = '';
        if (count($byRate) <= 1) {
            $rate = $byRate ? reset($byRate)['rate'] : 0.0;
            $rateStr = rtrim(rtrim(number_format($rate, 2, ',', ''), '0'), ',');
            $taxRowsHtml .= '<tr><td>zzgl. USt ' . self::e($rateStr) . '%</td><td class="c-num">' . self::money($tax) . '</td></tr>';
        } else {
            foreach ($byRate as $g) {
                $rateStr = rtrim(rtrim(number_format($g['rate'], 2, ',', ''), '0'), ',');
                $taxRowsHtml .= '<tr><td>zzgl. USt ' . self::e($rateStr) . '%</td><td class="c-num">' . self::money(round($g['tax'], 2)) . '</td></tr>';
            }
        }

        // Footer page columns.
        $contactCol = self::footerLines([
            $legalName,
            $cv('street'),
            trim($cv('zip') . ' ' . $cv('city')),
            $cv('phone') !== '' ? 'Tel: ' . $cv('phone') : '',
            $cv('email') !== '' ? 'E-Mail: ' . $cv('email') : '',
            $cv('website') !== '' ? 'Web: ' . $cv('website') : '',
        ]);
        $isCorp = preg_match('/\b(gmbh|ag)\b/i', $legalName) === 1;
        $taxCol = self::footerLines([
            $cv('vat_id') !== '' ? 'UID: ' . $cv('vat_id') : '',
            $cv('tax_number') !== '' ? 'Steuernr.: ' . $cv('tax_number') : '',
            ($isCorp && $cv('firmenbuch_nr') !== '') ? 'Firmenbuchnr.: ' . $cv('firmenbuch_nr') : '',
            $cv('owner') !== '' ? 'Inhaber: ' . $cv('owner') : '',
        ]);
        $bankCol = self::footerLines([
            $cv('bank_name') !== '' ? 'Bank: ' . $cv('bank_name') : '',
            $cv('iban') !== '' ? 'IBAN: ' . $cv('iban') : '',
            $cv('bic') !== '' ? 'BIC: ' . $cv('bic') : '',
            $cv('owner') !== '' ? 'Inhaber: ' . $cv('owner') : '',
        ]);

        $intro = $d['intro_text'] !== null && $d['intro_text'] !== '' ? '<div class="intro">' . nl2br(self::e($d['intro_text'])) . '</div>' : '';
        $footerText = $d['footer_text'] !== null && $d['footer_text'] !== '' ? '<div class="footer-text">' . nl2br(self::e($d['footer_text'])) . '</div>' : '';
        // Grußformel: a company-wide constant, always rendered live from the profile
        // (not copied into each document) so editing it later updates every future PDF.
        $closing = $cv('closing') !== '' ? '<div class="closing">' . nl2br(self::e($cv('closing'))) . '</div>' : '';
        $signature = $cv('signature_name') !== '' ? '<div class="signature">' . self::e($cv('signature_name')) . '</div>' : '';
        $signedBlock = '';
        if ($sig !== null && !empty($sig['image'])) {
            $signedBlock = '<div class="esign"><img class="esign-img" src="' . $sig['image'] . '" alt="">'
                . '<div class="esign-meta">Elektronisch signiert von <b>' . self::e((string)($sig['name'] ?? '')) . '</b>'
                . ' &middot; ' . self::e((string)($sig['date'] ?? ''))
                . (!empty($sig['ip']) ? ' &middot; IP ' . self::e((string)$sig['ip']) : '') . '</div></div>';
        }

        // Meta rows (right).
        $metaRows = '<tr><td class="ml">' . self::e($numLabel) . '</td><td class="mv">' . self::e($d['number']) . '</td></tr>';
        $metaRows .= '<tr><td class="ml">' . self::e($dateLabel) . '</td><td class="mv">' . self::e(self::deDate($d['doc_date'])) . '</td></tr>';
        if (!empty($d['delivery_date'])) {
            $metaRows .= '<tr><td class="ml">Leistungsdatum</td><td class="mv">' . self::e(self::deDate($d['delivery_date'])) . '</td></tr>';
        }
        if ($rcptVat !== '') {
            $metaRows .= '<tr><td class="ml">UID</td><td class="mv">' . self::e($rcptVat) . '</td></tr>';
        }

        $logoHtml = $logo !== null ? '<img class="logo" src="' . $logo . '" alt="">' : '';

        $netMoney = self::money($net);
        $grossMoney = self::money($gross);

        // Recipient lines.
        $rcptHtml = '<div class="r-name">' . self::e($rcptName) . '</div>';
        if ($rcptPerson !== '') $rcptHtml .= '<div>z. Hd. ' . self::e($rcptPerson) . '</div>';
        if ($rcptStreet !== '') $rcptHtml .= '<div>' . self::e($rcptStreet) . '</div>';
        if ($rcptCity !== '')   $rcptHtml .= '<div>' . self::e($rcptCity) . '</div>';
        if ($rcptCountry !== '') $rcptHtml .= '<div>' . self::e($rcptCountry) . '</div>';

        return <<<HTML
<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8">
<style>
  @page { margin: 28mm 18mm 32mm 18mm; }
  * { box-sizing: border-box; }
  body { font-family: 'DejaVu Sans', sans-serif; font-size: 10px; color: #1c1c22; margin: 0; }
  .sender { font-size: 8px; color: #888; }
  .head { width: 100%; }
  .head td { vertical-align: top; }
  .logo { max-height: 64px; max-width: 200px; }
  .addr { margin-top: 24px; width: 100%; }
  .addr td { vertical-align: top; }
  .recipient { width: 60%; }
  .r-name { font-weight: bold; font-size: 11px; }
  .meta { width: 40%; }
  .meta table { border-collapse: collapse; float: right; }
  .meta .ml { color: #888; padding: 1px 10px 1px 0; }
  .meta .mv { text-align: right; padding: 1px 0; font-weight: bold; }
  h1.title { font-size: 17px; margin: 28px 0 2px; letter-spacing: .5px; }
  .rule { height: 3px; background: {$accent}; width: 100%; margin: 0 0 10px; }
  .intro { margin: 8px 0 14px; }
  table.items { width: 100%; border-collapse: collapse; margin-top: 6px; }
  table.items thead th { background: {$accent}; color: #fff; font-size: 8.5px; text-transform: uppercase;
    letter-spacing: .4px; padding: 6px 6px; text-align: left; }
  table.items tbody td { padding: 6px 6px; border-bottom: 1px solid #eceaf5; vertical-align: top; }
  .c-pos { width: 8%; } .c-desc { width: 44%; } .c-unit { width: 10%; }
  .c-note { font-size: 10.5px; color: #6b6478; margin-top: 2px; }
  .c-num { text-align: right; white-space: nowrap; }
  th.c-num { text-align: right; }
  .totals { width: 100%; margin-top: 12px; }
  .totals td { vertical-align: top; }
  .tbox { width: 48%; float: right; }
  .tbox table { width: 100%; border-collapse: collapse; }
  .tbox td { padding: 3px 0; }
  .tbox .c-num { text-align: right; }
  .tbox tr.grand td { background: {$accent}; color: #fff; font-weight: bold; font-size: 12px; padding: 7px 8px; }
  .clear { clear: both; }
  .footer-text { margin-top: 26px; font-size: 9.5px; }
  .closing { margin-top: 18px; }
  .signature { margin-top: 4px; font-weight: bold; }
  .esign { margin-top: 30px; padding-top: 10px; border-top: 1px solid #ddd; }
  .esign-img { max-height: 90px; max-width: 320px; }
  .esign-meta { font-size: 10px; color: #555; margin-top: 4px; }
  .pagefoot { position: fixed; bottom: -22mm; left: 0; right: 0; height: 22mm;
    font-size: 7px; color: #999; border-top: 1px solid #e6e3f0; padding-top: 4px; }
  .pagefoot table { width: 100%; border-collapse: collapse; }
  .pagefoot td { vertical-align: top; width: 33%; padding-right: 8px; }
  .pagefoot .line { line-height: 1.45; }
</style></head>
<body>
  <table class="head"><tr>
    <td><div class="sender">{$senderLine}</div></td>
    <td style="text-align:right">{$logoHtml}</td>
  </tr></table>

  <table class="addr"><tr>
    <td class="recipient">{$rcptHtml}</td>
    <td class="meta"><table>{$metaRows}</table></td>
  </tr></table>

  <h1 class="title">{$title}</h1>
  <div class="rule"></div>
  {$intro}

  <table class="items">
    <thead><tr>
      <th class="c-pos">Pos.</th>
      <th class="c-desc">Beschreibung</th>
      <th class="c-num">Menge</th>
      <th class="c-unit">Einheit</th>
      <th class="c-num">Einzelpreis</th>
      <th class="c-num">Gesamtpreis</th>
    </tr></thead>
    <tbody>{$rowsHtml}</tbody>
  </table>

  <div class="totals">
    <div class="tbox"><table>
      <tr><td>Netto</td><td class="c-num">{$netMoney}</td></tr>
      {$taxRowsHtml}
      <tr class="grand"><td>Gesamt brutto</td><td class="c-num">{$grossMoney}</td></tr>
    </table></div>
    <div class="clear"></div>
  </div>

  {$footerText}
  {$closing}
  {$signature}
  {$signedBlock}

  <div class="pagefoot"><table><tr>
    <td><div class="line">{$contactCol}</div></td>
    <td><div class="line">{$taxCol}</div></td>
    <td><div class="line">{$bankCol}</div></td>
  </tr></table></div>
</body></html>
HTML;
    }

    private static function footerLines(array $lines): string
    {
        $out = [];
        foreach ($lines as $l) {
            $l = trim((string)$l);
            if ($l !== '') $out[] = self::e($l);
        }
        return implode('<br>', $out);
    }

    private static function deDate(?string $ymd): string
    {
        if (!$ymd) return '';
        $d = \DateTime::createFromFormat('Y-m-d', substr($ymd, 0, 10));
        return $d ? $d->format('d.m.Y') : (string)$ymd;
    }
}
