<?php
declare(strict_types=1);

namespace Nyza;

/**
 * Hands audio/video playback to Apache instead of streaming it through PHP.
 *
 * Why: on the production host every PHP response loses its Content-Length
 * and goes out chunked (static files keep theirs). Chrome copes; Safari
 * refuses to play a 206 range response without a length — the player stays
 * black and frames drawn from it come out black. Apache serves static files
 * with proper lengths and native Range support, so after PHP has done the
 * access check we redirect the browser to a static copy of the file.
 *
 * The "copy" is a hard link (no extra disk space; falls back to a symlink)
 * in media/ under an unguessable name: HMAC of the file + a day bucket. The
 * day is part of the name, links older than yesterday are swept, so a URL
 * stops working after one to two days. Returns null whenever this can't be
 * done (no secret, links not permitted, …) and the caller streams as before.
 */
final class MediaLink
{
    private const DIR = 'media';
    private const EXT = ['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv', 'mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'weba'];

    /** Public URL (relative to the install's base path) or null. */
    public static function url(array $file, string $abs): ?string
    {
        $secret = (string)(getenv('JWT_SECRET') ?: '');
        if (strlen($secret) < 16) return null;

        $ext = strtolower(pathinfo((string)$file['name'], PATHINFO_EXTENSION));
        if (!in_array($ext, self::EXT, true)) {
            $ext = str_starts_with((string)$file['mime_type'], 'audio/') ? 'm4a' : 'mp4';
        }

        $dir = dirname(__DIR__) . '/' . self::DIR;
        if (!is_dir($dir) && !@mkdir($dir, 0775, true)) return null;
        self::guard($dir);

        $day = (int) floor(time() / 86400);
        $mac = hash_hmac('sha256', (int)$file['id'] . '|' . $file['storage_path'] . '|' . @filemtime($abs) . '|' . $day, $secret);
        $name = $day . '-' . substr($mac, 0, 40) . '.' . $ext;
        $path = $dir . '/' . $name;

        if (!is_file($path)) {
            if (!@link($abs, $path) && !@symlink($abs, $path)) return null;
            if (random_int(1, 20) === 1) self::sweep($dir, $day);
        }

        $script = (string)($_SERVER['SCRIPT_NAME'] ?? '/index.php');
        $base = rtrim(str_replace('\\', '/', dirname($script)), '/');
        return $base . '/' . self::DIR . '/' . $name;
    }

    /** Drop links from before yesterday. */
    private static function sweep(string $dir, int $today): void
    {
        foreach (glob($dir . '/*-*.*') ?: [] as $p) {
            $d = (int) strtok(basename($p), '-');
            if ($d > 0 && $d < $today - 1) @unlink($p);
        }
    }

    /** No listing, nothing executable — only the media files themselves. */
    private static function guard(string $dir): void
    {
        $ht = $dir . '/.htaccess';
        if (is_file($ht)) return;
        @file_put_contents($ht, "Options -Indexes\n"
            . "<FilesMatch \"\\.(?i:php\\d?|phtml|phar|cgi|pl|py|sh)$\">\n  Require all denied\n</FilesMatch>\n"
            . "<IfModule mod_headers.c>\n  Header set X-Content-Type-Options nosniff\n  Header set Cache-Control \"private, max-age=3600\"\n</IfModule>\n");
    }
}
