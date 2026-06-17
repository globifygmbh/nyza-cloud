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
 * Admin user management. No public registration — only an admin (role='admin')
 * may create, edit or delete accounts. Every route runs behind AuthMiddleware
 * AND requireAdmin(); a non-admin (or unknown) caller gets 403 "Nur Admin".
 *
 * Per-user data scoping / sharing is unchanged in this phase.
 */
final class AdminRoutes
{
    public static function mount(App $app): void
    {
        $app->group('/api/admin', function (RouteCollectorProxy $g) {
            $g->get('/users',          [self::class, 'list']);
            $g->post('/users',         [self::class, 'create']);
            $g->patch('/users/{id}',   [self::class, 'update']);
            $g->delete('/users/{id}',  [self::class, 'delete']);
            $g->get('/cron',           [self::class, 'cronInfo']);
        })->add(new AuthMiddleware());
    }

    /** Cron token + ready-to-copy command for the admin settings. */
    public static function cronInfo(Request $req, Response $res): Response
    {
        if (!self::requireAdmin($req)) return Json::err($res, 'Nur Admin', 403, 'forbidden');
        return Json::ok($res, ['token' => PushRoutes::effectiveCronToken()]);
    }

    /**
     * Load the current user (by attached `uid`) and return their row, or null
     * if missing / not an admin. Routes call this and 403 on null.
     */
    private static function requireAdmin(Request $req): ?array
    {
        $uid = (int)$req->getAttribute('uid');
        $stmt = Database::pdo()->prepare('SELECT id, email, name, role, active FROM users WHERE id = ?');
        $stmt->execute([$uid]);
        $u = $stmt->fetch();
        if (!$u || ($u['role'] ?? 'user') !== 'admin') return null;
        return $u;
    }

    /** Whether the users table carries a storage_used column. Cached per request. */
    private static function hasStorageUsed(): bool
    {
        static $has = null;
        if ($has !== null) return $has;
        try {
            Database::pdo()->query('SELECT storage_used FROM users LIMIT 0');
            $has = true;
        } catch (\Throwable $e) {
            $has = false;
        }
        return $has;
    }

    /** Public admin view of a user row. */
    private static function shape(array $u): array
    {
        $out = [
            'id' => (int)$u['id'],
            'email' => $u['email'],
            'name' => $u['name'],
            'role' => $u['role'] ?? 'user',
            'active' => isset($u['active']) ? (int)$u['active'] : 1,
            'created_at' => $u['created_at'] ?? null,
        ];
        if (array_key_exists('storage_used', $u)) {
            $out['storage_used'] = (int)$u['storage_used'];
        }
        return $out;
    }

    private static function fetchOne(int $id): ?array
    {
        $cols = 'id, email, name, role, active, created_at';
        if (self::hasStorageUsed()) $cols .= ', storage_used';
        $stmt = Database::pdo()->prepare("SELECT $cols FROM users WHERE id = ?");
        $stmt->execute([$id]);
        $u = $stmt->fetch();
        return $u ?: null;
    }

    public static function list(Request $req, Response $res): Response
    {
        if (!self::requireAdmin($req)) return Json::err($res, 'Nur Admin', 403, 'forbidden');
        $cols = 'id, email, name, role, active, created_at';
        if (self::hasStorageUsed()) $cols .= ', storage_used';
        $rows = Database::pdo()->query("SELECT $cols FROM users ORDER BY id")->fetchAll();
        return Json::ok($res, ['users' => array_map([self::class, 'shape'], $rows)]);
    }

    public static function create(Request $req, Response $res): Response
    {
        if (!self::requireAdmin($req)) return Json::err($res, 'Nur Admin', 403, 'forbidden');
        $b = (array) $req->getParsedBody();

        $email = trim((string)($b['email'] ?? ''));
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            return Json::err($res, 'Ungültige E-Mail', 422, 'invalid_email');
        }
        $password = (string)($b['password'] ?? '');
        if (strlen($password) < 8) {
            return Json::err($res, 'Passwort muss mindestens 8 Zeichen haben', 422, 'weak_password');
        }
        $name = trim((string)($b['name'] ?? ''));
        $role = ((string)($b['role'] ?? 'user') === 'admin') ? 'admin' : 'user';

        $pdo = Database::pdo();
        $chk = $pdo->prepare('SELECT 1 FROM users WHERE email = ?');
        $chk->execute([$email]);
        if ($chk->fetch()) return Json::err($res, 'E-Mail bereits vergeben', 409, 'email_taken');

        $pdo->prepare('INSERT INTO users (email, password_hash, name, role, active) VALUES (?, ?, ?, ?, 1)')
            ->execute([$email, password_hash($password, PASSWORD_BCRYPT), $name, $role]);
        $id = (int)$pdo->lastInsertId();

        return Json::ok($res, ['user' => self::shape(self::fetchOne($id) ?? [])], 201);
    }

    public static function update(Request $req, Response $res, array $args): Response
    {
        $me = self::requireAdmin($req);
        if (!$me) return Json::err($res, 'Nur Admin', 403, 'forbidden');
        $id = (int)$args['id'];
        $target = self::fetchOne($id);
        if (!$target) return Json::err($res, 'Not found', 404);
        $b = (array) $req->getParsedBody();
        $isSelf = ((int)$me['id'] === $id);

        $sets = [];
        $params = [];

        if (isset($b['name'])) {
            $sets[] = 'name = ?';
            $params[] = trim((string)$b['name']);
        }

        if (isset($b['role'])) {
            $role = ((string)$b['role'] === 'admin') ? 'admin' : 'user';
            if ($isSelf && $role !== 'admin') {
                return Json::err($res, 'Du kannst dich nicht selbst sperren/herabstufen', 422, 'self_lockout');
            }
            $sets[] = 'role = ?';
            $params[] = $role;
        }

        if (isset($b['active'])) {
            $active = (int)((bool)$b['active']);
            if ($isSelf && $active === 0) {
                return Json::err($res, 'Du kannst dich nicht selbst sperren/herabstufen', 422, 'self_lockout');
            }
            $sets[] = 'active = ?';
            $params[] = $active;
        }

        if (isset($b['password'])) {
            $password = (string)$b['password'];
            if (strlen($password) < 8) {
                return Json::err($res, 'Passwort muss mindestens 8 Zeichen haben', 422, 'weak_password');
            }
            $sets[] = 'password_hash = ?';
            $params[] = password_hash($password, PASSWORD_BCRYPT);
        }

        if ($sets) {
            $params[] = $id;
            Database::pdo()->prepare('UPDATE users SET ' . implode(', ', $sets) . ' WHERE id = ?')
                ->execute($params);
        }

        return Json::ok($res, ['user' => self::shape(self::fetchOne($id) ?? [])]);
    }

    public static function delete(Request $req, Response $res, array $args): Response
    {
        $me = self::requireAdmin($req);
        if (!$me) return Json::err($res, 'Nur Admin', 403, 'forbidden');
        $id = (int)$args['id'];
        if ((int)$me['id'] === $id) {
            return Json::err($res, 'Du kannst dich nicht selbst löschen', 422, 'self_delete');
        }
        $target = self::fetchOne($id);
        if (!$target) return Json::err($res, 'Not found', 404);

        Database::pdo()->prepare('DELETE FROM users WHERE id = ?')->execute([$id]);
        return Json::ok($res, ['ok' => true]);
    }
}
