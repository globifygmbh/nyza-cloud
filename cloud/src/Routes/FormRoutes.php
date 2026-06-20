<?php
declare(strict_types=1);

namespace Nyza\Routes;

use Nyza\CompanyContext;
use Nyza\Database;
use Nyza\Json;
use Nyza\Storage;
use Nyza\Middleware\AuthMiddleware;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;
use Slim\Psr7\Stream;
use Slim\Routing\RouteCollectorProxy;

/**
 * Custom intake forms. The owner designs fields (text/email/number/name/date/
 * select/checkbox/textarea/file); the public form at /f/<token> collects
 * submissions (multipart, so file fields work). Answers are stored as JSON,
 * uploaded files in form_files for later review/download.
 */
final class FormRoutes
{
    private const TYPES = ['text', 'textarea', 'email', 'number', 'name', 'date', 'select', 'checkbox', 'file'];
    private const FILE_MAX = 20 * 1024 * 1024;

    public static function mount(App $app): void
    {
        $app->group('/api/forms', function (RouteCollectorProxy $g) {
            $g->get('',                 [self::class, 'list']);
            $g->post('',                [self::class, 'create']);
            $g->get('/{id}',            [self::class, 'show']);
            $g->patch('/{id}',          [self::class, 'update']);
            $g->delete('/{id}',         [self::class, 'delete']);
            $g->get('/{id}/submissions',[self::class, 'submissions']);
            $g->get('/files/{fid}',     [self::class, 'downloadFile']);
        })->add(new AuthMiddleware());

        // Public — the form respondent.
        $app->get('/api/form/{token}',  [self::class, 'publicForm']);
        $app->post('/api/form/{token}', [self::class, 'submit']);
    }

    public static function list(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $s = Database::pdo()->prepare(
            'SELECT f.*, (SELECT COUNT(*) FROM form_submissions s WHERE s.form_id = f.id) AS subs
             FROM forms f WHERE f.user_id = ? ORDER BY f.created_at DESC LIMIT 200'
        );
        $s->execute([$uid]);
        return Json::ok($res, ['forms' => array_map([self::class, 'shape'], $s->fetchAll())]);
    }

