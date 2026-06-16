<?php
declare(strict_types=1);

namespace Nyza;

/**
 * In-app updater. Pulls the latest build from GitHub and copies it over the
 * running install, preserving config.php + storage/, then runs any new DB
 * migrations. Triggered via /cloud/?update=1 and gated behind a valid admin
 * token (same model as the locked SetupWizard) so a random visitor can't
 * overwrite the install.
 *
 * It never deletes files — it only overwrites/adds from the downloaded build —
 * so an existing vendor/ stays intact. If the web user can't write to the
 * install dir the copy fails gracefully and the manual FTP route still works.
 */
final class Updater
{
    private const REPO_ZIP = 'https://github.com/globifygmbh/nyza-cloud/archive/refs/heads/main.zip';
    private const REMOTE_VERSION = 'https://raw.githubusercontent.com/globifygmbh/nyza-cloud/main/cloud/VERSION';
    // Commit-based detection (cache-free, unlike the raw VERSION file).
    private const REMOTE_COMMIT = 'https://api.github.com/repos/globifygmbh/nyza-cloud/commits/main';
    private const ZIP_SUBPATH = 'cloud/'; // folder inside the repo that maps to this install
    /** Never overwrite these (user data / local config). */
    private const PRESERVE = ['config.php', 'storage', '.htaccess', '.nyza_rev'];

    private string $cloudDir;

    public function __construct(?string $cloudDir = null)
    {
        $this->cloudDir = $cloudDir ?? dirname(__DIR__);
    }

    public function handle(): void
    {
        if (!$this->isAuthedAdmin()) { $this->renderLocked(); return; }

        $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
        if ($method === 'POST' && ($_POST['action'] ?? '') === 'run') {
            $this->runUpdate();
            return;
        }
        $this->renderStart();
    }

    // ───── auth (mirror of SetupWizard's gate) ───────────────────────────────
    private function bearer(): ?string
    {
        $h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
        if (!$h && function_exists('getallheaders')) {
            foreach (getallheaders() as $k => $v) { if (strtolower($k) === 'authorization') { $h = $v; break; } }
        }
        if (is_string($h) && preg_match('/^Bearer\s+(.+)$/i', $h, $m)) return $m[1];
        $t = $_GET['token'] ?? $_POST['token'] ?? null;
        return is_string($t) && $t !== '' ? $t : null;
    }

    private function isAuthedAdmin(): bool
    {
        $tok = $this->bearer();
        if (!$tok) return false;
        $p = Auth::decode($tok);
        if (!$p || empty($p['sub'])) return false;
        try {
            $s = Database::pdo()->prepare('SELECT 1 FROM users WHERE id = ?');
            $s->execute([(int)$p['sub']]);
            return (bool) $s->fetch();
        } catch (\Throwable $e) {
            return false;
        }
    }

    private function token(): string { return (string)($this->bearer() ?? ''); }

    private function localVersion(): string
    {
        $f = $this->cloudDir . '/VERSION';
        return is_file($f) ? trim((string)file_get_contents($f)) : '0.0.0';
    }

    private function remoteVersion(): ?string
    {
        $v = $this->fetch(self::REMOTE_VERSION . '?_=' . time());
        return $v !== null ? trim($v) : null;
    }

    /** Locally recorded commit sha of the last applied update (or null). */
    private function localRev(): ?string
    {
        $f = $this->cloudDir . '/.nyza_rev';
        return is_file($f) ? trim((string)file_get_contents($f)) : null;
    }

    /** Latest commit sha on main via the GitHub API (cache-free). */
    private function remoteRev(): ?string
    {
        $json = $this->fetch(self::REMOTE_COMMIT . '?_=' . time());
        if ($json === null) return null;
        $data = json_decode($json, true);
        $sha = is_array($data) ? ($data['sha'] ?? null) : null;
        return is_string($sha) && $sha !== '' ? substr($sha, 0, 40) : null;
    }

