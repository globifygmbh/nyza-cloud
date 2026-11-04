<?php
declare(strict_types=1);

namespace Nyza\Routes;

use Nyza\CompanyContext;
use Nyza\Database;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;
use Slim\Psr7\Stream;

/**
 * Public AGB (terms) page per company: /agbs/{slug}. The text is the
 * agb_text field of the Firmenprofil; the slug is derived from the company
 * name the first time AGBs are saved (see ensureSlug) and then stays fixed so
 * links on invoices/websites keep working after a rename.
 *
 * Rendered server-side as a plain, light, printable page — no SPA, no login.
 */
final class AgbRoutes
{
    public static function mount(App $app): void
    {
        // Registered before the SPA catch-all in index.php.
        $app->get('/agbs/{slug}', [self::class, 'page']);
        $app->get('/agbs/{slug}/logo', [self::class, 'logo']);
    }

    /** The company's AGB slug, creating it from the name if missing. */
    public static function ensureSlug(int $companyId): ?string
    {
        $pdo = Database::pdo();
        $s = $pdo->prepare('SELECT name, agb_slug FROM companies WHERE id = ?');
        $s->execute([$companyId]);
        $row = $s->fetch();
        if (!$row) return null;
        if (!empty($row['agb_slug'])) return (string)$row['agb_slug'];

        $p = CompanyContext::profile($companyId);
        $name = trim((string)($p['brand_name'] ?? '')) ?: trim((string)($p['legal_name'] ?? '')) ?: (string)$row['name'];
        $base = self::slugify($name) ?: 'firma';
        $check = $pdo->prepare('SELECT 1 FROM companies WHERE agb_slug = ?');
        for ($i = 1; $i < 100; $i++) {
            $slug = $i === 1 ? $base : $base . '-' . $i;
            $check->execute([$slug]);
            if (!$check->fetchColumn()) {
                $pdo->prepare('UPDATE companies SET agb_slug = ? WHERE id = ? AND agb_slug IS NULL')->execute([$slug, $companyId]);
                break;
            }
        }
        $s->execute([$companyId]);
        $row = $s->fetch();
        return $row && !empty($row['agb_slug']) ? (string)$row['agb_slug'] : null;
    }

    public static function slugOf(int $companyId): ?string
    {
        $s = Database::pdo()->prepare('SELECT agb_slug FROM companies WHERE id = ?');
        $s->execute([$companyId]);
        $v = $s->fetchColumn();
        return $v ? (string)$v : null;
    }

    private static function slugify(string $s): string
    {
        $s = mb_strtolower($s);
        $s = strtr($s, ['ä' => 'ae', 'ö' => 'oe', 'ü' => 'ue', 'ß' => 'ss', '&' => ' und ']);
        if (function_exists('iconv')) {
            $t = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s);
            if ($t !== false) $s = $t;
        }
        $s = preg_replace('/[^a-z0-9]+/', '-', $s) ?? '';
        return substr(trim($s, '-'), 0, 60);
    }

    private static function companyBySlug(string $slug): ?int
    {
        if (!preg_match('/^[a-z0-9-]{1,80}$/', $slug)) return null;
        $s = Database::pdo()->prepare('SELECT id FROM companies WHERE agb_slug = ?');
        $s->execute([$slug]);
        $id = $s->fetchColumn();
        return $id ? (int)$id : null;
    }

    public static function logo(Request $req, Response $res, array $args): Response
    {
        $id = self::companyBySlug((string)$args['slug']);
        $abs = $id ? CompanyRoutes::logoFile($id) : null;
        if ($abs === null) return $res->withStatus(404);
        $mime = ['png' => 'image/png', 'jpg' => 'image/jpeg', 'webp' => 'image/webp', 'gif' => 'image/gif'][strtolower(pathinfo($abs, PATHINFO_EXTENSION))] ?? 'application/octet-stream';
        return $res
            ->withHeader('Content-Type', $mime)
            ->withHeader('Cache-Control', 'public, max-age=300')
            ->withHeader('X-Content-Type-Options', 'nosniff')
            ->withBody(new Stream(fopen($abs, 'rb')));
    }

    public static function page(Request $req, Response $res, array $args): Response
    {
        $slug = (string)$args['slug'];
        $id = self::companyBySlug($slug);
        $p = $id ? CompanyContext::profile($id) : [];
        $text = trim((string)($p['agb_text'] ?? ''));
        if (!$id || $text === '') {
            $res->getBody()->write(self::shell('Nicht gefunden', '<p class="muted">Für diesen Link sind keine AGB hinterlegt.</p>'));
            return $res->withStatus(404)->withHeader('Content-Type', 'text/html; charset=utf-8');
        }

        $e = static fn($v) => htmlspecialchars((string)$v, ENT_QUOTES, 'UTF-8');
        $name = trim((string)($p['legal_name'] ?? '')) ?: trim((string)($p['brand_name'] ?? ''));
        if ($name === '') {
            $s = Database::pdo()->prepare('SELECT name FROM companies WHERE id = ?');
            $s->execute([$id]);
            $name = (string)$s->fetchColumn();
        }
        $addr = implode(' · ', array_filter([
            $name,
            trim((string)($p['street'] ?? '')),
            trim(($p['zip'] ?? '') . ' ' . ($p['city'] ?? '')),
            trim((string)($p['country'] ?? '')),
        ]));
        $contact = implode(' · ', array_filter([
            trim((string)($p['email'] ?? '')),
            trim((string)($p['phone'] ?? '')),
            trim((string)($p['website'] ?? '')),
        ]));
        $logo = CompanyRoutes::logoFile($id) !== null
            ? '<img class="logo" src="' . $e(rawurlencode($slug)) . '/logo" alt="' . $e($name) . '">'
            : '';
        $body = '<header>' . $logo . '<div class="co">' . $e($name) . '</div></header>'
            . '<h1>Allgemeine Geschäftsbedingungen</h1>'
            . '<div class="agb">' . $e($text) . '</div>'
            . '<footer>' . $e($addr) . ($contact !== '' ? '<br>' . $e($contact) : '') . '</footer>';
        $res->getBody()->write(self::shell('AGB · ' . $name, $body));
        return $res
            ->withHeader('Content-Type', 'text/html; charset=utf-8')
            ->withHeader('Cache-Control', 'no-cache');
    }

    private static function shell(string $title, string $body): string
    {
        $t = htmlspecialchars($title, ENT_QUOTES, 'UTF-8');
        return <<<HTML
<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{$t}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #f4f4f6; color: #1a1a1f; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width: 760px; margin: 32px auto; background: #fff; padding: 40px 48px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap-reverse; margin-bottom: 28px; }
  .logo { max-height: 56px; max-width: 220px; object-fit: contain; }
  .co { font-weight: 600; color: #555; }
  h1 { font-size: 24px; line-height: 1.3; margin: 0 0 20px; }
  .agb { white-space: pre-wrap; overflow-wrap: anywhere; }
  footer { margin-top: 36px; padding-top: 16px; border-top: 1px solid #e6e6ea; font-size: 12.5px; color: #777; }
  .muted { color: #777; }
  @media (max-width: 600px) { main { margin: 0; border-radius: 0; padding: 24px 16px; box-shadow: none; } h1 { font-size: 20px; } }
  @media print { body { background: #fff; } main { margin: 0; padding: 0; box-shadow: none; max-width: none; } }
</style></head>
<body><main>{$body}</main></body></html>
HTML;
    }
}
