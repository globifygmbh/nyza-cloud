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
 * Generic per-user settings store, namespaced (ns). Each (user, ns) holds a
 * JSON document. PUT shallow-merges the posted object into the stored one so
 * partial saves are fine. Used for the accounting company profile ('company')
 * and future app settings.
 */
final class SettingsRoutes
{
    private const ALLOWED_NS = ['company', 'notifications'];
    private const MAX_BYTES = 256 * 1024;

    public static function mount(App $app): void
    {
        $app->group('/api/settings', function (RouteCollectorProxy $g) {
            $g->get('/{ns}', [self::class, 'get']);
            $g->put('/{ns}', [self::class, 'put']);
        })->add(new AuthMiddleware());
    }

    public static function get(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $ns = (string)$args['ns'];
        if (!in_array($ns, self::ALLOWED_NS, true)) return Json::err($res, 'Unknown settings', 404);
        return Json::ok($res, ['settings' => self::read($uid, $ns)]);
    }

    public static function put(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $ns = (string)$args['ns'];
        if (!in_array($ns, self::ALLOWED_NS, true)) return Json::err($res, 'Unknown settings', 404);

        $body = (array) $req->getParsedBody();
        $merged = array_merge(self::read($uid, $ns), $body);
        $json = json_encode($merged, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($json === false || strlen($json) > self::MAX_BYTES) {
            return Json::err($res, 'Settings zu groß', 413);
        }
        // Portable UPSERT (no ON DUPLICATE assumptions about column list).
        $pdo = Database::pdo();
        $pdo->prepare(
            'INSERT INTO app_settings (user_id, ns, data) VALUES (?, ?, ?) '
            . 'ON DUPLICATE KEY UPDATE data = VALUES(data)'
        )->execute([$uid, $ns, $json]);
        return Json::ok($res, ['settings' => $merged]);
    }

    private static function read(int $uid, string $ns): array
    {
        $s = Database::pdo()->prepare('SELECT data FROM app_settings WHERE user_id = ? AND ns = ?');
        $s->execute([$uid, $ns]);
        $row = $s->fetch();
        if (!$row || $row['data'] === null) return [];
        $d = json_decode((string)$row['data'], true);
        return is_array($d) ? $d : [];
    }
}
