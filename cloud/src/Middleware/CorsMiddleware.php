<?php
declare(strict_types=1);

namespace Nyza\Middleware;

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as Handler;
use Slim\Psr7\Response as SlimResponse;

final class CorsMiddleware implements MiddlewareInterface
{
    public function process(Request $request, Handler $handler): Response
    {
        $origin = getenv('ALLOW_ORIGIN') ?: '*';

        // CORS preflight short-circuit — but NOT for WebDAV. Native WebDAV clients
        // (Finder, Windows Explorer, davfs2) probe with OPTIONS and read the `DAV`
        // capability header from the response. If we answered preflight here, that
        // header would never be emitted and the client would conclude the server
        // isn't a WebDAV server → "connection failed". Let /webdav OPTIONS fall
        // through to WebDavRoutes::options(), which advertises `DAV: 1, 2`.
        if (strtoupper($request->getMethod()) === 'OPTIONS' && !$this->isWebDav($request)) {
            $res = new SlimResponse();
            return $this->headers($res, $origin);
        }

        $response = $handler->handle($request);
        return $this->headers($response, $origin);
    }

    /** True when the request targets the WebDAV mount (with or without deploy base path). */
    private function isWebDav(Request $request): bool
    {
        $path = $request->getUri()->getPath();
        return (bool) preg_match('#(^|/)webdav(/|$)#', $path);
    }

    private function headers(Response $r, string $origin): Response
    {
        return $r
            ->withHeader('Access-Control-Allow-Origin', $origin)
            ->withHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
            ->withHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Upload-Session, X-Chunk-Index, X-Chunk-Total')
            ->withHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Upload-Session');
    }
}
