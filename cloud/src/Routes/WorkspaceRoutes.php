<?php
declare(strict_types=1);

namespace Nyza\Routes;

use Nyza\Database;
use Nyza\Json;
use Nyza\Middleware\AuthMiddleware;
use Nyza\WorkspaceContext;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;
use Slim\Routing\RouteCollectorProxy;

/**
 * Kontogruppen (workspaces) — managing the tenancy boundary itself.
 *
 * Reserved for the Hauptadmin (users.is_primary): a regular admin runs their own
 * group but must not be able to create groups, look into other groups, or move
 * accounts across the boundary. Assigning users to a group happens here and in
 * AdminRoutes::update (workspace_id), both Hauptadmin-only.
 */
final class WorkspaceRoutes
{
    public static function mount(App $app): void
    {
        $app->group('/api/workspaces', function (RouteCollectorProxy $g) {
            $g->get('',             [self::class, 'list']);
            $g->post('',            [self::class, 'create']);
            $g->patch('/{id}',      [self::class, 'rename']);
            $g->delete('/{id}',     [self::class, 'delete']);
        })->add(new AuthMiddleware());
    }

    private static function requirePrimary(Request $req): bool
    {
        return WorkspaceContext::isPrimary((int)$req->getAttribute('uid'));
    }

    public static function list(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        if (!self::requirePrimary($req)) return Json::err($res, 'Nur der Hauptadmin', 403, 'forbidden');
        return Json::ok($res, ['workspaces' => WorkspaceContext::all(), 'active' => WorkspaceContext::of($uid)]);
    }

    public static function create(Request $req, Response $res): Response
    {
        if (!self::requirePrimary($req)) return Json::err($res, 'Nur der Hauptadmin', 403, 'forbidden');
        $name = trim((string)(((array)$req->getParsedBody())['name'] ?? ''));
        if ($name === '') return Json::err($res, 'Name erforderlich', 422);

        $pdo = Database::pdo();
        $pdo->prepare('INSERT INTO workspaces (name) VALUES (?)')->execute([mb_substr($name, 0, 190)]);
        $id = (int)$pdo->lastInsertId();
        return Json::ok($res, ['workspace' => ['id' => $id, 'name' => mb_substr($name, 0, 190), 'user_count' => 0, 'company_count' => 0]], 201);
    }

    public static function rename(Request $req, Response $res, array $args): Response
    {
        if (!self::requirePrimary($req)) return Json::err($res, 'Nur der Hauptadmin', 403, 'forbidden');
        $id = (int)$args['id'];
        $name = trim((string)(((array)$req->getParsedBody())['name'] ?? ''));
        if ($name === '') return Json::err($res, 'Name erforderlich', 422);
        if (!self::exists($id)) return Json::err($res, 'Not found', 404);
        Database::pdo()->prepare('UPDATE workspaces SET name = ? WHERE id = ?')
            ->execute([mb_substr($name, 0, 190), $id]);
        return Json::ok($res, ['ok' => true]);
    }

    /**
     * Delete an empty group. Refused while users or companies still belong to
     * it — the FK is ON DELETE SET NULL, so deleting a populated group would
     * silently orphan accounts and their whole Buchhaltung instead of failing
     * loudly. Move the members out first.
     */
    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        if (!self::requirePrimary($req)) return Json::err($res, 'Nur der Hauptadmin', 403, 'forbidden');
        $id = (int)$args['id'];
        if (!self::exists($id)) return Json::err($res, 'Not found', 404);
        if ($id === WorkspaceContext::of($uid)) {
            return Json::err($res, 'Die eigene Kontogruppe kann nicht gelöscht werden', 422, 'own_workspace');
        }

        $pdo = Database::pdo();
        $u = $pdo->prepare('SELECT COUNT(*) AS n FROM users WHERE workspace_id = ?');
        $u->execute([$id]);
        $c = $pdo->prepare('SELECT COUNT(*) AS n FROM companies WHERE workspace_id = ?');
        $c->execute([$id]);
        $users = (int)$u->fetch()['n'];
        $companies = (int)$c->fetch()['n'];
        if ($users > 0 || $companies > 0) {
            return Json::err(
                $res,
                'Gruppe ist nicht leer (' . $users . ' Benutzer, ' . $companies . ' Firmen). '
                . 'Bitte zuerst zuweisen oder löschen.',
                422,
                'not_empty'
            );
        }

        $pdo->prepare('DELETE FROM workspaces WHERE id = ?')->execute([$id]);
        return Json::ok($res, ['ok' => true]);
    }

    private static function exists(int $id): bool
    {
        if ($id <= 0) return false;
        $s = Database::pdo()->prepare('SELECT 1 FROM workspaces WHERE id = ?');
        $s->execute([$id]);
        return (bool)$s->fetch();
    }
}
