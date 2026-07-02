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
 * Text-Bausteine: a per-user library of reusable text blocks (greetings,
 * payment terms, closings, …) for mail/offer composition. Plain text, no
 * encryption needed — same scoping pattern as Vault/Forms.
 */
final class SnippetRoutes
{
    public static function mount(App $app): void
    {
        $app->group('/api/snippets', function (RouteCollectorProxy $g) {
            $g->get('',           [self::class, 'list']);
            $g->post('',          [self::class, 'create']);
            $g->patch('/{id}',    [self::class, 'update']);
            $g->delete('/{id}',   [self::class, 'delete']);
            $g->post('/{id}/use', [self::class, 'touch']);
        })->add(new AuthMiddleware());
    }

    public static function list(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $q = (array)$req->getQueryParams();
        $sql = 'SELECT id, category, title, body, use_count, updated_at FROM text_snippets WHERE user_id = ?';
        $vals = [$uid];
        $search = trim((string)($q['q'] ?? ''));
        if ($search !== '') {
            $sql .= ' AND (title LIKE ? OR body LIKE ?)';
            $like = '%' . $search . '%';
            $vals[] = $like; $vals[] = $like;
        }
        if (trim((string)($q['category'] ?? '')) !== '') {
            $sql .= ' AND category = ?';
            $vals[] = trim((string)$q['category']);
        }
        $sql .= ' ORDER BY use_count DESC, title ASC';
        $s = Database::pdo()->prepare($sql);
        $s->execute($vals);
        $rows = array_map(static fn($r) => self::shape($r), $s->fetchAll());
        return Json::ok($res, ['snippets' => $rows]);
    }

    public static function create(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $b = (array)$req->getParsedBody();
        $title = trim((string)($b['title'] ?? ''));
        $body = trim((string)($b['body'] ?? ''));
        if ($title === '' || $body === '') return Json::err($res, 'Titel und Text erforderlich', 422);
        $category = trim((string)($b['category'] ?? '')) ?: null;
        Database::pdo()->prepare('INSERT INTO text_snippets (user_id, company_id, category, title, body) VALUES (?, ?, ?, ?, ?)')
            ->execute([$uid, $cid, $category ? mb_substr($category, 0, 100) : null, mb_substr($title, 0, 255), $body]);
        $id = (int)Database::pdo()->lastInsertId();
        return Json::ok($res, ['snippet' => self::fetchOne($uid, $id)], 201);
    }

    public static function update(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchOne($uid, $id)) return Json::err($res, 'Not found', 404);
        $b = (array)$req->getParsedBody();
        $sets = []; $vals = [];
        if (array_key_exists('title', $b)) {
            $title = trim((string)$b['title']);
            if ($title === '') return Json::err($res, 'Titel erforderlich', 422);
            $sets[] = 'title = ?'; $vals[] = mb_substr($title, 0, 255);
        }
        if (array_key_exists('body', $b)) {
            $body = trim((string)$b['body']);
            if ($body === '') return Json::err($res, 'Text erforderlich', 422);
            $sets[] = 'body = ?'; $vals[] = $body;
        }
        if (array_key_exists('category', $b)) {
            $category = trim((string)$b['category']);
            $sets[] = 'category = ?'; $vals[] = $category !== '' ? mb_substr($category, 0, 100) : null;
        }
        if (!$sets) return Json::err($res, 'Nichts zu ändern', 422);
        $vals[] = $id; $vals[] = $uid;
        Database::pdo()->prepare('UPDATE text_snippets SET ' . implode(', ', $sets) . ' WHERE id = ? AND user_id = ?')->execute($vals);
        return Json::ok($res, ['snippet' => self::fetchOne($uid, $id)]);
    }

    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        Database::pdo()->prepare('DELETE FROM text_snippets WHERE id = ? AND user_id = ?')->execute([(int)$args['id'], $uid]);
        return Json::ok($res, ['ok' => true]);
    }

    /** Bump use_count when a snippet gets inserted somewhere — lets frequently used ones bubble up. */
    public static function touch(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        Database::pdo()->prepare('UPDATE text_snippets SET use_count = use_count + 1 WHERE id = ? AND user_id = ?')->execute([(int)$args['id'], $uid]);
        return Json::ok($res, ['ok' => true]);
    }

    private static function fetchOne(int $uid, int $id): ?array
    {
        $s = Database::pdo()->prepare('SELECT id, category, title, body, use_count, updated_at FROM text_snippets WHERE id = ? AND user_id = ?');
        $s->execute([$id, $uid]);
        $r = $s->fetch();
        return $r ? self::shape($r) : null;
    }

    private static function shape(array $r): array
    {
        return [
            'id' => (int)$r['id'], 'category' => $r['category'], 'title' => $r['title'],
            'body' => $r['body'], 'use_count' => (int)$r['use_count'], 'updated_at' => $r['updated_at'],
        ];
    }
}
