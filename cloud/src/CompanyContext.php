<?php
declare(strict_types=1);

namespace Nyza;

use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Multi-company (Mandantenfähigkeit) resolution for accounting. Every accounting
 * record belongs to a company; the client picks an "active company" per request
 * via the `X-Company-Id` header or `?company_id` query param. Membership is
 * stored in company_members; an admin implicitly has access to every company in
 * their own Kontogruppe (see WorkspaceContext) — never beyond it.
 *
 * The company profile (legal name, bank details, payment term, reminder fees …)
 * lives per-company in companies.profile as a JSON document — replacing the old
 * per-user app_settings ns='company'.
 */
final class CompanyContext
{
    /**
     * Resolve the active company for this request. Honours an explicit
     * X-Company-Id header / ?company_id query param when the caller is a member
     * (or admin); otherwise falls back to the user's first company by
     * membership, then MIN(companies.id). Always returns a valid company id —
     * if none exist at all, one is created and the user is joined to it.
     */
    public static function active(Request $req, int $uid): int
    {
        $pdo = Database::pdo();
        $wid = WorkspaceContext::of($uid);

        $requested = self::requestedId($req);
        if ($requested > 0 && self::isMember($uid, $requested)) {
            return $requested;
        }

        // Preferred: a company this user is explicitly attached to, in their group.
        $s = $pdo->prepare(
            'SELECT cm.company_id FROM company_members cm '
            . 'JOIN companies c ON c.id = cm.company_id '
            . 'WHERE cm.user_id = ? AND c.workspace_id = ? ORDER BY cm.company_id ASC LIMIT 1'
        );
        $s->execute([$uid, $wid]);
        $row = $s->fetch();
        if ($row) return (int)$row['company_id'];

        // Otherwise the group's first company — for every role. The group is the
        // isolation boundary, so this can only ever land on the user's own team's
        // books. Falling through to a fresh company here instead (as it used to
        // for non-admins) spawned an empty "Mein Unternehmen" next to the real
        // one the team had already created.
        $s = $pdo->prepare('SELECT MIN(id) AS id FROM companies WHERE workspace_id = ?');
        $s->execute([$wid]);
        $min = $s->fetch();
        if ($min && $min['id'] !== null) return (int)$min['id'];

        // The group has no company at all yet — create its first one.
        $pdo->prepare('INSERT INTO companies (name, profile, workspace_id) VALUES (?, NULL, ?)')
            ->execute(['Mein Unternehmen', $wid]);
        $cid = (int)$pdo->lastInsertId();
        $pdo->prepare('INSERT INTO company_members (company_id, user_id) VALUES (?, ?)')
            ->execute([$cid, $uid]);
        return $cid;
    }

    /**
     * Whether the user may work in this company. The Kontogruppe is the access
     * boundary: a group's members share the group's companies, exactly like they
     * already share its tasks, calendar and times.
     *
     * No role crosses the boundary here — not even the Hauptadmin, whose extra
     * powers are administrative (managing groups, assigning users), not reading
     * another team's books. company_members still records who belongs where and
     * drives the member UI; it no longer gates access on its own, because a
     * user with no row used to get a private bootstrapped company inside a group
     * that already had one, which is where the stray "Mein Unternehmen" rows
     * came from.
     */
    public static function isMember(int $uid, int $companyId): bool
    {
        if ($companyId <= 0) return false;
        return WorkspaceContext::ownsCompany(WorkspaceContext::of($uid), $companyId);
    }

    /** Decode companies.profile JSON → array (empty array if missing/null). */
    public static function profile(int $companyId): array
    {
        $s = Database::pdo()->prepare('SELECT profile FROM companies WHERE id = ?');
        $s->execute([$companyId]);
        $row = $s->fetch();
        if (!$row || $row['profile'] === null) return [];
        $d = json_decode((string)$row['profile'], true);
        return is_array($d) ? $d : [];
    }

    /** Payment term (Zahlungsziel) in days from the profile; default 14. */
    public static function paymentTermDays(int $companyId): int
    {
        $p = self::profile($companyId);
        $v = $p['payment_term_days'] ?? null;
        if ($v === null || $v === '' || (int)$v <= 0) return 14;
        return (int)$v;
    }

    /**
     * VAT recognition method — 'soll' (accrual, at invoice/Leistungsdatum,
     * default — the common case for AT GmbHs) or 'ist' (cash, at payment).
     * Independent of EÜR profit, which always stays cash-basis.
     */
    public static function ustMethod(int $companyId): string
    {
        $p = self::profile($companyId);
        return ($p['ust_method'] ?? 'soll') === 'ist' ? 'ist' : 'soll';
    }

    /** Whether the user has role='admin'. Cached per request per uid. */
    public static function isAdmin(int $uid): bool
    {
        static $cache = [];
        if (array_key_exists($uid, $cache)) return $cache[$uid];
        $s = Database::pdo()->prepare('SELECT role FROM users WHERE id = ?');
        $s->execute([$uid]);
        $row = $s->fetch();
        return $cache[$uid] = ($row && ($row['role'] ?? 'user') === 'admin');
    }

    /** Explicit company id from header or query, or 0 if none/invalid. */
    private static function requestedId(Request $req): int
    {
        $hdr = $req->getHeaderLine('X-Company-Id');
        if ($hdr !== '' && ctype_digit(trim($hdr))) return (int)trim($hdr);
        $qp = $req->getQueryParams();
        if (isset($qp['company_id']) && (int)$qp['company_id'] > 0) return (int)$qp['company_id'];
        return 0;
    }
}
