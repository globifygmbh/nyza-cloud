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
