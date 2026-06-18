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
use Slim\Routing\RouteCollectorProxy;

/**
 * Companies (Mandanten) — the tenants that own all accounting data. Each user is
 * a member of one or more companies; admins implicitly see all. The active
 * company is chosen by the client and sent per request (X-Company-Id header or
 * ?company_id). The per-company profile (legal name, bank, payment term, …)
 * lives in companies.profile and is edited here, replacing the old per-user
 * app_settings ns='company'.
 *
 * Read endpoints (list / profile) are open to members + admins. Mutating the
 * company set (create/rename/delete) and membership management are admin-only.
 */
final class CompanyRoutes
{
    private const MAX_PROFILE_BYTES = 256 * 1024;

    public static function mount(App $app): void
    {
        $app->group('/api/companies', function (RouteCollectorProxy $g) {
            $g->get('',                         [self::class, 'list']);
            $g->post('',                        [self::class, 'create']);
            $g->get('/{id}/profile',            [self::class, 'getProfile']);
            $g->put('/{id}/profile',            [self::class, 'putProfile']);
            $g->patch('/{id}',                  [self::class, 'rename']);
            $g->delete('/{id}',                 [self::class, 'delete']);
            $g->get('/{id}/members',            [self::class, 'members']);
            $g->post('/{id}/members',           [self::class, 'addMember']);
            $g->delete('/{id}/members/{userId}',[self::class, 'removeMember']);
        })->add(new AuthMiddleware());

        // People the current user can @-mention in comments.
        $app->get('/api/mentionable', [self::class, 'mentionable'])->add(new AuthMiddleware());
    }

    public static function mentionable(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        return Json::ok($res, ['users' => \Nyza\Mentions::mentionable($uid)]);
    }

    // ───── List (member view) ──────────────────────────────────────────────────
    public static function list(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $pdo = Database::pdo();
        if (CompanyContext::isAdmin($uid)) {
            $rows = $pdo->query('SELECT id, name FROM companies ORDER BY name ASC, id ASC')->fetchAll();
        } else {
            $s = $pdo->prepare(
                'SELECT c.id, c.name FROM companies c '
                . 'JOIN company_members cm ON cm.company_id = c.id '
                . 'WHERE cm.user_id = ? ORDER BY c.name ASC, c.id ASC'
            );
            $s->execute([$uid]);
            $rows = $s->fetchAll();
        }
        $companies = array_map(static fn($r) => ['id' => (int)$r['id'], 'name' => $r['name']], $rows);
        return Json::ok($res, ['companies' => $companies, 'active' => CompanyContext::active($req, $uid)]);
    }

