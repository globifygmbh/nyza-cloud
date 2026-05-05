<?php
declare(strict_types=1);

namespace Nyza\Routes;

use Nyza\Database;
use Nyza\Json;
use Nyza\Middleware\AuthMiddleware;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;

final class ActivityRoutes
{
    public static function mount(App $app): void
    {
        $app->get('/api/activity', [self::class, 'list'])->add(new AuthMiddleware());
        $app->get('/api/stats', [self::class, 'stats'])->add(new AuthMiddleware());
    }

    public static function list(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $limit = min(100, max(1, (int)($req->getQueryParams()['limit'] ?? 50)));
        $stmt = Database::pdo()->prepare('SELECT id, kind, payload, created_at FROM activity WHERE user_id = ? ORDER BY created_at DESC LIMIT ?');
        $stmt->execute([$uid, $limit]);
        $rows = array_map(static function (array $r): array {
            $r['payload'] = json_decode((string)$r['payload'], true) ?: [];
            return $r;
        }, $stmt->fetchAll());
        return Json::ok($res, ['activity' => $rows]);
    }

    public static function stats(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $pdo = Database::pdo();

        $files = $pdo->prepare('SELECT COUNT(*) AS c, COALESCE(SUM(size),0) AS s FROM files WHERE user_id = ?');
        $files->execute([$uid]);
        $f = $files->fetch();

        $folders = $pdo->prepare('SELECT COUNT(*) AS c FROM folders WHERE user_id = ?');
        $folders->execute([$uid]);

        $shares = $pdo->prepare('SELECT COUNT(*) AS c FROM share_links WHERE user_id = ?');
        $shares->execute([$uid]);

        $uplinks = $pdo->prepare('SELECT COUNT(*) AS c FROM upload_links WHERE user_id = ?');
        $uplinks->execute([$uid]);

        $week = $pdo->prepare("SELECT COUNT(*) AS c FROM files WHERE user_id = ? AND created_at >= datetime('now', '-7 days')");
        $week->execute([$uid]);

        $u = $pdo->prepare('SELECT storage_quota, storage_used FROM users WHERE id = ?');
        $u->execute([$uid]);

        return Json::ok($res, [
            'files' => (int)$f['c'],
            'storage_used' => (int)$f['s'],
            'folders' => (int)$folders->fetch()['c'],
            'shares' => (int)$shares->fetch()['c'],
            'upload_links' => (int)$uplinks->fetch()['c'],
            'week_uploads' => (int)$week->fetch()['c'],
            'quota' => (int)$u->fetch()['storage_quota'],
        ]);
    }
}
