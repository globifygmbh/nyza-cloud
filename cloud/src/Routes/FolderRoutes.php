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

final class FolderRoutes
{
    public static function mount(App $app): void
    {
        $app->group('/api/folders', function (RouteCollectorProxy $g) {
            $g->get('',           [self::class, 'list']);
            $g->post('',          [self::class, 'create']);
            $g->get('/{id}',      [self::class, 'show']);
            $g->patch('/{id}',    [self::class, 'rename']);
            $g->delete('/{id}',   [self::class, 'delete']);
        })->add(new AuthMiddleware());
    }

    public static function list(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $parent = $req->getQueryParams()['parent_id'] ?? null;
        $pdo = Database::pdo();

        $sql = 'SELECT f.*, '
             . '  (SELECT COUNT(*) FROM files WHERE folder_id = f.id) AS item_count, '
             . '  (SELECT COALESCE(SUM(size),0) FROM files WHERE folder_id = f.id) AS total_size '
             . 'FROM folders f WHERE user_id = ? '
             . ($parent === null ? 'AND parent_id IS NULL ' : 'AND parent_id = ? ')
             . 'ORDER BY updated_at DESC';
        $stmt = $pdo->prepare($sql);
        $stmt->execute($parent === null ? [$uid] : [$uid, (int)$parent]);
        return Json::ok($res, ['folders' => $stmt->fetchAll()]);
    }

    public static function create(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();
        $name = trim((string)($b['name'] ?? ''));
        if ($name === '') return Json::err($res, 'Name required', 422);

        $kind = in_array($b['kind'] ?? 'normal', ['normal', 'gallery'], true) ? $b['kind'] : 'normal';
        $tone = in_array($b['tone'] ?? 'violet', ['violet', 'sunset', 'aurora', 'mono'], true) ? $b['tone'] : 'violet';
        $parent = isset($b['parent_id']) ? (int)$b['parent_id'] : null;

        $stmt = Database::pdo()->prepare(
            'INSERT INTO folders (user_id, parent_id, name, kind, tone) VALUES (?, ?, ?, ?, ?)'
        );
        $stmt->execute([$uid, $parent, $name, $kind, $tone]);
        $id = (int)Database::pdo()->lastInsertId();
        return Json::ok($res, ['folder' => self::fetchOne($uid, $id)], 201);
    }

    public static function show(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $folder = self::fetchOne($uid, $id);
        if (!$folder) return Json::err($res, 'Not found', 404);

        $files = Database::pdo()->prepare('SELECT * FROM files WHERE user_id = ? AND folder_id = ? ORDER BY created_at DESC');
        $files->execute([$uid, $id]);
        $sub = Database::pdo()->prepare('SELECT * FROM folders WHERE user_id = ? AND parent_id = ?');
        $sub->execute([$uid, $id]);
        return Json::ok($res, [
            'folder' => $folder,
            'files' => $files->fetchAll(),
            'subfolders' => $sub->fetchAll(),
        ]);
    }

    public static function rename(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $b = (array) $req->getParsedBody();
        $stmt = Database::pdo()->prepare(
            'UPDATE folders SET name = COALESCE(?, name), kind = COALESCE(?, kind), tone = COALESCE(?, tone), updated_at = CURRENT_TIMESTAMP '
            . 'WHERE id = ? AND user_id = ?'
        );
        $stmt->execute([
            $b['name'] ?? null,
            $b['kind'] ?? null,
            $b['tone'] ?? null,
            $id, $uid,
        ]);
        return Json::ok($res, ['folder' => self::fetchOne($uid, $id)]);
    }

    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $pdo = Database::pdo();

        // ON DELETE CASCADE removes child folders + files rows, but the file
        // blobs on disk need explicit cleanup. Walk the folder subtree in PHP
        // (breadth-first) instead of a recursive CTE — WITH RECURSIVE needs
        // MySQL 8.0+ / MariaDB 10.2.2+, and this app must run on older shared
        // hosts too.
        $allIds = [$id];
        $frontier = [$id];
        $childStmt = $pdo->prepare('SELECT id FROM folders WHERE parent_id = ? AND user_id = ?');
        $guard = 0;
        while ($frontier && $guard++ < 10000) {
            $next = [];
            foreach ($frontier as $fid) {
                $childStmt->execute([$fid, $uid]);
                foreach ($childStmt->fetchAll() as $row) {
                    $cid = (int)$row['id'];
                    $allIds[] = $cid;
                    $next[] = $cid;
                }
            }
            $frontier = $next;
        }

        // Collect blob paths for every file in the subtree before deletion.
        $place = implode(',', array_fill(0, count($allIds), '?'));
        $blobs = $pdo->prepare("SELECT storage_path FROM files WHERE user_id = ? AND folder_id IN ($place)");
        $blobs->execute(array_merge([$uid], $allIds));
        $paths = array_column($blobs->fetchAll(), 'storage_path');

        // Deleting the root cascades the rest via FK ON DELETE CASCADE.
        $pdo->prepare('DELETE FROM folders WHERE id = ? AND user_id = ?')->execute([$id, $uid]);

        foreach ($paths as $p) {
            \Nyza\Storage::deleteRel($p);
        }
        return Json::ok($res, ['ok' => true]);
    }

    public static function fetchOne(int $uid, int $id): ?array
    {
        $stmt = Database::pdo()->prepare(
            'SELECT f.*, '
            . '  (SELECT COUNT(*) FROM files WHERE folder_id = f.id) AS item_count, '
            . '  (SELECT COALESCE(SUM(size),0) FROM files WHERE folder_id = f.id) AS total_size '
            . 'FROM folders f WHERE id = ? AND user_id = ?'
        );
        $stmt->execute([$id, $uid]);
        $f = $stmt->fetch();
        return $f ?: null;
    }
}
