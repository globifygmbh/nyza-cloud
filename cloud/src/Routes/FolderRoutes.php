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
    /** Allowed folder colour/tone keys (Google-Drive-style colour tags + legacy). */
    private const TONES = ['violet', 'blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'gray', 'sunset', 'aurora', 'mono'];

    public static function mount(App $app): void
    {
        $app->group('/api/folders', function (RouteCollectorProxy $g) {
            $g->get('',           [self::class, 'list']);
            $g->post('',          [self::class, 'create']);
            $g->get('/{id}',      [self::class, 'show']);
            $g->patch('/{id}',    [self::class, 'rename']);
            $g->post('/{id}/pin', [self::class, 'pin']);
            $g->post('/{id}/restore', [self::class, 'restore']);
            $g->delete('/{id}',   [self::class, 'delete']);
        })->add(new AuthMiddleware());
    }

    public static function list(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $qp = $req->getQueryParams();
        $pdo = Database::pdo();

        // ?all=1 → flat list of every folder (used by the move-target picker).
        if (isset($qp['all'])) {
            $stmt = $pdo->prepare(
                'SELECT f.*, '
                . '  (SELECT COUNT(*) FROM files WHERE folder_id = f.id AND deleted_at IS NULL) AS item_count '
                . 'FROM folders f WHERE user_id = ? AND deleted_at IS NULL ORDER BY name'
            );
            $stmt->execute([$uid]);
            return Json::ok($res, ['folders' => $stmt->fetchAll()]);
        }

        $parent = $qp['parent_id'] ?? null;
        $sql = 'SELECT f.*, '
             . '  (SELECT COUNT(*) FROM files WHERE folder_id = f.id AND deleted_at IS NULL) AS item_count, '
             . '  (SELECT COALESCE(SUM(size),0) FROM files WHERE folder_id = f.id AND deleted_at IS NULL) AS total_size '
             . 'FROM folders f WHERE user_id = ? AND deleted_at IS NULL '
             . ($parent === null ? 'AND parent_id IS NULL ' : 'AND parent_id = ? ')
             . 'ORDER BY pinned DESC, updated_at DESC';
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
        $tone = in_array($b['tone'] ?? 'violet', self::TONES, true) ? $b['tone'] : 'violet';
        $parent = isset($b['parent_id']) ? (int)$b['parent_id'] : null;
        $autoRename = !empty($b['auto_rename']) ? 1 : 0;

        $stmt = Database::pdo()->prepare(
            'INSERT INTO folders (user_id, parent_id, name, kind, tone, auto_rename) VALUES (?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([$uid, $parent, $name, $kind, $tone, $autoRename]);
        $id = (int)Database::pdo()->lastInsertId();
        return Json::ok($res, ['folder' => self::fetchOne($uid, $id)], 201);
    }

    public static function show(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $folder = self::fetchOne($uid, $id);

        // Internal sharing: allow read access to a folder shared with this user
        // (directly or via an ancestor). For a shared folder we fall back to a
        // by-id fetch so the viewer can see the owner's folder + its contents.
        if (!$folder && InternalShareRoutes::accessibleFolder($uid, $id)) {
            $folder = self::fetchAny($id);
        }
        if (!$folder) return Json::err($res, 'Not found', 404);

        // Once access is confirmed, list the folder's ACTUAL contents (owner's
        // files / subfolders) by folder_id — not by the viewer's user_id — so a
        // shared folder shows what's really inside it. deleted_at still filtered.
        $files = Database::pdo()->prepare('SELECT * FROM files WHERE folder_id = ? AND deleted_at IS NULL ORDER BY pinned DESC, created_at DESC');
        $files->execute([$id]);
        $sub = Database::pdo()->prepare('SELECT * FROM folders WHERE parent_id = ? AND deleted_at IS NULL ORDER BY pinned DESC, updated_at DESC');
        $sub->execute([$id]);
        return Json::ok($res, [
            'folder' => $folder,
            'files' => $files->fetchAll(),
            'subfolders' => $sub->fetchAll(),
        ]);
    }

    /** Fetch a live folder row by id regardless of owner (used after a shared
     *  access check has already authorised the viewer). */
    private static function fetchAny(int $id): ?array
    {
        $stmt = Database::pdo()->prepare(
            'SELECT f.*, '
            . '  (SELECT COUNT(*) FROM files WHERE folder_id = f.id AND deleted_at IS NULL) AS item_count, '
            . '  (SELECT COALESCE(SUM(size),0) FROM files WHERE folder_id = f.id AND deleted_at IS NULL) AS total_size '
            . 'FROM folders f WHERE id = ? AND deleted_at IS NULL'
        );
        $stmt->execute([$id]);
        $f = $stmt->fetch();
        return $f ?: null;
    }

    public static function rename(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $b = (array) $req->getParsedBody();

        // Moving: parent_id may be set (int) or explicitly null (→ root).
        $movingParent = array_key_exists('parent_id', $b);
        $newParent = $movingParent ? ($b['parent_id'] !== null ? (int)$b['parent_id'] : null) : null;
        if ($movingParent && $newParent !== null) {
            if ($newParent === $id) return Json::err($res, 'Ordner kann nicht in sich selbst verschoben werden', 422);
            // target must belong to the user and not be a descendant of $id
            $own = self::fetchOne($uid, $newParent);
            if (!$own) return Json::err($res, 'Zielordner nicht gefunden', 404);
            if (in_array($newParent, self::descendantIds($uid, $id), true)) {
                return Json::err($res, 'Ordner kann nicht in einen Unterordner verschoben werden', 422);
            }
        }

        $tone = (isset($b['tone']) && in_array($b['tone'], self::TONES, true)) ? $b['tone'] : null;
        $autoRename = array_key_exists('auto_rename', $b) ? (!empty($b['auto_rename']) ? 1 : 0) : null;
        $pdo = Database::pdo();
        $stmt = $pdo->prepare(
            'UPDATE folders SET name = COALESCE(?, name), kind = COALESCE(?, kind), tone = COALESCE(?, tone), auto_rename = COALESCE(?, auto_rename), updated_at = CURRENT_TIMESTAMP '
            . 'WHERE id = ? AND user_id = ?'
        );
        $stmt->execute([$b['name'] ?? null, $b['kind'] ?? null, $tone, $autoRename, $id, $uid]);

        if ($movingParent) {
            $pdo->prepare('UPDATE folders SET parent_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
                ->execute([$newParent, $id, $uid]);
        }
        return Json::ok($res, ['folder' => self::fetchOne($uid, $id)]);
    }

    /** All descendant folder ids of $id (excluding $id), breadth-first. */
    private static function descendantIds(int $uid, int $id): array
    {
        $pdo = Database::pdo();
        $child = $pdo->prepare('SELECT id FROM folders WHERE parent_id = ? AND user_id = ?');
        $out = [];
        $frontier = [$id];
        $guard = 0;
        while ($frontier && $guard++ < 10000) {
            $next = [];
            foreach ($frontier as $fid) {
                $child->execute([$fid, $uid]);
                foreach ($child->fetchAll() as $r) { $out[] = (int)$r['id']; $next[] = (int)$r['id']; }
            }
            $frontier = $next;
        }
        return $out;
    }

    // Soft delete — moves the folder AND its entire subtree (nested subfolders
    // + all files within) to the Papierkorb, mirroring file soft-delete
    // (FileRoutes::delete sets deleted_at). Blobs stay on disk and quota still
    // counts them; permanent removal happens via empty-trash. The subtree is
    // walked in PHP (breadth-first) over LIVE folders only — WITH RECURSIVE
    // needs MySQL 8.0+ / MariaDB 10.2.2+, and this app must run on older shared
    // hosts too. Each soft-deleted file/subfolder is stamped with the SAME
    // deleted_at instant as the root so restore can bring back exactly the rows
    // that were trashed together.
    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $pdo = Database::pdo();

        // Guard: the folder must exist, belong to the user, and be live.
        if (!self::fetchOne($uid, $id)) return Json::err($res, 'Not found', 404);

        $allIds = self::liveSubtreeIds($uid, $id);

        // One shared timestamp marks the whole subtree as trashed together.
        $now = date('Y-m-d H:i:s');
        $place = implode(',', array_fill(0, count($allIds), '?'));

        // Soft-delete every LIVE file in the subtree (skip already-trashed ones
        // so an earlier individual trash time is preserved).
        $pdo->prepare(
            "UPDATE files SET deleted_at = ? WHERE user_id = ? AND deleted_at IS NULL AND folder_id IN ($place)"
        )->execute(array_merge([$now, $uid], $allIds));

        // Soft-delete the folder + every descendant folder.
        $pdo->prepare(
            "UPDATE folders SET deleted_at = ? WHERE user_id = ? AND deleted_at IS NULL AND id IN ($place)"
        )->execute(array_merge([$now, $uid], $allIds));

        return Json::ok($res, ['ok' => true, 'trashed' => true]);
    }

    // Restore a trashed folder and the files/subfolders that were trashed in the
    // same operation (matched by the shared deleted_at instant). Best-effort: if
    // the parent is still trashed, the restored folder surfaces at its original
    // parent only once that parent is itself restored — but its rows are no
    // longer lost. Mirrors FileRoutes::restore (deleted_at = NULL).
    public static function restore(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $pdo = Database::pdo();

        $stmt = $pdo->prepare('SELECT deleted_at FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL');
        $stmt->execute([$id, $uid]);
        $row = $stmt->fetch();
        if (!$row) return Json::err($res, 'Not found', 404);
        $when = (string)$row['deleted_at'];

        // Restore the folder itself.
        $pdo->prepare('UPDATE folders SET deleted_at = NULL WHERE id = ? AND user_id = ?')
            ->execute([$id, $uid]);

        // Restore the rest of the subtree that was trashed at the SAME instant.
        // Walk the (now partially trashed) tree from this folder, keeping only
        // descendants whose deleted_at matches the root's trash time.
        $allIds = self::trashedSubtreeIds($uid, $id, $when);
        if ($allIds) {
            $place = implode(',', array_fill(0, count($allIds), '?'));
            $pdo->prepare(
                "UPDATE folders SET deleted_at = NULL WHERE user_id = ? AND deleted_at = ? AND id IN ($place)"
            )->execute(array_merge([$uid, $when], $allIds));
        }

        // Restore files in the whole (now-restored) subtree that share the trash
        // time. Include the root id so its own files come back too.
        $fileScope = array_merge([$id], $allIds);
        $fplace = implode(',', array_fill(0, count($fileScope), '?'));
        $pdo->prepare(
            "UPDATE files SET deleted_at = NULL WHERE user_id = ? AND deleted_at = ? AND folder_id IN ($fplace)"
        )->execute(array_merge([$uid, $when], $fileScope));

        return Json::ok($res, ['ok' => true, 'folder' => self::fetchOne($uid, $id)]);
    }

    /** Folder id + all LIVE descendant folder ids, breadth-first. */
    private static function liveSubtreeIds(int $uid, int $id): array
    {
        $pdo = Database::pdo();
        $childStmt = $pdo->prepare('SELECT id FROM folders WHERE parent_id = ? AND user_id = ? AND deleted_at IS NULL');
        $allIds = [$id];
        $frontier = [$id];
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
        return $allIds;
    }

    /** Descendant folder ids of $id that were trashed at $when (excluding $id). */
    private static function trashedSubtreeIds(int $uid, int $id, string $when): array
    {
        $pdo = Database::pdo();
        $childStmt = $pdo->prepare('SELECT id FROM folders WHERE parent_id = ? AND user_id = ? AND deleted_at = ?');
        $out = [];
        $frontier = [$id];
        $guard = 0;
        while ($frontier && $guard++ < 10000) {
            $next = [];
            foreach ($frontier as $fid) {
                $childStmt->execute([$fid, $uid, $when]);
                foreach ($childStmt->fetchAll() as $row) {
                    $cid = (int)$row['id'];
                    $out[] = $cid;
                    $next[] = $cid;
                }
            }
            $frontier = $next;
        }
        return $out;
    }

    public static function pin(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $stmt = Database::pdo()->prepare('SELECT pinned FROM folders WHERE id = ? AND user_id = ?');
        $stmt->execute([$id, $uid]);
        $row = $stmt->fetch();
        if (!$row) return Json::err($res, 'Not found', 404);
        $newPin = $row['pinned'] ? 0 : 1;
        Database::pdo()->prepare('UPDATE folders SET pinned = ? WHERE id = ? AND user_id = ?')
            ->execute([$newPin, $id, $uid]);
        return Json::ok($res, ['ok' => true, 'pinned' => (bool)$newPin]);
    }

    public static function fetchOne(int $uid, int $id): ?array
    {
        $stmt = Database::pdo()->prepare(
            'SELECT f.*, '
            . '  (SELECT COUNT(*) FROM files WHERE folder_id = f.id AND deleted_at IS NULL) AS item_count, '
            . '  (SELECT COALESCE(SUM(size),0) FROM files WHERE folder_id = f.id AND deleted_at IS NULL) AS total_size '
            . 'FROM folders f WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
        );
        $stmt->execute([$id, $uid]);
        $f = $stmt->fetch();
        return $f ?: null;
    }
}
