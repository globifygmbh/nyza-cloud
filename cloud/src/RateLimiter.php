<?php
declare(strict_types=1);

namespace Nyza;

use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Tiny file-based fixed-window rate limiter. No DB, no Redis — works on any
 * shared host. Each key gets a JSON counter file in storage/temp/rl/. Good
 * enough to blunt brute-force on login and abuse of public upload/share
 * endpoints; not a distributed limiter.
 */
final class RateLimiter
{
    private static function dir(): string
    {
        $d = Storage::temp() . '/rl';
        if (!is_dir($d)) @mkdir($d, 0775, true);
        return $d;
    }

    public static function clientIp(Request $req): string
    {
        $sp = $req->getServerParams();
        // Honour a single proxy hop if present; fall back to REMOTE_ADDR.
        foreach (['HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR'] as $k) {
            if (!empty($sp[$k])) {
                $ip = trim(explode(',', (string) $sp[$k])[0]);
                if ($ip !== '') return $ip;
            }
        }
        return 'unknown';
    }

    /**
     * Returns true if the action is allowed (and records a hit), false if the
     * caller has exceeded $max hits within $windowSeconds.
     */
    public static function allow(string $key, int $max, int $windowSeconds): bool
    {
        $file = self::dir() . '/' . hash('sha256', $key) . '.json';
        $now = time();
        $fp = @fopen($file, 'c+');
        if (!$fp) return true; // fail-open: never lock users out on FS error
        @flock($fp, LOCK_EX);
        $raw = stream_get_contents($fp);
        $data = json_decode((string) $raw, true);
        if (!is_array($data) || ($data['start'] ?? 0) + $windowSeconds < $now) {
            $data = ['start' => $now, 'count' => 0];
        }
        $data['count']++;
        $allowed = $data['count'] <= $max;
        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, json_encode($data));
        @flock($fp, LOCK_UN);
        fclose($fp);
        return $allowed;
    }

    /** Convenience: build a key from an action name + the request IP. */
    public static function allowReq(Request $req, string $action, int $max, int $windowSeconds, string $extra = ''): bool
    {
        return self::allow($action . ':' . self::clientIp($req) . ($extra !== '' ? ':' . $extra : ''), $max, $windowSeconds);
    }
}
