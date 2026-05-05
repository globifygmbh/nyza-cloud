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
use Nyza\Routes\FileRoutes;
use Nyza\Routes\FolderRoutes;
use Nyza\Routes\ShareRoutes;
use Nyza\Routes\UploadLinkRoutes;
use Nyza\SetupWizard;
use Slim\Factory\AppFactory;

// `?setup=1` lets you re-run the wizard for diagnostics even after config.php
// exists. The wizard handles its own routing (?step=...) and exits when done.
if (isset($_GET['setup'])) {
    (new SetupWizard(__DIR__))->handle();
    exit;
}

Config::load(__DIR__ . '/config.php');

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

AuthRoutes::mount($app);
FolderRoutes::mount($app);
FileRoutes::mount($app);
ShareRoutes::mount($app);
UploadLinkRoutes::mount($app);
ActivityRoutes::mount($app);

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
