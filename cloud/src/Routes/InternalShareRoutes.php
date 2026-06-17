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
 * INTERNAL sharing between workspace members.
 *
 * An owner shares a single folder OR a single file with a specific other member.
 * Recipients get READ access (view / list / download). `can_edit` is stored for
 * a future write feature but is NOT enforced — non-owners cannot mutate.
 *
 * Access is hierarchical for folders: sharing a folder grants read access to the
 * folder, all of its files, and everything in its subtree. The accessor helpers
 * are public so FileRoutes / FolderRoutes can widen their READ paths.
 */
final class InternalShareRoutes
{
    public static function mount(App $app): void
    {
        $app->group('/api', function (RouteCollectorProxy $g) {
            $g->post('/internal-shares',        [self::class, 'create']);
            $g->get('/internal-shares',         [self::class, 'listForItem']);
            $g->delete('/internal-shares/{id}', [self::class, 'remove']);
            $g->get('/shared-with-me',          [self::class, 'sharedWithMe']);
        })->add(new AuthMiddleware());
    }

    // ───── Access helpers (shared with FileRoutes / FolderRoutes) ─────────────

    /**
     * True when $uid may READ folder $folderId: they own it, OR an internal_shares
     * row targets that folder or any ANCESTOR of it (walk parent_id upward).
     */
    public static function accessibleFolder(int $uid, int $folderId): bool
    {
        $pdo = Database::pdo();

        // Owner of the (live) folder.
        $own = $pdo->prepare('SELECT 1 FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NULL');
        $own->execute([$folderId, $uid]);
        if ($own->fetch()) return true;

        // A share targeting this folder or any ancestor.
        $shared = $pdo->prepare('SELECT 1 FROM internal_shares WHERE target_user_id = ? AND folder_id = ? LIMIT 1');
        $parent = $pdo->prepare('SELECT parent_id FROM folders WHERE id = ? AND deleted_at IS NULL');

        $current = $folderId;
        $guard = 0;
        while ($current !== null && $guard++ < 10000) {
            $shared->execute([$uid, $current]);
            if ($shared->fetch()) return true;
            $parent->execute([$current]);
            $row = $parent->fetch();
            if (!$row) break;
            $current = $row['parent_id'] !== null ? (int)$row['parent_id'] : null;
        }
        return false;
    }

    /**
     * True when $uid may READ file $fileId: they own it, OR a share targets the
     * file directly, OR a share targets the file's folder / any ancestor of it.
     */
    public static function accessibleFile(int $uid, int $fileId): bool
    {
        $pdo = Database::pdo();

        $stmt = $pdo->prepare('SELECT user_id, folder_id FROM files WHERE id = ? AND deleted_at IS NULL');
        $stmt->execute([$fileId]);
        $f = $stmt->fetch();
        if (!$f) return false;

        if ((int)$f['user_id'] === $uid) return true;

        // Direct file share.
        $direct = $pdo->prepare('SELECT 1 FROM internal_shares WHERE target_user_id = ? AND file_id = ? LIMIT 1');
        $direct->execute([$uid, $fileId]);
        if ($direct->fetch()) return true;

        // Inherit access from the containing folder (or any ancestor).
        if ($f['folder_id'] !== null) {
            return self::accessibleFolder($uid, (int)$f['folder_id']);
        }
        return false;
    }

    // ───── Routes ─────────────────────────────────────────────────────────────

    public static function create(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $b = (array) $req->getParsedBody();

        $target = isset($b['target_user_id']) ? (int)$b['target_user_id'] : 0;
        $folderId = array_key_exists('folder_id', $b) && $b['folder_id'] !== null && $b['folder_id'] !== '' ? (int)$b['folder_id'] : null;
        $fileId   = array_key_exists('file_id', $b)   && $b['file_id']   !== null && $b['file_id']   !== '' ? (int)$b['file_id']   : null;
        $canEdit = !empty($b['can_edit']) ? 1 : 0;

        if ($target <= 0) return Json::err($res, 'target_user_id required', 422);
        if (($folderId === null) === ($fileId === null)) {
            return Json::err($res, 'Provide exactly one of folder_id or file_id', 422);
        }
        if ($target === $uid) return Json::err($res, 'Cannot share with yourself', 422);

        $pdo = Database::pdo();

        // Target must be an existing active user.
        $tu = $pdo->prepare('SELECT id, name FROM users WHERE id = ? AND active = 1');
        $tu->execute([$target]);
        $targetRow = $tu->fetch();
        if (!$targetRow) return Json::err($res, 'Target user not found', 404);

        // Only the OWNER of the item may share it.
        if ($folderId !== null) {
            $o = $pdo->prepare('SELECT 1 FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NULL');
            $o->execute([$folderId, $uid]);
            if (!$o->fetch()) return Json::err($res, 'Forbidden', 403);
        } else {
            $o = $pdo->prepare('SELECT 1 FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL');
            $o->execute([$fileId, $uid]);
            if (!$o->fetch()) return Json::err($res, 'Forbidden', 403);
        }

        // Upsert: avoid duplicate rows for the same owner/target/item.
        if ($folderId !== null) {
            $dup = $pdo->prepare('SELECT id FROM internal_shares WHERE owner_id = ? AND target_user_id = ? AND folder_id = ? LIMIT 1');
            $dup->execute([$uid, $target, $folderId]);
        } else {
            $dup = $pdo->prepare('SELECT id FROM internal_shares WHERE owner_id = ? AND target_user_id = ? AND file_id = ? LIMIT 1');
            $dup->execute([$uid, $target, $fileId]);
        }
        $existing = $dup->fetch();
        if ($existing) {
            $id = (int)$existing['id'];
            $pdo->prepare('UPDATE internal_shares SET can_edit = ? WHERE id = ?')->execute([$canEdit, $id]);
        } else {
            $pdo->prepare(
                'INSERT INTO internal_shares (owner_id, target_user_id, folder_id, file_id, can_edit) VALUES (?, ?, ?, ?, ?)'
            )->execute([$uid, $target, $folderId, $fileId, $canEdit]);
            $id = (int)$pdo->lastInsertId();
        }

        return Json::ok($res, ['share' => [
            'id' => $id,
            'owner_id' => $uid,
            'target_user_id' => $target,
            'target_name' => $targetRow['name'],
            'folder_id' => $folderId,
            'file_id' => $fileId,
            'can_edit' => (bool)$canEdit,
        ]], $existing ? 200 : 201);
    }

