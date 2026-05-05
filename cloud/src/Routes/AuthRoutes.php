<?php
declare(strict_types=1);

namespace Nyza\Routes;

use Nyza\Auth;
use Nyza\Database;
use Nyza\Json;
use Nyza\Middleware\AuthMiddleware;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;

/**
 * Single-user model — no public registration. The admin account is created
 * exactly once by the SetupWizard. Adding more users would mean either:
 *   (a) re-running the wizard (currently bails if a user exists), or
 *   (b) adding a /api/admin/users endpoint behind auth.
 */
final class AuthRoutes
{
    public static function mount(App $app): void
    {
        $app->post('/api/auth/login',           [self::class, 'login']);
        $app->get('/api/auth/me',               [self::class, 'me']);
        $app->post('/api/auth/change-password', [self::class, 'changePassword'])
            ->add(new AuthMiddleware());
    }

    public static function login(Request $req, Response $res): Response
    {
        $b = (array) $req->getParsedBody();
        $email = trim((string)($b['email'] ?? ''));
        $password = (string)($b['password'] ?? '');

        $pdo = Database::pdo();
        $stmt = $pdo->prepare('SELECT id, email, password_hash, name FROM users WHERE email = ?');
        $stmt->execute([$email]);
        $u = $stmt->fetch();
        if (!$u || !password_verify($password, $u['password_hash'])) {
            return Json::err($res, 'Invalid credentials', 401, 'invalid_credentials');
        }
        $token = Auth::issue((int)$u['id'], $u['email']);
        return Json::ok($res, [
            'token' => $token,
            'user'  => ['id' => (int)$u['id'], 'email' => $u['email'], 'name' => $u['name']],
        ]);
    }

    public static function me(Request $req, Response $res): Response
    {
        $uid = Auth::userId($req);
        if (!$uid) return Json::err($res, 'Unauthorized', 401);
        $stmt = Database::pdo()->prepare('SELECT id, email, name, storage_quota, storage_used, created_at FROM users WHERE id = ?');
        $stmt->execute([$uid]);
        $u = $stmt->fetch();
        if (!$u) return Json::err($res, 'Not found', 404);
        return Json::ok($res, ['user' => $u]);
    }

    public static function changePassword(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        $current = (string)($b['current_password'] ?? '');
        $new     = (string)($b['new_password'] ?? '');

        if (strlen($new) < 10) {
            return Json::err($res, 'Neues Passwort muss mindestens 10 Zeichen haben', 422, 'weak_password');
        }

        $pdo = Database::pdo();
        $stmt = $pdo->prepare('SELECT password_hash FROM users WHERE id = ?');
        $stmt->execute([$uid]);
        $u = $stmt->fetch();
        if (!$u || !password_verify($current, $u['password_hash'])) {
            return Json::err($res, 'Aktuelles Passwort ist falsch', 401, 'wrong_password');
        }

        $pdo->prepare('UPDATE users SET password_hash = ? WHERE id = ?')
            ->execute([password_hash($new, PASSWORD_BCRYPT), $uid]);
        return Json::ok($res, ['ok' => true]);
    }
}
