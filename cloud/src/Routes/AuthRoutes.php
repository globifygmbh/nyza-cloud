<?php
declare(strict_types=1);

namespace Nyza\Routes;

use Nyza\Auth;
use Nyza\Database;
use Nyza\Json;
use Nyza\Middleware\AuthMiddleware;
use Nyza\Storage;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;
use Slim\Psr7\Stream;

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
        $app->post('/api/auth/change-password', [self::class, 'changePassword'])->add(new AuthMiddleware());
        $app->patch('/api/auth/profile',        [self::class, 'updateProfile'])->add(new AuthMiddleware());
        $app->post('/api/auth/logo',            [self::class, 'uploadLogo'])->add(new AuthMiddleware());
        $app->delete('/api/auth/logo',          [self::class, 'deleteLogo'])->add(new AuthMiddleware());
        // Public: serve a user's logo for share/upload-page branding.
        $app->get('/api/branding/logo/{uid}',   [self::class, 'serveLogo']);
    }

    /** Public user payload — id/email/name/accent + whether a logo exists. */
    public static function publicUser(array $u): array
    {
        return [
            'id' => (int)$u['id'], 'email' => $u['email'], 'name' => $u['name'],
            'accent' => $u['accent'] ?? null,
            'has_logo' => !empty($u['logo_path']),
        ];
    }

    public static function login(Request $req, Response $res): Response
    {
        // Brute-force guard: 10 attempts / 5 min per IP.
        if (!\Nyza\RateLimiter::allowReq($req, 'login', 10, 300)) {
            return Json::err($res, 'Zu viele Login-Versuche — bitte später erneut', 429, 'rate_limited');
        }
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
        return Json::ok($res, ['token' => $token, 'user' => self::publicUser($u)]);
    }

    public static function me(Request $req, Response $res): Response
    {
        $uid = Auth::userId($req);
        if (!$uid) return Json::err($res, 'Unauthorized', 401);
        $stmt = Database::pdo()->prepare('SELECT id, email, name, storage_quota, storage_used, accent, logo_path, created_at FROM users WHERE id = ?');
        $stmt->execute([$uid]);
        $u = $stmt->fetch();
        if (!$u) return Json::err($res, 'Not found', 404);
        return Json::ok($res, ['user' => self::publicUser($u) + [
            'storage_quota' => (int)$u['storage_quota'],
            'storage_used' => (int)$u['storage_used'],
            'created_at' => $u['created_at'],
        ]]);
    }

    public static function updateProfile(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        $pdo = Database::pdo();

        if (isset($b['email'])) {
            $email = trim((string)$b['email']);
            if (!filter_var($email, FILTER_VALIDATE_EMAIL)) return Json::err($res, 'Ungültige E-Mail', 422);
            $chk = $pdo->prepare('SELECT 1 FROM users WHERE email = ? AND id <> ?');
            $chk->execute([$email, $uid]);
            if ($chk->fetch()) return Json::err($res, 'E-Mail bereits vergeben', 409);
        }
        $accent = null;
        if (isset($b['accent'])) {
            $accent = preg_replace('/[^a-z0-9]/', '', strtolower((string)$b['accent'])) ?: null;
        }
        $pdo->prepare('UPDATE users SET name = COALESCE(?, name), email = COALESCE(?, email), accent = COALESCE(?, accent) WHERE id = ?')
            ->execute([
                isset($b['name']) ? trim((string)$b['name']) : null,
                isset($b['email']) ? trim((string)$b['email']) : null,
                $accent,
                $uid,
            ]);
        $stmt = $pdo->prepare('SELECT id, email, name, accent, logo_path FROM users WHERE id = ?');
        $stmt->execute([$uid]);
        return Json::ok($res, ['user' => self::publicUser($stmt->fetch())]);
    }

    public static function uploadLogo(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $file = $req->getUploadedFiles()['file'] ?? null;
        if (is_array($file)) $file = $file[0];
        if (!$file || $file->getError() !== UPLOAD_ERR_OK) return Json::err($res, 'Kein Bild hochgeladen', 422);
        $mime = $file->getClientMediaType() ?: '';
        if (!in_array($mime, ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/gif'], true)) {
            return Json::err($res, 'Nur Bilddateien (PNG, JPG, WebP, SVG)', 415);
        }
        if ((int)$file->getSize() > 2 * 1024 * 1024) return Json::err($res, 'Logo zu groß (max 2 MB)', 413);

        $ext = ['image/png' => 'png', 'image/jpeg' => 'jpg', 'image/webp' => 'webp', 'image/svg+xml' => 'svg', 'image/gif' => 'gif'][$mime];
        $dir = Storage::root() . '/branding';
        if (!is_dir($dir)) @mkdir($dir, 0775, true);
        // remove any previous logo file for this user
        foreach (glob($dir . '/' . $uid . '.*') ?: [] as $old) @unlink($old);
        $rel = 'branding/' . $uid . '.' . $ext;
        $file->moveTo(Storage::abs($rel));
        Database::pdo()->prepare('UPDATE users SET logo_path = ? WHERE id = ?')->execute([$rel, $uid]);
        return Json::ok($res, ['ok' => true, 'has_logo' => true]);
    }

    public static function deleteLogo(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $pdo = Database::pdo();
        $stmt = $pdo->prepare('SELECT logo_path FROM users WHERE id = ?');
        $stmt->execute([$uid]);
        $u = $stmt->fetch();
        if ($u && $u['logo_path']) Storage::deleteRel($u['logo_path']);
        $pdo->prepare('UPDATE users SET logo_path = NULL WHERE id = ?')->execute([$uid]);
        return Json::ok($res, ['ok' => true]);
    }

    public static function serveLogo(Request $req, Response $res, array $args): Response
    {
        $stmt = Database::pdo()->prepare('SELECT logo_path FROM users WHERE id = ?');
        $stmt->execute([(int)$args['uid']]);
        $u = $stmt->fetch();
        if (!$u || !$u['logo_path']) return Json::err($res, 'No logo', 404);
        $abs = Storage::abs($u['logo_path']);
        if (!is_file($abs)) return Json::err($res, 'Missing', 410);
        $ext = strtolower(pathinfo($abs, PATHINFO_EXTENSION));
        $mime = ['png' => 'image/png', 'jpg' => 'image/jpeg', 'webp' => 'image/webp', 'svg' => 'image/svg+xml', 'gif' => 'image/gif'][$ext] ?? 'application/octet-stream';
        return $res
            ->withHeader('Content-Type', $mime)
            ->withHeader('Cache-Control', 'public, max-age=3600')
            ->withHeader('X-Content-Type-Options', 'nosniff')
            ->withBody(new Stream(fopen($abs, 'rb')));
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