    public static function remove(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        // Only the owner may remove the share.
        Database::pdo()->prepare('DELETE FROM internal_shares WHERE id = ? AND owner_id = ?')
            ->execute([$id, $uid]);
        return Json::ok($res, ['ok' => true]);
    }

    /** List who an item is shared with (owner only). */
    public static function listForItem(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $q = $req->getQueryParams();
        $folderId = isset($q['folder_id']) && $q['folder_id'] !== '' ? (int)$q['folder_id'] : null;
        $fileId   = isset($q['file_id'])   && $q['file_id']   !== '' ? (int)$q['file_id']   : null;

        if (($folderId === null) === ($fileId === null)) {
            return Json::err($res, 'Provide exactly one of folder_id or file_id', 422);
        }

        $pdo = Database::pdo();
        // Verify ownership before disclosing recipients.
        if ($folderId !== null) {
            $o = $pdo->prepare('SELECT 1 FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NULL');
            $o->execute([$folderId, $uid]);
            if (!$o->fetch()) return Json::err($res, 'Forbidden', 403);
            $stmt = $pdo->prepare(
                'SELECT s.id, s.target_user_id, s.can_edit, u.name AS target_name '
                . 'FROM internal_shares s JOIN users u ON u.id = s.target_user_id '
                . 'WHERE s.owner_id = ? AND s.folder_id = ? ORDER BY s.id DESC'
            );
            $stmt->execute([$uid, $folderId]);
        } else {
            $o = $pdo->prepare('SELECT 1 FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL');
            $o->execute([$fileId, $uid]);
            if (!$o->fetch()) return Json::err($res, 'Forbidden', 403);
            $stmt = $pdo->prepare(
                'SELECT s.id, s.target_user_id, s.can_edit, u.name AS target_name '
                . 'FROM internal_shares s JOIN users u ON u.id = s.target_user_id '
                . 'WHERE s.owner_id = ? AND s.file_id = ? ORDER BY s.id DESC'
            );
            $stmt->execute([$uid, $fileId]);
        }

        $rows = array_map(static function (array $r): array {
            return [
                'id' => (int)$r['id'],
                'target_user_id' => (int)$r['target_user_id'],
                'target_name' => $r['target_name'],
                'can_edit' => (bool)$r['can_edit'],
            ];
        }, $stmt->fetchAll());

        return Json::ok($res, ['shares' => $rows]);
    }

    /** Items shared with the caller — directly-shared folders + files only. */
    public static function sharedWithMe(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $pdo = Database::pdo();

        $folders = $pdo->prepare(
            'SELECT f.*, u.name AS owner_name '
            . 'FROM internal_shares s '
            . 'JOIN folders f ON f.id = s.folder_id AND f.deleted_at IS NULL '
            . 'JOIN users u ON u.id = f.user_id '
            . 'WHERE s.target_user_id = ? AND s.folder_id IS NOT NULL '
            . 'ORDER BY f.name'
        );
        $folders->execute([$uid]);

        $files = $pdo->prepare(
            'SELECT f.*, u.name AS owner_name '
            . 'FROM internal_shares s '
            . 'JOIN files f ON f.id = s.file_id AND f.deleted_at IS NULL '
            . 'JOIN users u ON u.id = f.user_id '
            . 'WHERE s.target_user_id = ? AND s.file_id IS NOT NULL '
            . 'ORDER BY f.created_at DESC'
        );
        $files->execute([$uid]);

        return Json::ok($res, [
            'folders' => $folders->fetchAll(),
            'files' => $files->fetchAll(),
        ]);
    }
}
