<?php
declare(strict_types=1);

namespace Nyza;

final class Storage
{
    public static function root(): string
    {
        $p = getenv('STORAGE_PATH') ?: __DIR__ . '/../storage/files';
        if (!is_dir($p)) {
            mkdir($p, 0775, true);
        }
        return realpath($p) ?: $p;
    }

    public static function temp(): string
    {
        $p = getenv('TEMP_PATH') ?: __DIR__ . '/../storage/temp';
        if (!is_dir($p)) {
            mkdir($p, 0775, true);
        }
        return realpath($p) ?: $p;
    }

    /**
     * Returns a relative storage path: users/<uid>/<yyyy>/<mm>/<random>.<ext>.
     * Caller writes to root()/<storage_path>.
     */
    public static function relPath(int $userId, string $originalName): string
    {
        $ext = pathinfo($originalName, PATHINFO_EXTENSION);
        $ext = $ext ? '.' . preg_replace('/[^a-zA-Z0-9]/', '', $ext) : '';
        $rel = sprintf(
            'users/%d/%s/%s/%s%s',
            $userId,
            date('Y'),
            date('m'),
            bin2hex(random_bytes(12)),
            $ext
        );
        $abs = self::root() . '/' . $rel;
        $dir = dirname($abs);
        if (!is_dir($dir)) {
            mkdir($dir, 0775, true);
        }
        return $rel;
    }

    /**
     * Relative storage path for a version blob: users/<uid>/versions/<random>.
     * Kept extension-less — versions are opaque snapshots, never web-served.
     */
    public static function versionPath(int $userId): string
    {
        $rel = sprintf('users/%d/versions/%s', $userId, bin2hex(random_bytes(16)));
        $dir = dirname(self::root() . '/' . $rel);
        if (!is_dir($dir)) {
            mkdir($dir, 0775, true);
        }
        return $rel;
    }

    public static function abs(string $relPath): string
    {
        return self::root() . '/' . ltrim($relPath, '/');
    }

    public static function deleteRel(string $relPath): bool
    {
        $abs = self::abs($relPath);
        if (is_file($abs)) {
            return @unlink($abs);
        }
        return true;
    }

    public static function kindFromMime(string $mime): string
    {
        if (str_starts_with($mime, 'image/')) return 'image';
        if (str_starts_with($mime, 'video/')) return 'video';
        if ($mime === 'application/pdf') return 'pdf';
        return 'doc';
    }

    /**
     * Server-executable / script extensions that must never land in storage.
     * The storage dir is .htaccess-blocked from direct web access, but this is
     * defense-in-depth: if that protection is ever misconfigured, an uploaded
     * .php must not be executable. Applies to owner AND upload-link guests.
     */
    private const BLOCKED_EXT = [
        'php', 'php3', 'php4', 'php5', 'php7', 'php8', 'phps', 'phtml', 'pht',
        'phar', 'cgi', 'pl', 'py', 'asp', 'aspx', 'jsp', 'jspx', 'sh', 'bash',
        'exe', 'com', 'bat', 'cmd', 'msi', 'scr', 'vbs', 'ws', 'wsf',
    ];

    public static function isDangerous(string $name): bool
    {
        $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
        return in_array($ext, self::BLOCKED_EXT, true);
    }

    /**
     * MIME types that can execute script in the app's own origin if served
     * inline (stored-XSS vector — e.g. an upload-link guest dropping a
     * malicious .svg/.html that the admin then previews, stealing the JWT from
     * localStorage). These are always sent as downloads with nosniff.
     */
    public static function mustDownload(string $mime): bool
    {
        $m = strtolower(trim(explode(';', $mime)[0]));
        return in_array($m, [
            'text/html', 'application/xhtml+xml', 'image/svg+xml',
            'application/xml', 'text/xml',
        ], true);
    }

    public static function humanSize(int $bytes): string
    {
        $u = ['B', 'KB', 'MB', 'GB', 'TB'];
        $i = 0;
        $b = (float)$bytes;
        while ($b >= 1024 && $i < count($u) - 1) {
            $b /= 1024;
            $i++;
        }
        return number_format($b, $b < 10 && $i > 0 ? 1 : 0) . ' ' . $u[$i];
    }
}
