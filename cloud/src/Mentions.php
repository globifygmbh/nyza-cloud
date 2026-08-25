<?php
declare(strict_types=1);

namespace Nyza;

use Nyza\Routes\PushRoutes;

/**
 * @-mentions for comments. The client sends an explicit list of mentioned user
 * ids alongside the comment (chosen from the autocomplete), so there's no
 * fragile name parsing — we just validate the ids and push to those people.
 */
final class Mentions
{
    /**
     * Active users the current user may mention. Confined to their Kontogruppe —
     * the old fallback listed EVERY active account on the installation whenever
     * the user shared no company, which leaked other teams' member names.
     */
    public static function mentionable(int $uid): array
    {
        $pdo = Database::pdo();
        $s = $pdo->prepare(
            'SELECT id, name, email FROM users WHERE active = 1 AND workspace_id = ? ORDER BY name ASC, id ASC'
        );
        $s->execute([WorkspaceContext::of($uid)]);
        $rows = $s->fetchAll();
        return array_map(static fn($r) => [
            'id' => (int)$r['id'], 'name' => $r['name'], 'email' => $r['email'],
        ], $rows);
    }

    /**
     * Push a "you were mentioned" notification to each valid mentioned user
     * (skipping the author). $ids comes straight from the request body.
     */
    public static function notify(int $authorUid, string $authorName, $ids, string $where, string $body, string $url = '/'): void
    {
        if (!is_array($ids)) return;
        $clean = [];
        foreach ($ids as $v) {
            $id = (int)$v;
            if ($id > 0 && $id !== $authorUid) $clean[$id] = true;
        }
        if (!$clean) return;

        $pdo = Database::pdo();
        $place = implode(',', array_fill(0, count($clean), '?'));
        $chk = $pdo->prepare("SELECT id FROM users WHERE active = 1 AND id IN ($place)");
        $chk->execute(array_keys($clean));
        $snippet = mb_substr(trim($body), 0, 140);
        foreach ($chk->fetchAll() as $r) {
            PushRoutes::sendToUser((int)$r['id'], [
                'title' => $authorName . ' hat dich erwähnt',
                'body'  => $where . ': ' . $snippet,
                'url'   => $url,
            ]);
        }
    }
}