    public static function create(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $cid = CompanyContext::active($req, $uid);
        $b = (array)$req->getParsedBody();
        $title = trim((string)($b['title'] ?? ''));
        if ($title === '') $title = 'Neues Formular';
        $token = bin2hex(random_bytes(16));
        Database::pdo()->prepare(
            'INSERT INTO forms (user_id, company_id, title, description, fields, token, active) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )->execute([
            $uid, $cid, mb_substr($title, 0, 255), self::str($b['description'] ?? null, 4000),
            self::encodeFields($b['fields'] ?? []), $token, !empty($b['active']) || !isset($b['active']) ? 1 : 0,
        ]);
        return Json::ok($res, ['form' => self::shape(self::fetchOwned($uid, (int)Database::pdo()->lastInsertId()))], 201);
    }

    public static function show(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $f = self::fetchOwned($uid, (int)$args['id']);
        if (!$f) return Json::err($res, 'Not found', 404);
        return Json::ok($res, ['form' => self::shape($f)]);
    }

    public static function update(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchOwned($uid, $id)) return Json::err($res, 'Not found', 404);
        $b = (array)$req->getParsedBody();
        $sets = []; $vals = [];
        if (array_key_exists('title', $b)) { $sets[] = 'title = ?'; $vals[] = mb_substr(trim((string)$b['title']) ?: 'Formular', 0, 255); }
        if (array_key_exists('description', $b)) { $sets[] = 'description = ?'; $vals[] = self::str($b['description'], 4000); }
        if (array_key_exists('fields', $b)) { $sets[] = 'fields = ?'; $vals[] = self::encodeFields($b['fields']); }
        if (array_key_exists('active', $b)) { $sets[] = 'active = ?'; $vals[] = !empty($b['active']) ? 1 : 0; }
        if (!$sets) return Json::err($res, 'Nichts zu ändern', 422);
        $vals[] = $id; $vals[] = $uid;
        Database::pdo()->prepare('UPDATE forms SET ' . implode(', ', $sets) . ' WHERE id = ? AND user_id = ?')->execute($vals);
        return Json::ok($res, ['form' => self::shape(self::fetchOwned($uid, $id))]);
    }

    public static function delete(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        $f = self::fetchOwned($uid, $id);
        if (!$f) return Json::err($res, 'Not found', 404);
        // Remove stored attachment blobs before the rows cascade away.
        $ff = Database::pdo()->prepare('SELECT storage_path FROM form_files ff JOIN form_submissions s ON s.id = ff.submission_id WHERE s.form_id = ?');
        $ff->execute([$id]);
        foreach ($ff->fetchAll() as $r) Storage::deleteRel($r['storage_path']);
        Database::pdo()->prepare('DELETE FROM forms WHERE id = ? AND user_id = ?')->execute([$id, $uid]);
        return Json::ok($res, ['ok' => true]);
    }

    public static function submissions(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $id = (int)$args['id'];
        if (!self::fetchOwned($uid, $id)) return Json::err($res, 'Not found', 404);
        $s = Database::pdo()->prepare('SELECT * FROM form_submissions WHERE form_id = ? ORDER BY created_at DESC LIMIT 1000');
        $s->execute([$id]);
        $subs = $s->fetchAll();
        $fileStmt = Database::pdo()->prepare('SELECT id, field_key, name, mime, size FROM form_files WHERE submission_id = ?');
        $out = [];
        foreach ($subs as $sub) {
            $fileStmt->execute([(int)$sub['id']]);
            $out[] = [
                'id'         => (int)$sub['id'],
                'data'       => json_decode((string)$sub['data'], true) ?: [],
                'created_at' => $sub['created_at'],
                'files'      => array_map(static fn($f) => [
                    'id' => (int)$f['id'], 'field_key' => $f['field_key'], 'name' => $f['name'], 'mime' => $f['mime'], 'size' => (int)$f['size'],
                ], $fileStmt->fetchAll()),
            ];
        }
        return Json::ok($res, ['submissions' => $out]);
    }

    public static function downloadFile(Request $req, Response $res, array $args): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $s = Database::pdo()->prepare(
            'SELECT ff.* FROM form_files ff
             JOIN form_submissions s ON s.id = ff.submission_id
             JOIN forms f ON f.id = s.form_id
             WHERE ff.id = ? AND f.user_id = ?'
        );
        $s->execute([(int)$args['fid'], $uid]);
        $f = $s->fetch();
        if (!$f) return Json::err($res, 'Not found', 404);
        $abs = Storage::abs($f['storage_path']);
        if (!is_file($abs)) return Json::err($res, 'Not found', 404);
        $download = !empty($req->getQueryParams()['download']);
        return $res
            ->withHeader('Content-Type', $f['mime'] ?: 'application/octet-stream')
            ->withHeader('Content-Disposition', ($download ? 'attachment' : 'inline') . '; filename="' . addslashes((string)$f['name']) . '"')
            ->withHeader('X-Content-Type-Options', 'nosniff')
            ->withBody(new Stream(fopen($abs, 'rb')))
            ->withStatus(200);
    }

    // ───── public ─────────────────────────────────────────────────────────────
    public static function publicForm(Request $req, Response $res, array $args): Response
    {
        $f = self::byToken((string)$args['token']);
        if (!$f || (int)$f['active'] !== 1) return Json::err($res, 'Formular nicht verfügbar', 404);
        return Json::ok($res, ['form' => [
            'title'       => $f['title'],
            'description' => $f['description'],
            'fields'      => json_decode((string)$f['fields'], true) ?: [],
        ]]);
    }

    public static function submit(Request $req, Response $res, array $args): Response
    {
        $f = self::byToken((string)$args['token']);
        if (!$f || (int)$f['active'] !== 1) return Json::err($res, 'Formular nicht verfügbar', 404);
        $fields = json_decode((string)$f['fields'], true) ?: [];
        $body = (array)$req->getParsedBody();
        $uploads = $req->getUploadedFiles();

        $data = [];
        foreach ($fields as $fld) {
            $key = (string)($fld['key'] ?? '');
            if ($key === '' || ($fld['type'] ?? '') === 'file') continue;
            $v = $body['field_' . $key] ?? null;
            if (is_array($v)) $v = implode(', ', array_map('strval', $v));
            $v = $v === null ? '' : trim((string)$v);
            if (!empty($fld['required']) && $v === '') return Json::err($res, 'Bitte alle Pflichtfelder ausfüllen', 422);
            $data[$key] = mb_substr($v, 0, 5000);
        }

        $pdo = Database::pdo();
        $pdo->prepare('INSERT INTO form_submissions (form_id, data, ip) VALUES (?, ?, ?)')
            ->execute([(int)$f['id'], json_encode($data, JSON_UNESCAPED_UNICODE), self::clientIp($req)]);
        $subId = (int)$pdo->lastInsertId();

        // File fields.
        foreach ($fields as $fld) {
            if (($fld['type'] ?? '') !== 'file') continue;
            $key = (string)($fld['key'] ?? '');
            $file = $uploads['field_' . $key] ?? null;
            if (is_array($file)) $file = $file[0] ?? null;
            if (!$file || $file->getError() !== UPLOAD_ERR_OK) {
                if (!empty($fld['required'])) return Json::err($res, 'Datei erforderlich: ' . ($fld['label'] ?? $key), 422);
                continue;
            }
            if ((int)$file->getSize() > self::FILE_MAX) return Json::err($res, 'Datei zu groß (max 20 MB)', 413);
            $name = $file->getClientFilename() ?: 'upload.bin';
            $mime = $file->getClientMediaType() ?: 'application/octet-stream';
            $rel = Storage::relPath((int)$f['user_id'], $name);
            $file->moveTo(Storage::abs($rel));
            $pdo->prepare('INSERT INTO form_files (submission_id, field_key, name, storage_path, mime, size) VALUES (?, ?, ?, ?, ?, ?)')
                ->execute([$subId, $key, mb_substr($name, 0, 255), $rel, mb_substr($mime, 0, 100), (int)$file->getSize()]);
        }

        return Json::ok($res, ['ok' => true], 201);
    }

    // ───── helpers ─────────────────────────────────────────────────────────────
    private static function encodeFields($fields): string
    {
        if (!is_array($fields)) return '[]';
        $out = [];
        foreach ($fields as $f) {
            if (!is_array($f)) continue;
            $type = in_array($f['type'] ?? '', self::TYPES, true) ? $f['type'] : 'text';
            $key = preg_replace('/[^a-z0-9_]/', '', strtolower((string)($f['key'] ?? ''))) ?: ('f' . substr(md5((string)mt_rand()), 0, 6));
            $opts = [];
            if ($type === 'select' && is_array($f['options'] ?? null)) {
                foreach ($f['options'] as $o) { $o = trim((string)$o); if ($o !== '') $opts[] = mb_substr($o, 0, 120); }
            }
            $out[] = [
                'key' => mb_substr($key, 0, 40),
                'type' => $type,
                'label' => mb_substr(trim((string)($f['label'] ?? 'Feld')), 0, 160) ?: 'Feld',
                'required' => !empty($f['required']),
                'placeholder' => mb_substr(trim((string)($f['placeholder'] ?? '')), 0, 160),
                'options' => $opts,
            ];
        }
        return json_encode($out, JSON_UNESCAPED_UNICODE);
    }

    private static function byToken(string $token): ?array
    {
        $s = Database::pdo()->prepare('SELECT * FROM forms WHERE token = ? LIMIT 1');
        $s->execute([$token]);
        return $s->fetch() ?: null;
    }

    private static function fetchOwned(int $uid, int $id): array
    {
        $s = Database::pdo()->prepare(
            'SELECT f.*, (SELECT COUNT(*) FROM form_submissions s WHERE s.form_id = f.id) AS subs FROM forms f WHERE f.id = ? AND f.user_id = ?'
        );
        $s->execute([$id, $uid]);
        return $s->fetch() ?: [];
    }

    private static function shape(array $r): array
    {
        return [
            'id'          => (int)$r['id'],
            'title'       => $r['title'],
            'description' => $r['description'],
            'fields'      => json_decode((string)($r['fields'] ?? '[]'), true) ?: [],
            'token'       => $r['token'],
            'active'      => (int)$r['active'],
            'submissions' => (int)($r['subs'] ?? 0),
            'created_at'  => $r['created_at'] ?? null,
        ];
    }

    private static function str($v, int $max): ?string
    {
        if ($v === null) return null;
        $v = trim((string)$v);
        return $v === '' ? null : mb_substr($v, 0, $max);
    }

    private static function clientIp(Request $req): string
    {
        $h = $req->getHeaderLine('X-Forwarded-For');
        if ($h !== '') return trim(explode(',', $h)[0]);
        return (string)(($req->getServerParams())['REMOTE_ADDR'] ?? '');
    }
}
