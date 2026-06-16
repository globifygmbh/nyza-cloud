<?php
declare(strict_types=1);

namespace Nyza;

use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use Psr\Http\Message\ServerRequestInterface as Request;

final class Auth
{
    public static function secret(): string
    {
        $s = getenv('JWT_SECRET') ?: '';
        if (strlen($s) < 16) {
            throw new \RuntimeException('JWT_SECRET must be set and at least 16 chars');
        }
        return $s;
    }

    public static function issue(int $userId, string $email): string
    {
        $ttl = (int)(getenv('JWT_TTL') ?: 2592000);
        $now = time();
        $payload = [
            'sub' => $userId,
            'email' => $email,
            'iat' => $now,
            'exp' => $now + $ttl,
        ];
        return JWT::encode($payload, self::secret(), 'HS256');
    }

    /** Short-lived token that ONLY lets the holder complete the 2FA step. */
    public static function issuePending(int $userId, string $email): string
    {
        $now = time();
        return JWT::encode([
            'sub' => $userId, 'email' => $email, 'twofa' => 'pending',
            'iat' => $now, 'exp' => $now + 300,
        ], self::secret(), 'HS256');
    }

    /** Decoded sub of a pending-2FA token, or null. */
    public static function pendingUserId(string $token): ?int
    {
        $p = self::decode($token);
        return ($p && ($p['twofa'] ?? null) === 'pending' && isset($p['sub'])) ? (int)$p['sub'] : null;
    }

    public static function decode(string $token): ?array
    {
        try {
            $decoded = JWT::decode($token, new Key(self::secret(), 'HS256'));
            return (array) $decoded;
        } catch (\Throwable $e) {
            return null;
        }
    }

    public static function fromRequest(Request $req): ?array
    {
        // 1) Standard: Authorization: Bearer <jwt> header (used by fetch/XHR).
        $h = $req->getHeaderLine('Authorization');
        if (preg_match('/^Bearer\s+(.+)$/i', $h, $m)) {
            return self::decode($m[1]);
        }
        // 2) Fallback: ?token=<jwt> query param. <img>/<video>/<iframe> tags and
        //    direct download links can't set request headers, so media + raw
        //    file endpoints accept the JWT via query string. It's the same
        //    signed, short-lived token — acceptable for a single-user app served
        //    over HTTPS. (Tokens can land in server logs; rely on TLS + the
        //    30-day expiry, and never log query strings with secrets.)
        $qs = $req->getQueryParams();
        if (!empty($qs['token']) && is_string($qs['token'])) {
            return self::decode($qs['token']);
        }
        return null;
    }

    public static function userId(Request $req): ?int
    {
        $p = self::fromRequest($req);
        // A pending-2FA token must NOT authenticate normal API calls.
        if ($p && ($p['twofa'] ?? null) === 'pending') return null;
        return $p && isset($p['sub']) ? (int)$p['sub'] : null;
    }

    public static function randomToken(int $bytes = 24): string
    {
        // URL-safe base64 (no padding) — 24 bytes → 32 chars
        return rtrim(strtr(base64_encode(random_bytes($bytes)), '+/', '-_'), '=');
    }
}
