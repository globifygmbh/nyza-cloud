<?php
declare(strict_types=1);

namespace Nyza\Routes;

use Nyza\CompanyContext;
use Nyza\Crypto;
use Nyza\Database;
use Nyza\Json;
use Nyza\Middleware\AuthMiddleware;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;
use Slim\Routing\RouteCollectorProxy;

/**
 * Credential vault ("Zugänge"). Per-user entries; password, notes and custom
 * field values are encrypted at rest. The list omits secrets; the detail
 * endpoint decrypts on demand so the client can reveal/copy.
 */
final class VaultRoutes
{
    public static function mount(App $app): void
    {
        $app->group('/api/vault', function (RouteCollectorProxy $g) {
            $g->get('',         [self::class, 'list']);
            $g->post('',        [self::class, 'create']);
            $g->get('/{id}',    [self::class, 'show']);
            $g->patch('/{id}',  [self::class, 'update']);
            $g->delete('/{id}', [self::class, 'delete']);
        })->add(new AuthMiddleware());
    }

    public static function list(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $s = Database::pdo()->prepare('SELECT id, title, username, email, url, password_enc FROM vault_entries WHERE user_id = ? ORDER BY title ASC');
        $s->execute([$uid]);
        $rows = array_map(static fn($r) => [
            'id' => (int)$r['id'], 'title' => $r['title'], 'username' => $r['username'],
            'email' => $r['email'], 'url' => $r['url'], 'has_password' => !empty($r['password_enc']),
        ], $s->fetchAll());
        return Json::ok($res, ['entries' => $rows]);
    }

    public static function show(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $r = self::fetch($uid, (int)$args['id']);
        if (!$r) return Json::err($res, 'Not found', 404);
        return Json::ok($res, ['entry' => self::shapeFull($r)]);
    }

    public static function create(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $b = (array)$req->getParsedBody();
        $title = trim((string)($b['title'] ?? ''));
        if ($title === '') return Json::err($res, 'Titel erforderlich', 422);
        Database::pdo()->prepare(
            'INSERT INTO vault_entries (user_id, company_id, title, username, email, url, password_enc, notes_enc, fields_enc) '
            . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([
            $uid, $cid, mb_substr($title, 0, 255),
            self::str($b['username'] ?? null, 255), self::str($b['email'] ?? null, 255), self::str($b['url'] ?? null, 500),
            Crypto::encrypt((string)($b['password'] ?? '')), Crypto::encrypt((string)($b['notes'] ?? '')),
            Crypto::encrypt(self::encodeFields($b['fields'] ?? [])),
        ]);
        $id = (int)Database::pdo()->lastInsertId();
        return Json::ok($res, ['entry' => self::shapeFull(self::fetch($uid, $id))], 201);
    }

    public static function update(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetch($uid, $id)) return Json::err($res, 'Not found', 404);
        $b = (array)$req->getParsedBody();
        $sets = []; $vals = [];
        if (array_key_exists('title', $b)) { $sets[] = 'title = ?'; $vals[] = mb_substr(trim((string)$b['title']) ?: 'Zugang', 0, 255); }
        if (array_key_exists('username', $b)) { $sets[] = 'username = ?'; $vals[] = self::str($b['username'], 255); }
        if (array_key_exists('email', $b)) { $sets[] = 'email = ?'; $vals[] = self::str($b['email'], 255); }
        if (array_key_exists('url', $b)) { $sets[] = 'url = ?'; $vals[] = self::str($b['url'], 500); }
        if (array_key_exists('password', $b)) { $sets[] = 'password_enc = ?'; $vals[] = Crypto::encrypt((string)$b['password']); }
        if (array_key_exists('notes', $b)) { $sets[] = 'notes_enc = ?'; $vals[] = Crypto::encrypt((string)$b['notes']); }
        if (array_key_exists('fields', $b)) { $sets[] = 'fields_enc = ?'; $vals[] = Crypto::encrypt(self::encodeFields($b['fields'])); }
        if (!$sets) return Json::err($res, 'Nichts zu ändern', 422);
        $vals[] = $id; $vals[] = $uid;
        Database::pdo()->prepare('UPDATE vault_entries SET ' . implode(', ', $sets) . ' WHERE id = ? AND user_id = ?')->execute($vals);
        return Json::ok($res, ['entry' => self::shapeFull(self::fetch($uid, $id))]);
    }

    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        Database::pdo()->prepare('DELETE FROM vault_entries WHERE id = ? AND user_id = ?')->execute([(int)$args['id'], $uid]);
        return Json::ok($res, ['ok' => true]);
    }

    // ───── helpers ─────────────────────────────────────────────────────────────
    private static function fetch(int $uid, int $id): ?array
    {
        $s = Database::pdo()->prepare('SELECT * FROM vault_entries WHERE id = ? AND user_id = ?');
        $s->execute([$id, $uid]);
        return $s->fetch() ?: null;
    }

    private static function shapeFull(array $r): array
    {
        $fields = json_decode(Crypto::decrypt($r['fields_enc'] ?? ''), true);
        return [
            'id'       => (int)$r['id'],
            'title'    => $r['title'],
            'username' => $r['username'],
            'email'    => $r['email'],
            'url'      => $r['url'],
            'password' => Crypto::decrypt($r['password_enc'] ?? ''),
            'notes'    => Crypto::decrypt($r['notes_enc'] ?? ''),
            'fields'   => is_array($fields) ? $fields : [],
            'updated_at' => $r['updated_at'] ?? null,
        ];
    }

    private static function encodeFields($fields): string
    {
        if (!is_array($fields)) return '[]';
        $out = [];
        foreach ($fields as $f) {
            if (!is_array($f)) continue;
            $label = trim((string)($f['label'] ?? ''));
            $value = (string)($f['value'] ?? '');
            if ($label === '' && $value === '') continue;
            $out[] = ['label' => mb_substr($label, 0, 120), 'value' => mb_substr($value, 0, 2000), 'secret' => !empty($f['secret'])];
        }
        return json_encode($out, JSON_UNESCAPED_UNICODE);
    }

    private static function str($v, int $max): ?string
    {
        if ($v === null) return null;
        $v = trim((string)$v);
        return $v === '' ? null : mb_substr($v, 0, $max);
    }
}
