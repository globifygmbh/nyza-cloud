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
 * One-off contacts import from the same legacy export family (semicolon-CSV,
 * fixed SevDesk column layout) as the Rechnungen/Belege import. Every imported
 * row is marked as a customer (is_customer = 1) regardless of the source's
 * own "Kategorie" column — the explicit ask was "alle Importe als Kunde
 * markieren". Contacts are a shared, un-company-scoped workspace already, so
 * this mirrors that (no company_id involved).
 */
final class ContactImportRoutes
{
    private const MAX_ROWS = 20000;

    public static function mount(App $app): void
    {
        $app->group('/api/import/contacts', function (RouteCollectorProxy $g) {
            $g->post('/preview', [self::class, 'preview']);
            $g->post('/commit',  [self::class, 'commit']);
            $g->delete('',       [self::class, 'wipe']);
        })->add(new AuthMiddleware());
    }

    public static function preview(Request $req, Response $res): Response
    {
        $rows = self::readCsv($req, $res);
        if ($rows instanceof Response) return $rows;
        [$records, $warnings] = self::parseRows($rows);
        return Json::ok($res, self::summary($records, $warnings));
    }

    public static function commit(Request $req, Response $res): Response
    {
        $uid = (int)$req->getAttribute('uid');
        $rows = self::readCsv($req, $res);
        if ($rows instanceof Response) return $rows;
        [$records, $warnings] = self::parseRows($rows);
        if (!$records) return Json::err($res, 'Keine gültigen Zeilen gefunden', 422);

        $pdo = Database::pdo();
        $exists = $pdo->prepare('SELECT 1 FROM contacts WHERE LOWER(name) = LOWER(?)');
        $ins = $pdo->prepare(
            'INSERT INTO contacts (user_id, kind, name, contact_person, email, phone, street, zip, city, country, vat_id, is_customer, notes) '
            . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)'
        );

        $imported = 0; $skipped = 0;
        $pdo->beginTransaction();
        try {
            foreach ($records as $r) {
                $exists->execute([$r['name']]);
                if ($exists->fetch()) { $skipped++; continue; }
                $ins->execute([
                    $uid, $r['kind'], $r['name'], $r['contact_person'], $r['email'], $r['phone'],
                    $r['street'], $r['zip'], $r['city'], $r['country'], $r['vat_id'], $r['notes'],
                ]);
                $imported++;
            }
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            return Json::err($res, 'Import fehlgeschlagen: ' . $e->getMessage(), 500);
        }
        return Json::ok($res, ['imported' => $imported, 'skipped' => $skipped, 'warnings' => $warnings], 201);
    }

    /** Deletes every contact — for starting a legacy import over from scratch. */
    public static function wipe(Request $req, Response $res): Response
    {
        $pdo = Database::pdo();
        $n = $pdo->query('DELETE FROM contacts');
        $deleted = $n->rowCount();
        return Json::ok($res, ['deleted' => $deleted]);
    }

    private static function parseRows(array $rows): array
    {
        $records = []; $warnings = []; $seen = [];
        foreach ($rows as $i => $row) {
            $line = $i + 2;
            $org = trim((string)($row[5] ?? ''));
            $nachname = trim((string)($row[3] ?? ''));
            $vorname = trim((string)($row[4] ?? ''));
            $person = trim($vorname . ' ' . $nachname);

            $name = $org !== '' ? $org : $person;
            if ($name === '') { $warnings[] = "Zeile $line: kein Name (weder Organisation noch Vor-/Nachname), übersprungen"; continue; }

            $kind = $org !== '' ? 'company' : 'person';
            $contactPerson = ($org !== '' && $person !== '') ? $person : null;

            $key = mb_strtolower($name);
            if (isset($seen[$key])) $warnings[] = "Zeile $line: \"$name\" kommt in der Datei mehrfach vor";
            $seen[$key] = true;

            $records[] = [
                'kind' => $kind, 'name' => mb_substr($name, 0, 255),
                'contact_person' => $contactPerson ? mb_substr($contactPerson, 0, 255) : null,
                'email' => self::str($row[21] ?? '', 255),
                'phone' => self::str($row[17] ?? '', 64) ?: self::str($row[19] ?? '', 64),
                'street' => self::str($row[12] ?? '', 255),
                'zip' => self::str($row[13] ?? '', 32),
                'city' => self::str($row[14] ?? '', 128),
                'country' => self::str($row[15] ?? '', 128),
                'vat_id' => self::str($row[11] ?? '', 64),
                'notes' => self::str(strip_tags((string)($row[25] ?? '')), 2000),
            ];
        }
        return [$records, $warnings];
    }

    private static function summary(array $records, array $warnings): array
    {
        $pdo = Database::pdo();
        $existing = 0;
        $exists = $pdo->prepare('SELECT 1 FROM contacts WHERE LOWER(name) = LOWER(?)');
        foreach ($records as $r) {
            $exists->execute([$r['name']]);
            if ($exists->fetch()) $existing++;
        }
        $companies = count(array_filter($records, static fn($r) => $r['kind'] === 'company'));
        return [
            'count' => count($records), 'new' => count($records) - $existing, 'existing' => $existing,
            'companies' => $companies, 'persons' => count($records) - $companies,
            'sample' => array_slice($records, 0, 8), 'warnings' => $warnings,
        ];
    }

    /** @return array<int,array<int,string>>|Response */
    private static function readCsv(Request $req, Response $res)
    {
        $file = $req->getUploadedFiles()['file'] ?? null;
        if (!$file || $file->getError() !== UPLOAD_ERR_OK) return Json::err($res, 'Keine Datei', 422);
        $content = (string)$file->getStream()->getContents();
        if ($content === '') return Json::err($res, 'Datei leer', 422);
        $content = preg_replace('/^\xEF\xBB\xBF/', '', $content);
        if (!mb_check_encoding($content, 'UTF-8')) {
            $content = mb_convert_encoding($content, 'UTF-8', 'Windows-1252');
        }
        $fh = fopen('php://temp', 'r+');
        fwrite($fh, $content);
        rewind($fh);
        $rows = [];
        fgetcsv($fh, 0, ';'); // discard column header row
        while (($r = fgetcsv($fh, 0, ';')) !== false) {
            if (count($r) === 1 && ($r[0] === null || $r[0] === '')) continue;
            $rows[] = array_map(static fn($c) => $c === null ? '' : trim((string)$c), $r);
            if (count($rows) > self::MAX_ROWS) break;
        }
        fclose($fh);
        return $rows;
    }

    private static function str($v, int $max): ?string
    {
        $v = trim((string)$v);
        return $v === '' ? null : mb_substr($v, 0, $max);
    }
}
