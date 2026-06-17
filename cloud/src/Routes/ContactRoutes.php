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
 * Contacts / CRM. A single contact entity that can be flagged as a customer
 * (is_customer) — no separate customer record. Time tracking and accounting
 * reference these rows as their "Kunde".
 */
final class ContactRoutes
{
    private const KINDS = ['person', 'company'];

    public static function mount(App $app): void
    {
        $app->group('/api/contacts', function (RouteCollectorProxy $g) {
            $g->get('',        [self::class, 'list']);
            $g->post('',       [self::class, 'create']);
            $g->get('/{id}',   [self::class, 'show']);
            $g->patch('/{id}', [self::class, 'update']);
            $g->delete('/{id}',[self::class, 'delete']);
        })->add(new AuthMiddleware());
    }

    public static function list(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $qp = $req->getQueryParams();
        $pdo = Database::pdo();

        $where = 'user_id = ?';
        $params = [$uid];
        if (isset($qp['customers'])) { $where .= ' AND is_customer = 1'; }
        if (!empty($qp['q'])) {
            $like = '%' . str_replace(['%', '_'], ['\%', '\_'], (string)$qp['q']) . '%';
            $where .= " AND (name LIKE ? ESCAPE '\\\\' OR email LIKE ? ESCAPE '\\\\' OR contact_person LIKE ? ESCAPE '\\\\')";
            $params[] = $like; $params[] = $like; $params[] = $like;
        }
        $stmt = $pdo->prepare("SELECT * FROM contacts WHERE $where ORDER BY is_customer DESC, name ASC");
        $stmt->execute($params);
        return Json::ok($res, ['contacts' => array_map([self::class, 'shape'], $stmt->fetchAll())]);
    }

    public static function show(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $c = self::fetchOne($uid, (int)$args['id']);
        if (!$c) return Json::err($res, 'Not found', 404);
        return Json::ok($res, ['contact' => self::shape($c)]);
    }

    public static function create(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        $name = trim((string)($b['name'] ?? ''));
        if ($name === '') return Json::err($res, 'Name erforderlich', 422);

        $f = self::fields($b, true);
        $cols = array_keys($f);
        $place = implode(', ', array_fill(0, count($cols), '?'));
        $stmt = Database::pdo()->prepare(
            'INSERT INTO contacts (user_id, ' . implode(', ', $cols) . ') VALUES (?, ' . $place . ')'
        );
        $stmt->execute(array_merge([$uid], array_values($f)));
        $id = (int)Database::pdo()->lastInsertId();
        return Json::ok($res, ['contact' => self::shape(self::fetchOne($uid, $id))], 201);
    }

    public static function update(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchOne($uid, $id)) return Json::err($res, 'Not found', 404);

        $b = (array) $req->getParsedBody();
        if (array_key_exists('name', $b) && trim((string)$b['name']) === '') {
            return Json::err($res, 'Name erforderlich', 422);
        }
        $f = self::fields($b, false);
        if (!$f) return Json::ok($res, ['contact' => self::shape(self::fetchOne($uid, $id))]);

        $sets = implode(', ', array_map(static fn($c) => "$c = ?", array_keys($f)));
        $params = array_merge(array_values($f), [$id, $uid]);
        Database::pdo()->prepare("UPDATE contacts SET $sets WHERE id = ? AND user_id = ?")->execute($params);
        return Json::ok($res, ['contact' => self::shape(self::fetchOne($uid, $id))]);
    }

    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchOne($uid, $id)) return Json::err($res, 'Not found', 404);
        Database::pdo()->prepare('DELETE FROM contacts WHERE id = ? AND user_id = ?')->execute([$id, $uid]);
        return Json::ok($res, ['ok' => true]);
    }

    /**
     * Build the column→value map from the request body. On create ($withDefaults)
     * every column is set (missing → sensible default); on update only the keys
     * actually present in the body are included so PATCH stays partial.
     */
    private static function fields(array $b, bool $withDefaults): array
    {
        $text = ['name', 'contact_person', 'email', 'phone', 'street', 'zip', 'city', 'country', 'vat_id', 'notes'];
        $out = [];
        foreach ($text as $k) {
            if (array_key_exists($k, $b)) {
                $v = $b[$k] === null ? null : trim((string)$b[$k]);
                $out[$k] = ($v === '' ? null : $v);
            } elseif ($withDefaults) {
                $out[$k] = null;
            }
        }
        if (array_key_exists('kind', $b)) {
            $out['kind'] = in_array($b['kind'], self::KINDS, true) ? $b['kind'] : 'person';
        } elseif ($withDefaults) {
            $out['kind'] = 'person';
        }
        if (array_key_exists('is_customer', $b)) {
            $out['is_customer'] = !empty($b['is_customer']) ? 1 : 0;
        } elseif ($withDefaults) {
            $out['is_customer'] = 0;
        }
        // name is required on create; guarantee it's present
        if ($withDefaults && !isset($out['name'])) $out['name'] = trim((string)($b['name'] ?? ''));
        return $out;
    }

    private static function fetchOne(int $uid, int $id): ?array
    {
        $stmt = Database::pdo()->prepare('SELECT * FROM contacts WHERE id = ? AND user_id = ?');
        $stmt->execute([$id, $uid]);
        $c = $stmt->fetch();
        return $c ?: null;
    }

    private static function shape(array $r): array
    {
        return [
            'id'             => (int)$r['id'],
            'kind'           => $r['kind'],
            'name'           => $r['name'],
            'contact_person' => $r['contact_person'],
            'email'          => $r['email'],
            'phone'          => $r['phone'],
            'street'         => $r['street'],
            'zip'            => $r['zip'],
            'city'           => $r['city'],
            'country'        => $r['country'],
            'vat_id'         => $r['vat_id'],
            'is_customer'    => (int)$r['is_customer'],
            'notes'          => $r['notes'],
            'created_at'     => $r['created_at'],
        ];
    }
}
