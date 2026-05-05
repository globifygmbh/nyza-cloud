<?php
declare(strict_types=1);

namespace Nyza\Middleware;

use Nyza\Auth;
use Nyza\Json;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as Handler;
use Slim\Psr7\Response as SlimResponse;

final class AuthMiddleware implements MiddlewareInterface
{
    public function process(Request $request, Handler $handler): Response
    {
        $uid = Auth::userId($request);
        if ($uid === null) {
            return Json::err(new SlimResponse(), 'Unauthorized', 401, 'unauthorized');
        }
        $request = $request->withAttribute('uid', $uid);
        return $handler->handle($request);
    }
}
