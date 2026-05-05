<?php
declare(strict_types=1);

namespace Nyza;

use Psr\Http\Message\ResponseInterface as Response;

final class Json
{
    public static function ok(Response $res, $data, int $status = 200): Response
    {
        $res->getBody()->write(json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        return $res
            ->withHeader('Content-Type', 'application/json; charset=utf-8')
            ->withStatus($status);
    }

    public static function err(Response $res, string $message, int $status = 400, ?string $code = null): Response
    {
        return self::ok($res, [
            'error' => $message,
            'code' => $code ?? 'error',
        ], $status);
    }
}
