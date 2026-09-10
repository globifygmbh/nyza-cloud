<?php
declare(strict_types=1);

namespace Nyza;

/**
 * Installation-wide brand name and description — what a link preview in
 * WhatsApp/Signal shows, the browser tab title, and the PWA manifest.
 *
 * Stored once per installation in app_settings under ns 'branding', owned by
 * the install owner (Hauptadmin, falling back to the oldest account). It has to
 * be readable with no session at all, because OpenGraph renders for anonymous
 * visitors following a share link.
 */
final class Brand
{
    public const DEFAULT_NAME = 'Nyza Cloud';
    public const DEFAULT_DESC = 'Premium Cloud-Storage mit Upload-Links.';

    /** The owner whose app_settings row holds the installation's branding. */
    public static function ownerId(): ?int
    {
        try {
            $row = Database::pdo()->query(
                'SELECT id FROM users WHERE active = 1 ORDER BY is_primary DESC, id ASC LIMIT 1'
            )->fetch();
            return $row ? (int)$row['id'] : null;
        } catch (\Throwable $e) {
            return null;
        }
    }

    /** Raw stored values (may be empty) — cached per request. */
    public static function data(): array
    {
        static $cache = null;
        if ($cache !== null) return $cache;
        $cache = [];
        try {
            $uid = self::ownerId();
            if ($uid !== null) {
                $s = Database::pdo()->prepare('SELECT data FROM app_settings WHERE user_id = ? AND ns = ?');
                $s->execute([$uid, 'branding']);
                $row = $s->fetch();
                if ($row && $row['data'] !== null) {
                    $d = json_decode((string)$row['data'], true);
                    if (is_array($d)) $cache = $d;
                }
            }
        } catch (\Throwable $e) {
            // Table missing / DB down during setup — fall back to the defaults.
            $cache = [];
        }
        return $cache;
    }

    public static function name(): string
    {
        $v = trim((string)(self::data()['site_name'] ?? ''));
        return $v !== '' ? $v : self::DEFAULT_NAME;
    }

    public static function description(): string
    {
        $v = trim((string)(self::data()['description'] ?? ''));
        return $v !== '' ? $v : self::DEFAULT_DESC;
    }

    /** Relative storage path of the uploaded home-screen icon, if any. */
    public static function iconPath(): ?string
    {
        $v = trim((string)(self::data()['icon_path'] ?? ''));
        if ($v === '') return null;
        return is_file(Storage::abs($v)) ? $v : null;
    }

    /** Absolute-ish icon info for the manifest / <link> tags, or null. */
    public static function icon(): ?array
    {
        $rel = self::iconPath();
        if ($rel === null) return null;
        $abs = Storage::abs($rel);
        $ext = strtolower(pathinfo($abs, PATHINFO_EXTENSION));
        $mime = ['png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg',
                 'webp' => 'image/webp', 'svg' => 'image/svg+xml'][$ext] ?? 'image/png';
        // Declare the real pixel size: Android ignores an icon whose declared
        // sizes don't match, which would silently fall back to the built-in one.
        $sizes = 'any';
        if ($mime !== 'image/svg+xml') {
            $info = @getimagesize($abs);
            if ($info && $info[0] > 0) $sizes = $info[0] . 'x' . $info[1];
        }
        return ['rel' => $rel, 'mime' => $mime, 'sizes' => $sizes, 'v' => (string)@filemtime($abs)];
    }

    /** Short name for the PWA/home-screen icon; falls back to the first word. */
    public static function shortName(): string
    {
        $v = trim((string)(self::data()['short_name'] ?? ''));
        if ($v !== '') return $v;
        $parts = preg_split('/\s+/', self::name()) ?: [];
        return $parts[0] ?? self::name();
    }
}