    // ───── Profile ─────────────────────────────────────────────────────────────
    public static function getProfile(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::exists($id)) return Json::err($res, 'Not found', 404);
        if (!CompanyContext::isMember($uid, $id)) return Json::err($res, 'Kein Zugriff', 403, 'forbidden');
        return Json::ok($res, ['profile' => CompanyContext::profile($id)]);
    }

    public static function putProfile(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::exists($id)) return Json::err($res, 'Not found', 404);
        if (!CompanyContext::isMember($uid, $id)) return Json::err($res, 'Kein Zugriff', 403, 'forbidden');

        $body = (array) $req->getParsedBody();
        $merged = array_merge(CompanyContext::profile($id), $body);
        $json = json_encode($merged, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($json === false || strlen($json) > self::MAX_PROFILE_BYTES) {
            return Json::err($res, 'Profil zu groß', 413);
        }
        Database::pdo()->prepare('UPDATE companies SET profile = ? WHERE id = ?')->execute([$json, $id]);
        return Json::ok($res, ['profile' => $merged]);
    }

    // ───── Create / rename / delete (admin) ────────────────────────────────────
    public static function create(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        if (!CompanyContext::isAdmin($uid)) return Json::err($res, 'Nur Admin', 403, 'forbidden');
        $b = (array) $req->getParsedBody();
        $name = trim((string)($b['name'] ?? ''));
        if ($name === '') return Json::err($res, 'Name erforderlich', 422);

        $pdo = Database::pdo();
        $pdo->prepare('INSERT INTO companies (name, profile) VALUES (?, NULL)')->execute([mb_substr($name, 0, 255)]);
        $id = (int)$pdo->lastInsertId();
        // Creator becomes a member so it shows up in their list immediately.
        $pdo->prepare('INSERT INTO company_members (company_id, user_id) VALUES (?, ?)')->execute([$id, $uid]);

        return Json::ok($res, ['company' => ['id' => $id, 'name' => mb_substr($name, 0, 255)]], 201);
    }

    public static function rename(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        if (!CompanyContext::isAdmin($uid)) return Json::err($res, 'Nur Admin', 403, 'forbidden');
        $id = (int)$args['id'];
        if (!self::exists($id)) return Json::err($res, 'Not found', 404);
        $b = (array) $req->getParsedBody();
        $name = trim((string)($b['name'] ?? ''));
        if ($name === '') return Json::err($res, 'Name erforderlich', 422);
        Database::pdo()->prepare('UPDATE companies SET name = ? WHERE id = ?')->execute([mb_substr($name, 0, 255), $id]);
        return Json::ok($res, ['company' => ['id' => $id, 'name' => mb_substr($name, 0, 255)]]);
    }

    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        if (!CompanyContext::isAdmin($uid)) return Json::err($res, 'Nur Admin', 403, 'forbidden');
        $id = (int)$args['id'];
        if (!self::exists($id)) return Json::err($res, 'Not found', 404);

        // Safer: refuse to delete a company that still has accounting records.
        $pdo = Database::pdo();
        foreach (['documents', 'expenses'] as $table) {
            $s = $pdo->prepare("SELECT 1 FROM $table WHERE company_id = ? LIMIT 1");
            $s->execute([$id]);
            if ($s->fetch()) {
                return Json::err($res, 'Mandant enthält noch Buchhaltungsdaten', 422, 'company_not_empty');
            }
        }
        $pdo->prepare('DELETE FROM companies WHERE id = ?')->execute([$id]);
        return Json::ok($res, ['ok' => true]);
    }

    // ───── Members (admin) ─────────────────────────────────────────────────────
    public static function members(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        if (!CompanyContext::isAdmin($uid)) return Json::err($res, 'Nur Admin', 403, 'forbidden');
        $id = (int)$args['id'];
        if (!self::exists($id)) return Json::err($res, 'Not found', 404);
        $s = Database::pdo()->prepare(
            'SELECT u.id, u.name, u.email FROM company_members cm '
            . 'JOIN users u ON u.id = cm.user_id WHERE cm.company_id = ? ORDER BY u.name ASC, u.id ASC'
        );
        $s->execute([$id]);
        $members = array_map(static fn($r) => [
            'user_id' => (int)$r['id'], 'name' => $r['name'], 'email' => $r['email'],
        ], $s->fetchAll());
        return Json::ok($res, ['members' => $members]);
    }

    public static function addMember(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        if (!CompanyContext::isAdmin($uid)) return Json::err($res, 'Nur Admin', 403, 'forbidden');
        $id = (int)$args['id'];
        if (!self::exists($id)) return Json::err($res, 'Not found', 404);
        $b = (array) $req->getParsedBody();
        $userId = (int)($b['user_id'] ?? 0);
        if ($userId <= 0) return Json::err($res, 'user_id erforderlich', 422);

        $pdo = Database::pdo();
        $chk = $pdo->prepare('SELECT 1 FROM users WHERE id = ?');
        $chk->execute([$userId]);
        if (!$chk->fetch()) return Json::err($res, 'Benutzer nicht gefunden', 404);

        $pdo->prepare(
            'INSERT INTO company_members (company_id, user_id) VALUES (?, ?) '
            . 'ON DUPLICATE KEY UPDATE company_id = company_id'
        )->execute([$id, $userId]);
        return Json::ok($res, ['ok' => true], 201);
    }

    public static function removeMember(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        if (!CompanyContext::isAdmin($uid)) return Json::err($res, 'Nur Admin', 403, 'forbidden');
        $id = (int)$args['id'];
        if (!self::exists($id)) return Json::err($res, 'Not found', 404);
        $userId = (int)$args['userId'];
        Database::pdo()->prepare('DELETE FROM company_members WHERE company_id = ? AND user_id = ?')
            ->execute([$id, $userId]);
        return Json::ok($res, ['ok' => true]);
    }

    // ───── helpers ─────────────────────────────────────────────────────────────
    private static function exists(int $id): bool
    {
        if ($id <= 0) return false;
        $s = Database::pdo()->prepare('SELECT 1 FROM companies WHERE id = ?');
        $s->execute([$id]);
        return (bool)$s->fetch();
    }
}
