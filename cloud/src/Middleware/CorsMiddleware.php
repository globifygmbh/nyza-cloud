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

        if (strtoupper($request->getMethod()) === 'OPTIONS') {
            $res = new SlimResponse();
            return $this->headers($res, $origin);
        }

        $response = $handler->handle($request);
        return $this->headers($response, $origin);
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
