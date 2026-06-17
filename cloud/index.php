<?php
declare(strict_types=1);

/**
 * Nyza Cloud — Entry Point
 *
 * Apache/.htaccess routed alle Requests hierher. Dieser File:
 *  - lädt config.php
 *  - mountet die Slim-API unter /api/...
 *  - serviert die gebaute Frontend-SPA (assets/index.html) für alles andere
 */

require __DIR__ . '/vendor/autoload.php';

use Nyza\Config;
use Nyza\Json;
use Nyza\Middleware\CorsMiddleware;
use Nyza\Routes\ActivityRoutes;
use Nyza\Routes\AuthRoutes;
use Nyza\Routes\ContactRoutes;
use Nyza\Routes\DocumentRoutes;
use Nyza\Routes\ExpenseRoutes;
use Nyza\Routes\FileRoutes;
use Nyza\Routes\FolderRoutes;
use Nyza\Routes\ImportRoutes;
use Nyza\Routes\LedgerRoutes;
use Nyza\Routes\ProductRoutes;
use Nyza\Routes\ReminderRoutes;
use Nyza\Routes\ReportRoutes;
use Nyza\Routes\RoadmapRoutes;
use Nyza\Routes\SettingsRoutes;
use Nyza\Routes\ShareRoutes;
use Nyza\Routes\SubscriptionRoutes;
use Nyza\Routes\TaskRoutes;
use Nyza\Routes\TimeRoutes;
use Nyza\Routes\UploadLinkRoutes;
use Nyza\Routes\WebDavRoutes;
use Nyza\SetupWizard;
use Slim\Factory\AppFactory;

// `?setup=1` lets you re-run the wizard for diagnostics even after config.php
// exists. The wizard handles its own routing (?step=...) and exits when done.
if (isset($_GET['setup'])) {
    (new SetupWizard(__DIR__))->handle();
    exit;
}

Config::load(__DIR__ . '/config.php');

// `?update=1` → in-app updater (pulls latest from GitHub). Admin-token gated
// inside Updater. Runs after Config::load so the DB is available for the check.
if (isset($_GET['update'])) {
    (new \Nyza\Updater(__DIR__))->handle();
    exit;
}

// Ist dieser Subfolder unter /www/nyza/ deployed? Slim braucht den base path.
// Wir leiten ihn aus SCRIPT_NAME ab — das ist '/nyza/index.php' wenn der
// Ordner 'nyza' heißt, oder '/index.php' wenn direkt im Webroot.
$scriptName = $_SERVER['SCRIPT_NAME'] ?? '/index.php';
$basePath   = rtrim(str_replace('\\', '/', dirname($scriptName)), '/');

$app = AppFactory::create();
if ($basePath !== '' && $basePath !== '/') {
    $app->setBasePath($basePath);
}
$app->addBodyParsingMiddleware();

$assetsRoot = realpath(__DIR__ . '/assets');

/**
 * Serve the SPA shell. Two transformations:
 *  1. Asset URL rewrite: Vite emits relative URLs like `./app-X.js` because
 *     it doesn't know the deploy path at build time. We rewrite them to
 *     `<basePath>/assets/app-X.js` so they resolve correctly from any
 *     client-side route (e.g. /cloud/s/<token> would otherwise turn
 *     `./app.js` into `/cloud/s/app.js` → 404). Apache then serves the
 *     hashed files directly without going through PHP.
 *  2. window.NYZA_BASE — exposed to JS so the API client and router can
 *     prepend the deploy prefix to fetch paths and route matchers.
 */
$serveSpa = function ($res) use ($assetsRoot, $basePath) {
    $html = (string) file_get_contents($assetsRoot . '/index.html');
    $assetPrefix = ($basePath === '' || $basePath === '/') ? '/assets/' : $basePath . '/assets/';
    $html = preg_replace(
        '#(["\'])\./(app-|style-|chunk-|[\w-]+-[0-9a-f]{8})#',
        '$1' . $assetPrefix . '$2',
        $html
    );
    // PWA links are relative in the template; anchor them to the deploy root so
    // they resolve on deep client-side routes too (/cloud/s/<token> etc.).
    $root = ($basePath === '' || $basePath === '/') ? '/' : $basePath . '/';
    $html = str_replace('href="manifest.webmanifest"', 'href="' . $root . 'manifest.webmanifest"', $html);
    $html = str_replace('href="icon.svg"', 'href="' . $root . 'icon.svg"', $html);

    $hint = '<script>window.NYZA_BASE=' . json_encode($basePath ?: '') . ';</script>';
    $html = preg_replace('/<head([^>]*)>/i', '<head$1>' . $hint, $html, 1);
    $res->getBody()->write($html);
    return $res->withHeader('Content-Type', 'text/html; charset=utf-8');
};

$app->get('/', function ($req, $res) use ($assetsRoot, $serveSpa) {
    if ($assetsRoot && file_exists($assetsRoot . '/index.html')) {
        return $serveSpa($res);
    }
    return Json::ok($res, ['name' => 'Nyza Cloud API', 'version' => '1.0', 'note' => 'Frontend assets/ noch nicht gebaut.']);
});

$app->get('/healthz', fn($req, $res) => Json::ok($res, ['ok' => true]));

// ───── PWA: manifest, icon, service worker (base-path aware) ────────────────
$pwaBase = ($basePath === '' || $basePath === '/') ? '' : $basePath;

