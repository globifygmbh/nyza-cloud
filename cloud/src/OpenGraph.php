<?php
declare(strict_types=1);

namespace Nyza;

/**
 * Server-rendered Open Graph tags for public link pages so chat apps
 * (WhatsApp, Signal, …) show a meaningful preview — the shared item's name
 * instead of a generic title, plus a cover image for galleries.
 */
final class OpenGraph
{
    public static function tags(string $path, string $basePath): string
    {
        try {
            return self::build($path, $basePath);
        } catch (\Throwable $e) {
            return '';
        }
    }

    private static function build(string $path, string $basePath): string
    {
        $path = trim($path, '/');
        if (!preg_match('#^(s|u|f|sign|portal)/([A-Za-z0-9_-]+)#', $path, $m)) return '';
        $kind = $m[1]; $token = $m[2];

        $title = null; $desc = 'Geteilt über Nyza Cloud'; $image = null;
        try {
            $pdo = Database::pdo();
            if ($kind === 's') {
                $s = $pdo->prepare('SELECT * FROM share_links WHERE token = ? LIMIT 1');
                $s->execute([$token]); $sh = $s->fetch();
                if ($sh) {
                    if ($sh['folder_id']) {
                        $f = $pdo->prepare('SELECT name FROM folders WHERE id = ?'); $f->execute([(int)$sh['folder_id']]);
                        $title = ($f->fetch()['name'] ?? null);
                    } elseif ($sh['file_id']) {
                        $f = $pdo->prepare('SELECT name FROM files WHERE id = ?'); $f->execute([(int)$sh['file_id']]);
                        $title = ($f->fetch()['name'] ?? null);
                    }
                    // Cover image for unprotected galleries.
                    if (empty($sh['password_hash']) && $sh['folder_id']) {
                        $cid = !empty($sh['cover_file_id']) ? (int)$sh['cover_file_id'] : null;
                        if (!$cid) {
                            $im = $pdo->prepare("SELECT id FROM files WHERE folder_id = ? AND deleted_at IS NULL AND kind = 'image' ORDER BY created_at LIMIT 1");
                            $im->execute([(int)$sh['folder_id']]); $r = $im->fetch();
                            $cid = $r ? (int)$r['id'] : null;
                        }
                        if ($cid) $image = self::base($basePath) . '/api/s/' . $token . '/file/' . $cid . '/thumb';
                    }
                }
            } elseif ($kind === 'u') {
                $s = $pdo->prepare('SELECT title FROM upload_links WHERE token = ? LIMIT 1'); $s->execute([$token]);
                $title = ($s->fetch()['title'] ?? null); $desc = 'Dateien hochladen · Nyza Cloud';
            } elseif ($kind === 'f') {
                $s = $pdo->prepare('SELECT title FROM forms WHERE token = ? AND active = 1 LIMIT 1'); $s->execute([$token]);
                $title = ($s->fetch()['title'] ?? null); $desc = 'Formular · Nyza Cloud';
            } elseif ($kind === 'sign') {
                $s = $pdo->prepare('SELECT title FROM signature_requests WHERE token = ? LIMIT 1'); $s->execute([$token]);
                $title = ($s->fetch()['title'] ?? null); $desc = 'Zur Unterschrift · Nyza Cloud';
            } elseif ($kind === 'portal') {
                $s = $pdo->prepare('SELECT name FROM portals WHERE token = ? LIMIT 1'); $s->execute([$token]);
                $title = ($s->fetch()['name'] ?? null); $desc = 'Kundenportal · Nyza Cloud';
            }
        } catch (\Throwable $e) { return ''; }

        if ($title === null || $title === '') return '';
        $e = static fn($s) => htmlspecialchars((string)$s, ENT_QUOTES);
        $out = '<title>' . $e($title) . ' · Nyza Cloud</title>'
             . '<meta name="description" content="' . $e($desc) . '">'
             . '<meta property="og:site_name" content="Nyza Cloud">'
             . '<meta property="og:type" content="website">'
             . '<meta property="og:title" content="' . $e($title) . '">'
             . '<meta property="og:description" content="' . $e($desc) . '">'
             . '<meta name="twitter:title" content="' . $e($title) . '">'
             . '<meta name="twitter:description" content="' . $e($desc) . '">';
        if ($image) {
            $out .= '<meta property="og:image" content="' . $e($image) . '">'
                  . '<meta name="twitter:card" content="summary_large_image">'
                  . '<meta name="twitter:image" content="' . $e($image) . '">';
        } else {
            $out .= '<meta name="twitter:card" content="summary">';
        }
        return $out;
    }

    private static function base(string $basePath): string
    {
        $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['SERVER_PORT'] ?? '') == 443)
            || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
        $host = $_SERVER['HTTP_HOST'] ?? ($_SERVER['SERVER_NAME'] ?? 'localhost');
        return ($https ? 'https' : 'http') . '://' . $host . ($basePath && $basePath !== '/' ? $basePath : '');
    }
}