    // ───── update run ────────────────────────────────────────────────────────
    private function runUpdate(): void
    {
        $log = [];
        $ok = true;
        $add = function (string $m, bool $good = true) use (&$log, &$ok) {
            $log[] = ['m' => $m, 'ok' => $good];
            if (!$good) $ok = false;
        };

        if (!extension_loaded('zip')) { $this->renderResult(false, [['m' => 'PHP-Extension zip fehlt — Update nicht möglich.', 'ok' => false]]); return; }
        if (!is_writable($this->cloudDir)) { $this->renderResult(false, [['m' => 'Installations-Ordner ist nicht beschreibbar (' . $this->cloudDir . '). Bitte per FTP aktualisieren.', 'ok' => false]]); return; }

        $tmp = sys_get_temp_dir() . '/nyza_update_' . bin2hex(random_bytes(6));
        @mkdir($tmp, 0775, true);
        $zipFile = $tmp . '/repo.zip';

        // 1) Download
        $data = $this->fetch(self::REPO_ZIP, true);
        if ($data === null || strlen($data) < 1000) {
            $this->cleanup($tmp);
            $this->renderResult(false, [['m' => 'Download von GitHub fehlgeschlagen. Server erlaubt evtl. keine ausgehenden Verbindungen — dann manuell per FTP aktualisieren.', 'ok' => false]]);
            return;
        }
        file_put_contents($zipFile, $data);
        $add('Neueste Version von GitHub geladen (' . $this->human(strlen($data)) . ').');

        // 2) Extract
        $zip = new \ZipArchive();
        if ($zip->open($zipFile) !== true) { $this->cleanup($tmp); $this->renderResult(false, [['m' => 'ZIP konnte nicht geöffnet werden.', 'ok' => false]]); return; }
        $extractDir = $tmp . '/x';
        @mkdir($extractDir, 0775, true);
        $zip->extractTo($extractDir);
        $zip->close();
        $add('Archiv entpackt.');

        // 3) Locate the cloud/ folder inside the extracted repo (nyza-cloud-main/cloud).
        $src = null;
        foreach (glob($extractDir . '/*', GLOB_ONLYDIR) ?: [] as $d) {
            if (is_dir($d . '/' . rtrim(self::ZIP_SUBPATH, '/'))) { $src = $d . '/' . rtrim(self::ZIP_SUBPATH, '/'); break; }
        }
        if ($src === null) { $this->cleanup($tmp); $this->renderResult(false, [['m' => 'Im Archiv wurde kein cloud/-Ordner gefunden.', 'ok' => false]]); return; }

        // 4) Copy over the install, preserving local files.
        $copied = $this->copyTree($src, $this->cloudDir);
        $add($copied . ' Dateien aktualisiert (config.php + storage/ unangetastet).');

        // 5) Run new migrations.
        try {
            Database::migrate(Database::pdo());
            $add('Datenbank-Migrationen ausgeführt.');
        } catch (\Throwable $e) {
            $add('Migration-Hinweis: ' . $e->getMessage() . ' — ggf. /cloud/?setup=1 öffnen.', false);
        }

        // 6) Record the applied commit so the next check is accurate.
        $rev = $this->remoteRev();
        if ($rev) { @file_put_contents($this->cloudDir . '/.nyza_rev', $rev); }

        $this->cleanup($tmp);
        $this->renderResult($ok, $log);
    }

    /** Recursively copy $src into $dst, skipping PRESERVE entries at the root. */
    private function copyTree(string $src, string $dst, int $depth = 0): int
    {
        $count = 0;
        foreach (scandir($src) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') continue;
            if ($depth === 0 && in_array($entry, self::PRESERVE, true)) continue;
            $from = $src . '/' . $entry;
            $to = $dst . '/' . $entry;
            if (is_dir($from)) {
                if (!is_dir($to)) @mkdir($to, 0775, true);
                $count += $this->copyTree($from, $to, $depth + 1);
            } else {
                if (@copy($from, $to)) $count++;
            }
        }
        return $count;
    }

    private function cleanup(string $dir): void
    {
        if (!is_dir($dir)) return;
        $it = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($it as $f) { $f->isDir() ? @rmdir($f->getPathname()) : @unlink($f->getPathname()); }
        @rmdir($dir);
    }