$app->get('/manifest.webmanifest', function ($req, $res) use ($pwaBase) {
    $manifest = [
        'name' => 'Nyza Cloud',
        'short_name' => 'Nyza',
        'start_url' => ($pwaBase ?: '') . '/',
        'scope' => ($pwaBase ?: '') . '/',
        'display' => 'standalone',
        'background_color' => '#0B0B0F',
        'theme_color' => '#0B0B0F',
        'description' => 'Premium Cloud-Storage mit Upload-Links.',
        'icons' => [
            ['src' => ($pwaBase ?: '') . '/icon.svg', 'sizes' => 'any', 'type' => 'image/svg+xml', 'purpose' => 'any maskable'],
        ],
    ];
    $res->getBody()->write(json_encode($manifest, JSON_UNESCAPED_SLASHES));
    return $res->withHeader('Content-Type', 'application/manifest+json; charset=utf-8');
});

$app->get('/icon.svg', function ($req, $res) {
    $svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'>"
         . "<defs><linearGradient id='g' x1='0' x2='1' y1='0' y2='1'>"
         . "<stop offset='0' stop-color='#7C5CFF'/><stop offset='1' stop-color='#3B82F6'/></linearGradient></defs>"
         . "<rect width='512' height='512' rx='112' fill='url(#g)'/>"
         . "<path d='M150 368V144l212 224V144' stroke='white' stroke-width='44' stroke-linecap='round' stroke-linejoin='round' fill='none'/></svg>";
    $res->getBody()->write($svg);
    return $res->withHeader('Content-Type', 'image/svg+xml')->withHeader('Cache-Control', 'public, max-age=86400');
});

$app->get('/sw.js', function ($req, $res) use ($pwaBase) {
    // Network-first service worker. Never serves a stale app shell while online;
    // falls back to cache only when offline. API + media are always network-only.
    $scope = ($pwaBase ?: '') . '/';
    $js = <<<JS
const CACHE = 'nyza-v4';
const SCOPE = '{$scope}';
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.indexOf('/api/') !== -1) return; // never cache API/media
  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.status === 200) {
        const c = await caches.open(CACHE);
        c.put(req, fresh.clone());
      }
      return fresh;
    } catch (err) {
      const cached = await caches.match(req);
      if (cached) return cached;
      // offline navigation → fall back to app shell
      if (req.mode === 'navigate') {
        const shell = await caches.match(SCOPE);
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
JS;
    $res->getBody()->write($js);
    return $res
        ->withHeader('Content-Type', 'text/javascript; charset=utf-8')
        ->withHeader('Service-Worker-Allowed', $scope)
        ->withHeader('Cache-Control', 'no-cache');
});

AuthRoutes::mount($app);
FolderRoutes::mount($app);
FileRoutes::mount($app);
ShareRoutes::mount($app);
UploadLinkRoutes::mount($app);
ActivityRoutes::mount($app);
TaskRoutes::mount($app);
ContactRoutes::mount($app);
ProductRoutes::mount($app);
DocumentRoutes::mount($app);
ExpenseRoutes::mount($app);
SubscriptionRoutes::mount($app);
TimeRoutes::mount($app);
RoadmapRoutes::mount($app);
ReportRoutes::mount($app);
ReminderRoutes::mount($app);
ImportRoutes::mount($app);
LedgerRoutes::mount($app);
SettingsRoutes::mount($app);
WebDavRoutes::mount($app);

/** Asset / SPA fallback for all non-API GETs. */
$app->get('/{path:.+}', function ($req, $res, $args) use ($assetsRoot, $serveSpa) {
    $path = $args['path'];
    if (str_starts_with($path, 'api/')) {
        return Json::err($res, 'Not found', 404);
    }
    if ($assetsRoot) {
        $candidate = realpath($assetsRoot . '/' . $path);
        if ($candidate && str_starts_with($candidate, $assetsRoot) && is_file($candidate)) {
            $mime = match (strtolower(pathinfo($candidate, PATHINFO_EXTENSION))) {
                'html'        => 'text/html; charset=utf-8',
                'css'         => 'text/css; charset=utf-8',
                'js', 'mjs'   => 'text/javascript; charset=utf-8',
                'json'        => 'application/json; charset=utf-8',
                'svg'         => 'image/svg+xml',
                'png'         => 'image/png',
                'jpg', 'jpeg' => 'image/jpeg',
                'webp'        => 'image/webp',
                'avif'        => 'image/avif',
                'ico'         => 'image/x-icon',
                'woff'        => 'font/woff',
                'woff2'       => 'font/woff2',
                'map'         => 'application/json',
                default       => 'application/octet-stream',
            };
            $res->getBody()->write((string) file_get_contents($candidate));
            // Long-cache hashed assets — Vite emits content-hashed filenames in /assets/
            if (preg_match('/[.-][0-9a-f]{8,}\.[a-z0-9]+$/i', $path)) {
                $res = $res->withHeader('Cache-Control', 'public, max-age=31536000, immutable');
            }
            return $res->withHeader('Content-Type', $mime);
        }
        // SPA fallback for client-side routes (/s/<token>, /u/<token>, etc).
        if (file_exists($assetsRoot . '/index.html')) {
            return $serveSpa($res);
        }
    }
    return Json::err($res, 'Not found', 404);
});

$app->add(new CorsMiddleware());

$debug = (bool) getenv('APP_DEBUG');
$err = $app->addErrorMiddleware($debug, true, true);
$err->setDefaultErrorHandler(function ($req, $exception, $displayDetails) {
    $res = new \Slim\Psr7\Response();
    $status = method_exists($exception, 'getCode') && $exception->getCode() >= 400 && $exception->getCode() < 600
        ? $exception->getCode() : 500;
    if ($exception instanceof \Slim\Exception\HttpNotFoundException) $status = 404;
    if ($exception instanceof \Slim\Exception\HttpMethodNotAllowedException) $status = 405;
    return Json::err($res, $displayDetails ? $exception->getMessage() : 'Server error', $status);
});

$app->run();
