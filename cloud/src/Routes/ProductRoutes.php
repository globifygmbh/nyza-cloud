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
 * Product / service catalogue. Reusable line items the owner can drop into
 * offers and invoices. Scoped to the single user.
 */
final class ProductRoutes
{
    public static function mount(App $app): void
    {
        $app->group('/api/products', function (RouteCollectorProxy $g) {
            $g->get('',        [self::class, 'list']);
            $g->post('',       [self::class, 'create']);
            $g->patch('/{id}', [self::class, 'update']);
            $g->delete('/{id}',[self::class, 'delete']);
        })->add(new AuthMiddleware());
    }

    public static function list(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $stmt = Database::pdo()->prepare('SELECT * FROM products WHERE user_id = ? ORDER BY name ASC');
        $stmt->execute([$uid]);
        return Json::ok($res, ['products' => array_map([self::class, 'shape'], $stmt->fetchAll())]);
    }

    public static function create(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        $name = trim((string)($b['name'] ?? ''));
        if ($name === '') return Json::err($res, 'Name erforderlich', 422);

        $description = isset($b['description']) && $b['description'] !== null && trim((string)$b['description']) !== ''
            ? (string)$b['description'] : null;
        $unit = isset($b['unit']) && trim((string)$b['unit']) !== '' ? (string)$b['unit'] : 'Stk';
        $unitPrice = isset($b['unit_price_net']) ? round((float)$b['unit_price_net'], 2) : 0.0;
        $taxRate = isset($b['tax_rate']) ? round((float)$b['tax_rate'], 2) : 20.0;
        $type = isset($b['type']) && trim((string)$b['type']) !== '' ? (string)$b['type'] : 'service';

        $stmt = Database::pdo()->prepare(
            'INSERT INTO products (user_id, name, description, unit, unit_price_net, tax_rate, type) '
            . 'VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([$uid, $name, $description, $unit, $unitPrice, $taxRate, $type]);
        $id = (int)Database::pdo()->lastInsertId();
        return Json::ok($res, ['product' => self::shape(self::fetchOne($uid, $id))], 201);
    }

    public static function update(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchOne($uid, $id)) return Json::err($res, 'Not found', 404);

        $b = (array) $req->getParsedBody();
        $sets = [];
        $params = [];

        if (array_key_exists('name', $b)) {
            $name = trim((string)$b['name']);
            if ($name === '') return Json::err($res, 'Name erforderlich', 422);
            $sets[] = 'name = ?'; $params[] = $name;
        }
        if (array_key_exists('description', $b)) {
            $sets[] = 'description = ?';
            $params[] = ($b['description'] !== null && trim((string)$b['description']) !== '') ? (string)$b['description'] : null;
        }
        if (array_key_exists('unit', $b)) {
            $sets[] = 'unit = ?';
            $params[] = trim((string)$b['unit']) !== '' ? (string)$b['unit'] : 'Stk';
        }
        if (array_key_exists('unit_price_net', $b)) {
            $sets[] = 'unit_price_net = ?'; $params[] = round((float)$b['unit_price_net'], 2);
        }
        if (array_key_exists('tax_rate', $b)) {
            $sets[] = 'tax_rate = ?'; $params[] = round((float)$b['tax_rate'], 2);
        }
        if (array_key_exists('type', $b)) {
            $sets[] = 'type = ?';
            $params[] = trim((string)$b['type']) !== '' ? (string)$b['type'] : 'service';
        }

        if ($sets) {
            $params[] = $id; $params[] = $uid;
            Database::pdo()->prepare('UPDATE products SET ' . implode(', ', $sets) . ' WHERE id = ? AND user_id = ?')
                ->execute($params);
        }
        return Json::ok($res, ['product' => self::shape(self::fetchOne($uid, $id))]);
    }

    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchOne($uid, $id)) return Json::err($res, 'Not found', 404);
        Database::pdo()->prepare('DELETE FROM products WHERE id = ? AND user_id = ?')->execute([$id, $uid]);
        return Json::ok($res, ['ok' => true]);
    }

    private static function fetchOne(int $uid, int $id): ?array
    {
        $stmt = Database::pdo()->prepare('SELECT * FROM products WHERE id = ? AND user_id = ?');
        $stmt->execute([$id, $uid]);
        $p = $stmt->fetch();
        return $p ?: null;
    }

    private static function shape(array $r): array
    {
        return [
            'id'             => (int)$r['id'],
            'name'           => $r['name'],
            'description'    => $r['description'],
            'unit'           => $r['unit'],
            'unit_price_net' => (float)$r['unit_price_net'],
            'tax_rate'       => (float)$r['tax_rate'],
            'type'           => $r['type'],
        ];
    }
}