    /** Fetch a URL via curl (preferred) or file_get_contents. Returns body|null. */
    private function fetch(string $url, bool $binary = false): ?string
    {
        if (function_exists('curl_init')) {
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_MAXREDIRS => 5,
                CURLOPT_TIMEOUT => $binary ? 120 : 20,
                CURLOPT_USERAGENT => 'Nyza-Cloud-Updater',
                CURLOPT_SSL_VERIFYPEER => true,
            ]);
            $out = curl_exec($ch);
            $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);
            if ($out !== false && $code >= 200 && $code < 300) return (string)$out;
            return null;
        }
        if (ini_get('allow_url_fopen')) {
            $ctx = stream_context_create(['http' => ['timeout' => $binary ? 120 : 20, 'user_agent' => 'Nyza-Cloud-Updater']]);
            $out = @file_get_contents($url, false, $ctx);
            return $out === false ? null : $out;
        }
        return null;
    }

    private function human(int $b): string
    {
        $u = ['B', 'KB', 'MB']; $i = 0; $x = (float)$b;
        while ($x >= 1024 && $i < 2) { $x /= 1024; $i++; }
        return round($x, 1) . ' ' . $u[$i];
    }

    // ───── pages ─────────────────────────────────────────────────────────────
    private function renderStart(): void
    {
        $local = $this->localVersion();
        $remote = $this->remoteVersion();
        // Primary signal: commit sha (cache-free). Falls back to version compare.
        $localRev = $this->localRev();
        $remoteRev = $this->remoteRev();
        if ($remoteRev !== null && $localRev !== null) {
            $upToDate = ($remoteRev === $localRev);
        } else {
            $upToDate = $remote !== null && version_compare($remote, $local, '<=');
        }
        $tok = htmlspecialchars($this->token());
        $this->page('Update', function () use ($local, $remote, $upToDate, $remoteRev, $tok) {
            echo '<h1>Nyza Cloud · Update</h1>';
            echo '<p class="lede">Aktualisiert die Installation direkt aus dem GitHub-Repository. <code>config.php</code> und deine Dateien in <code>storage/</code> bleiben erhalten.</p>';
            echo '<ul class="checks">';
            echo '<li class="info"><span class="icon">●</span><div><b>Installierte Version</b><div class="muted">' . htmlspecialchars($local) . '</div></div></li>';
            echo '<li class="' . ($remote === null ? 'info' : ($upToDate ? 'ok' : 'fail')) . '"><span class="icon">' . ($remote === null ? '?' : ($upToDate ? '✓' : '↑')) . '</span><div><b>Neueste Version</b><div class="muted">' . htmlspecialchars($remote ?? 'unbekannt (GitHub nicht erreichbar)') . ($remoteRev ? ' · ' . substr($remoteRev, 0, 7) : '') . '</div></div></li>';
            echo '</ul>';
            if ($upToDate) {
                echo '<div class="ok-box">Du bist bereits auf dem neuesten Stand. Ein erneutes Update schadet aber nicht — einfach trotzdem auf „Jetzt aktualisieren".</div>';
            }
            echo '<div class="warn">Vor dem ersten Update empfohlen: kurzes Backup von Datenbank und <code>storage/</code>.</div>';
            echo '<form method="post" class="actions" style="margin-top:24px">';
            echo '<input type="hidden" name="action" value="run"><input type="hidden" name="token" value="' . $tok . '">';
            echo '<a class="btn" href="./">Zur App</a>';
            echo '<button class="btn btn-primary" type="submit">Jetzt aktualisieren</button>';
            echo '</form>';
        });
    }

    private function renderResult(bool $ok, array $log): void
    {
        $this->page('Update', function () use ($ok, $log) {
            echo '<h1>' . ($ok ? 'Update abgeschlossen' : 'Update mit Hinweisen') . '</h1>';
            echo '<ul class="checks">';
            foreach ($log as $row) {
                $cls = $row['ok'] ? 'ok' : 'fail';
                $ic = $row['ok'] ? '✓' : '✗';
                echo '<li class="' . $cls . '"><span class="icon">' . $ic . '</span><div>' . htmlspecialchars($row['m']) . '</div></li>';
            }
            echo '</ul>';
            if ($ok) echo '<div class="ok-box">Fertig! Lade die App neu (Strg/Cmd + Shift + R), damit die neuen Dateien geladen werden.</div>';
            echo '<div class="actions" style="margin-top:22px"><a class="btn btn-primary" href="./">Zur App</a></div>';
        });
    }

    private function renderLocked(): void
    {
        http_response_code(403);
        $this->page('Gesperrt', function () {
            echo '<h1>Update gesperrt</h1>';
            echo '<p class="lede">Der Updater ist aus Sicherheitsgründen nur als angemeldeter Admin erreichbar.</p>';
            echo '<div class="actions" style="margin-top:20px"><a id="unlock" class="btn btn-primary" href="#">Als Admin entsperren</a> <a class="btn" href="./">Zur App</a></div>';
            echo "<script>(function(){var t=null;try{t=localStorage.getItem('nyza.token');}catch(e){}"
               . "var u=document.getElementById('unlock');var base=location.pathname.replace(/index\\.php$/,'');"
               . "if(t){u.href=base+'?update=1&token='+encodeURIComponent(t);}else{u.textContent='Bitte zuerst in der App einloggen';u.href='./';}})();</script>";
        });
    }

    private function page(string $title, callable $body): void
    {
        ob_start(); $body(); $content = ob_get_clean();
        echo '<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Nyza · ' . htmlspecialchars($title) . '</title>';
        echo '<meta name="viewport" content="width=device-width,initial-scale=1"><style>' . $this->css() . '</style></head>';
        echo '<body><div class="wrap"><header class="brand"><div class="mark"></div><span>nyza · cloud · update</span></header><main>' . $content . '</main></div></body></html>';
        exit;
    }

    private function css(): string
    {
        return <<<CSS
*{box-sizing:border-box}
body{margin:0;background:#0B0B0F;color:#F4F4F6;font:14px/1.55 -apple-system,system-ui,sans-serif}
body::before{content:"";position:fixed;inset:0;pointer-events:none;background:radial-gradient(circle at 20% 10%,rgba(124,92,255,0.18),transparent 50%),radial-gradient(circle at 80% 90%,rgba(59,130,246,0.14),transparent 50%)}
.wrap{max-width:680px;margin:0 auto;padding:48px 24px;position:relative}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:32px;font-size:13px;color:rgba(244,244,246,0.6);letter-spacing:0.4px}
.mark{width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,#7C5CFF,#3B82F6);box-shadow:0 1px 0 rgba(255,255,255,0.3) inset,0 4px 12px rgba(124,92,255,0.4)}
main{background:rgba(22,22,28,0.62);border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:36px;backdrop-filter:blur(40px) saturate(180%);box-shadow:0 1px 0 rgba(255,255,255,0.1) inset,0 30px 60px -20px rgba(0,0,0,0.5)}
h1{font-size:26px;font-weight:600;letter-spacing:-0.8px;margin:0 0 12px}
.lede{color:rgba(244,244,246,0.7);margin:0 0 24px;font-size:15px}
.muted{color:rgba(244,244,246,0.5);font-size:12.5px;margin-top:2px}
code{background:rgba(255,255,255,0.06);padding:2px 6px;border-radius:4px;font-family:ui-monospace,monospace;font-size:12.5px}
.checks{list-style:none;padding:0;margin:0 0 20px;display:flex;flex-direction:column;gap:8px}
.checks li{display:flex;gap:12px;padding:10px 14px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06)}
.checks li.ok .icon{color:#4ade80}.checks li.fail{background:rgba(255,80,80,0.08);border-color:rgba(255,80,80,0.25)}.checks li.fail .icon{color:#ff7b7b}.checks li.info .icon{color:rgba(244,244,246,0.5)}
.checks .icon{font-size:16px;flex-shrink:0;width:20px;text-align:center}.checks b{font-weight:540}
.warn{padding:14px 18px;border-radius:10px;background:rgba(255,180,80,0.1);border:1px solid rgba(255,180,80,0.3);color:#ffd49a;margin-top:8px}
.ok-box{padding:16px 20px;border-radius:14px;background:linear-gradient(135deg,rgba(74,222,128,0.15),rgba(74,222,128,0.05));border:1px solid rgba(74,222,128,0.3)}
.btn{display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 18px;border-radius:999px;font:inherit;font-weight:540;text-decoration:none;color:inherit;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);cursor:pointer;transition:all 0.18s}
.btn:hover{background:rgba(255,255,255,0.12)}
.btn-primary{background:linear-gradient(135deg,#7C5CFF,#3B82F6);border-color:transparent;color:#fff;box-shadow:0 1px 0 rgba(255,255,255,0.25) inset,0 8px 24px -8px rgba(124,92,255,0.5)}
.actions{display:flex;gap:10px;align-items:center}
CSS;
    }
}
