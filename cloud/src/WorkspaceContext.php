<?php
declare(strict_types=1);

namespace Nyza;

/**
 * Kontogruppen (workspaces) — the outermost tenancy boundary.
 *
 * A workspace owns users AND companies. Two groups sharing one installation
 * must never see each other's tasks, calendar, times, contacts, employees or
 * Buchhaltung, so every list query filters on the caller's workspace and every
 * insert stamps it.
 *
 * Roles, in order:
 *   - Hauptadmin (users.is_primary) — the only account that crosses workspaces
 *     (manages the groups themselves and can look into any of them).
 *   - admin — full rights, but ONLY inside their own workspace.
 *   - user — a normal member of their workspace.
 */
final class WorkspaceContext
{
    /**
     * The user's workspace id. A user with no group yet (created before this
     * feature, or orphaned by a deleted group) is bootstrapped into their own
     * isolated one rather than silently joining someone else's.
     */
    public static function of(int $uid): int
    {
        static $cache = [];
        if (isset($cache[$uid])) return $cache[$uid];

        $pdo = Database::pdo();
        $s = $pdo->prepare('SELECT workspace_id, name, email FROM users WHERE id = ?');
        $s->execute([$uid]);
        $row = $s->fetch();
        if ($row && $row['workspace_id'] !== null) {
            return $cache[$uid] = (int)$row['workspace_id'];
        }

        $label = trim((string)($row['name'] ?? '')) !== ''
            ? (string)$row['name'] : (string)($row['email'] ?? 'Team');
        $pdo->prepare('INSERT INTO workspaces (name) VALUES (?)')->execute([$label]);
        $wid = (int)$pdo->lastInsertId();
        $pdo->prepare('UPDATE users SET workspace_id = ? WHERE id = ?')->execute([$wid, $uid]);
        return $cache[$uid] = $wid;
    }

    /** The Hauptadmin — the only role that may act across workspaces. */
    public static function isPrimary(int $uid): bool
    {
        static $cache = [];
        if (array_key_exists($uid, $cache)) return $cache[$uid];
        $s = Database::pdo()->prepare('SELECT is_primary FROM users WHERE id = ?');
        $s->execute([$uid]);
        $row = $s->fetch();
        return $cache[$uid] = ($row && !empty($row['is_primary']));
    }

    /** Whether a user id belongs to the given workspace (Hauptadmin: always). */
    public static function userIn(int $targetUid, int $workspaceId): bool
    {
        if ($targetUid <= 0 || $workspaceId <= 0) return false;
        $s = Database::pdo()->prepare('SELECT 1 FROM users WHERE id = ? AND workspace_id = ?');
        $s->execute([$targetUid, $workspaceId]);
        return (bool)$s->fetch();
    }

    /** Whether two users share a workspace — used to gate cross-user features. */
    public static function sameGroup(int $a, int $b): bool
    {
        if ($a === $b) return true;
        return self::of($a) === self::of($b);
    }

    /** Whether a company belongs to the given workspace. */
    public static function ownsCompany(int $workspaceId, int $companyId): bool
    {
        if ($companyId <= 0 || $workspaceId <= 0) return false;
        $s = Database::pdo()->prepare('SELECT 1 FROM companies WHERE id = ? AND workspace_id = ?');
        $s->execute([$companyId, $workspaceId]);
        return (bool)$s->fetch();
    }

    /** All workspaces, newest last — Hauptadmin management view. */
    public static function all(): array
    {
        $rows = Database::pdo()->query(
            'SELECT w.id, w.name, w.created_at, '
            . '(SELECT COUNT(*) FROM users u WHERE u.workspace_id = w.id) AS user_count, '
            . '(SELECT COUNT(*) FROM companies c WHERE c.workspace_id = w.id) AS company_count '
            . 'FROM workspaces w ORDER BY w.id ASC'
        )->fetchAll();
        return array_map(static fn(array $r) => [
            'id'            => (int)$r['id'],
            'name'          => $r['name'],
            'user_count'    => (int)$r['user_count'],
            'company_count' => (int)$r['company_count'],
            'created_at'    => $r['created_at'],
        ], $rows);
    }
}
