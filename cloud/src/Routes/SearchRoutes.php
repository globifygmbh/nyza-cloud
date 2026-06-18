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

/**
 * Global search across the whole workspace: DMS files & folders (per user),
 * invoices/offers and expenses (per active company) and contacts (per user).
 * Returns a small, capped, grouped result set the client renders as a unified
 * jump-to palette — each hit carries the type + id needed to navigate to it.
 */
final class SearchRoutes
{
    public static function mount(App $app): void
    {
        $app->get('/api/search', [self::class, 'search'])->add(new AuthMiddleware());
    }

    public static function search(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $q = trim((string)($req->getQueryParams()['q'] ?? ''));
        if (mb_strlen($q) < 2) {
            return Json::ok($res, ['files' => [], 'folders' => [], 'documents' => [], 'expenses' => [], 'contacts' => []]);
        }
        $cid = CompanyContext::active($req, $uid);
        $like = '%' . str_replace(['%', '_'], ['\%', '\_'], $q) . '%';
        $pdo = Database::pdo();

        $files = $pdo->prepare(
            "SELECT id, name, folder_id, kind, mime_type, size FROM files
             WHERE user_id = ? AND deleted_at IS NULL AND name LIKE ? ESCAPE '\\'
             ORDER BY created_at DESC LIMIT 20"
        );
        $files->execute([$uid, $like]);

        $folders = $pdo->prepare(
            "SELECT id, name, parent_id, kind, tone FROM folders
             WHERE user_id = ? AND deleted_at IS NULL AND name LIKE ? ESCAPE '\\'
             ORDER BY name LIMIT 12"
        );
        $folders->execute([$uid, $like]);

        // Invoices/offers: match document number or the snapshotted client name.
        $documents = $pdo->prepare(
            "SELECT id, type, number, client_snapshot, doc_date, gross, paid_at FROM documents
             WHERE company_id = ? AND (number LIKE ? ESCAPE '\\' OR client_snapshot LIKE ? ESCAPE '\\')
             ORDER BY doc_date DESC, id DESC LIMIT 12"
        );
        $documents->execute([$cid, $like, $like]);
        $docs = array_map(static function (array $d): array {
            $name = '';
            if (!empty($d['client_snapshot'])) {
                $snap = json_decode((string)$d['client_snapshot'], true);
                if (is_array($snap)) $name = (string)($snap['name'] ?? '');
            }
            return [
                'id' => (int)$d['id'],
                'type' => $d['type'],
                'number' => $d['number'],
                'client' => $name,
                'doc_date' => $d['doc_date'],
                'gross' => (float)$d['gross'],
                'paid' => !empty($d['paid_at']),
            ];
        }, $documents->fetchAll());

        $expenses = $pdo->prepare(
            "SELECT id, vendor, description, category, exp_date, gross, paid_at FROM expenses
             WHERE company_id = ? AND (vendor LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\')
             ORDER BY exp_date DESC, id DESC LIMIT 12"
        );
        $expenses->execute([$cid, $like, $like, $like]);

        $contacts = $pdo->prepare(
            "SELECT id, name, kind, email, city, is_customer FROM contacts
             WHERE user_id = ? AND (name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR contact_person LIKE ? ESCAPE '\\')
             ORDER BY name LIMIT 12"
        );
        $contacts->execute([$uid, $like, $like, $like]);

        return Json::ok($res, [
            'files' => $files->fetchAll(),
            'folders' => $folders->fetchAll(),
            'documents' => $docs,
            'expenses' => $expenses->fetchAll(),
            'contacts' => $contacts->fetchAll(),
        ]);
    }
}
