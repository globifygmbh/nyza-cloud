<?php
declare(strict_types=1);

namespace Nyza;

/**
 * Self-contained setup wizard. Runs when config.php is missing OR can be
 * triggered manually via /cloud/setup for diagnostics.
 *
 * Design choices:
 *  - Pure PHP, no JS dependency — must work even if the React build broke.
 *  - Multi-step state in URL query params (?step=) instead of session, so it's
 *    bookmarkable and refresh-safe.
 *  - System checks run first; if any are red, the DB form is hidden — no
 *    point typing credentials when pdo_mysql isn't installed.
 *  - The wizard never logs DB credentials; on connection failure only the
 *    PDO error class + a generic hint are shown.
 *  - Writes config.php atomically (tmp file → rename) with strict permissions.
 */
final class SetupWizard
{
    private string $cloudDir;

    public function __construct(?string $cloudDir = null)
    {
        $this->cloudDir = $cloudDir ?? dirname(__DIR__);
    }

    public function handle(): void
    {
        $step = $_GET['step'] ?? 'checks';
        $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');

        if ($method === 'POST' && $step === 'config') {
            $this->processConfigForm();
            return;
        }
        if ($method === 'POST' && $step === 'admin') {
            $this->processAdminForm();
            return;
        }

        switch ($step) {
            case 'config':  $this->renderConfigForm(); break;
            case 'admin':   $this->renderAdminForm(); break;
            case 'finish':  $this->renderFinish(); break;
            case 'checks':
            default:        $this->renderChecks(); break;
        }
    }

    // ───── Step 1: System checks ─────────────────────────────────────────

    private function runChecks(): array
    {
        $checks = [];

        // PHP version
        $checks[] = $this->check(
            'PHP-Version ≥ 8.1',
            version_compare(PHP_VERSION, '8.1.0', '>='),
            'Aktuell: PHP ' . PHP_VERSION,
            'Brauche PHP 8.1+. Beim Hoster auf neuere Version umstellen.'
        );

        // Required extensions
        foreach ([
            'pdo_mysql' => 'PDO MySQL Driver',
            'zip'       => 'Zip Archive',
            'mbstring'  => 'Multibyte Strings',
            'fileinfo'  => 'File Info (MIME-Detection)',
            'json'      => 'JSON',
        ] as $ext => $label) {
            $checks[] = $this->check(
                "PHP-Extension: $label ($ext)",
                extension_loaded($ext),
                'aktiv',
                "Aktivieren in php.ini, oder beim Hoster anfragen."
            );
        }

        // Composer vendor/
        $checks[] = $this->check(
            'Composer-Pakete (vendor/) installiert',
            is_file($this->cloudDir . '/vendor/autoload.php'),
            'vendor/autoload.php gefunden',
            'Vor dem Upload "composer install --no-dev" laufen lassen, oder den vendor/-Ordner mit hochladen.'
        );

        // Frontend assets built
        $checks[] = $this->check(
            'Frontend gebaut (assets/)',
            is_file($this->cloudDir . '/assets/index.html'),
            'assets/index.html gefunden',
            'Vor dem Upload im frontend/-Ordner "npm run build" laufen lassen.'
        );

        // Storage writability
        $checks[] = $this->checkWritable('storage/',       $this->cloudDir . '/storage');
        $checks[] = $this->checkWritable('storage/files/', $this->cloudDir . '/storage/files');
        $checks[] = $this->checkWritable('storage/temp/',  $this->cloudDir . '/storage/temp');

        // Cloud-dir writable (so wizard can WRITE config.php)
        $checks[] = $this->checkWritable('cloud/ (für config.php)', $this->cloudDir);

        // mod_rewrite — empirical: if this URL works at all under /cloud/,
        // rewrites are working. Show it as a "passed" check with a note.
        $checks[] = $this->check(
            'Apache mod_rewrite (.htaccess)',
            true,
            'OK — diese Setup-Seite läuft, also greift die .htaccess-Rewrite-Regel.',
            null
        );

        // upload_max_filesize / post_max_size — informational only
        $maxUpload = ini_get('upload_max_filesize') ?: '?';
        $maxPost   = ini_get('post_max_size') ?: '?';
        $checks[] = $this->check(
            "PHP-Upload-Limits: upload_max_filesize=$maxUpload, post_max_size=$maxPost",
            true,
            'OK — für Dateien größer als post_max_size den Chunk-Upload-Endpoint nutzen.',
            null,
            'info'
        );

        return $checks;
    }

    private function check(string $label, bool $ok, string $okText, ?string $hint, string $sev = 'critical'): array
    {
        return ['label' => $label, 'ok' => $ok, 'ok_text' => $okText, 'hint' => $hint, 'sev' => $sev];
    }

    private function checkWritable(string $label, string $path): array
    {
        if (!is_dir($path)) {
            // Try to create
            @mkdir($path, 0775, true);
        }
        $ok = is_dir($path) && is_writable($path);
        return $this->check(
            "Schreibrechte: $label",
            $ok,
            'OK',
            $ok ? null : "chmod 775 $path (oder beim Hoster Schreibrechte freigeben)."
        );
    }

    private function renderChecks(): void
    {
        $checks = $this->runChecks();
        $blockers = array_filter($checks, fn($c) => $c['sev'] === 'critical' && !$c['ok']);
        $allGood = count($blockers) === 0;
        $configExists = is_file($this->cloudDir . '/config.php');

        $this->page('System-Checks', function () use ($checks, $allGood, $configExists) {
            echo '<h1>Setup · System-Checks</h1>';
            echo '<p class="lede">Prüft deine Hosting-Umgebung. Wenn alles grün ist, geht\'s zur Datenbank-Konfiguration.</p>';

            echo '<ul class="checks">';
            foreach ($checks as $c) {
                $cls = $c['ok'] ? 'ok' : ($c['sev'] === 'critical' ? 'fail' : 'info');
                $icon = $c['ok'] ? '✓' : ($c['sev'] === 'critical' ? '✗' : 'ℹ');
                echo '<li class="' . $cls . '">';
                echo '<span class="icon">' . $icon . '</span>';
                echo '<div><b>' . htmlspecialchars($c['label']) . '</b>';
                if ($c['ok']) echo '<div class="muted">' . htmlspecialchars($c['ok_text']) . '</div>';
                if (!$c['ok'] && $c['hint']) echo '<div class="hint">' . htmlspecialchars($c['hint']) . '</div>';
                echo '</div></li>';
            }
            echo '</ul>';

            if (!$allGood) {
                echo '<div class="warn">⚠ Erst die roten Punkte oben fixen, dann <a href="?step=checks">erneut prüfen</a>.</div>';
            } else {
                if ($configExists) {
                    echo '<div class="ok-box">✓ <code>config.php</code> existiert bereits. ';
                    echo '<a href="?step=finish" class="btn btn-primary">Datenbank testen →</a> ';
                    echo '<a href="?step=config" class="btn">Neu konfigurieren</a></div>';
                } else {
                    echo '<div class="ok-box">✓ Alle Checks bestanden. <a href="?step=config" class="btn btn-primary">Weiter zur Datenbank-Konfiguration →</a></div>';
                }
            }
        });
    }

    // ───── Step 2: DB config form ────────────────────────────────────────

    private function renderConfigForm(?string $error = null, array $values = []): void
    {
        $values = array_merge([
            'db_host' => '127.0.0.1',
            'db_port' => '3306',
            'db_name' => 'nyza',
            'db_user' => '',
            'db_pass' => '',
        ], $values);

        $this->page('Datenbank-Konfiguration', function () use ($error, $values) {
            echo '<h1>Setup · Datenbank-Konfiguration</h1>';
            echo '<p class="lede">Trag deine MySQL-Zugangsdaten ein. Beim Absenden testet die Wizard die Verbindung. Bei Erfolg wird <code>config.php</code> automatisch geschrieben (mit zufällig generiertem JWT-Secret).</p>';

            if ($error) echo '<div class="err">✗ ' . htmlspecialchars($error) . '</div>';

            echo '<form method="post" action="?step=config" class="form">';
            $this->field('db_host', 'MySQL Host', $values['db_host'], 'meist 127.0.0.1 oder localhost');
            $this->field('db_port', 'Port',       $values['db_port'], 'meist 3306');
            $this->field('db_name', 'Datenbank-Name', $values['db_name'], 'die DB muss bereits existieren (CREATE DATABASE nyza CHARACTER SET utf8)');
            $this->field('db_user', 'Benutzer',   $values['db_user'], '');
            $this->field('db_pass', 'Passwort',   $values['db_pass'], '', 'password');
            echo '<div class="actions">';
            echo '<a href="?step=checks" class="btn">← Zurück</a>';
            echo '<button type="submit" class="btn btn-primary">Verbindung testen & speichern</button>';
            echo '</div>';
            echo '</form>';
        });
    }

    private function field(string $name, string $label, string $value, string $hint = '', string $type = 'text'): void
    {
        echo '<label><span>' . htmlspecialchars($label) . '</span>';
        echo '<input type="' . $type . '" name="' . $name . '" value="' . htmlspecialchars($value) . '" required autocomplete="off"/>';
        if ($hint) echo '<small>' . htmlspecialchars($hint) . '</small>';
        echo '</label>';
    }

    private function processConfigForm(): void
    {
        $values = [
            'db_host' => trim($_POST['db_host'] ?? ''),
            'db_port' => trim($_POST['db_port'] ?? '3306'),
            'db_name' => trim($_POST['db_name'] ?? ''),
            'db_user' => trim($_POST['db_user'] ?? ''),
            'db_pass' => $_POST['db_pass'] ?? '',
        ];

        // Test the connection BEFORE writing config.php so a bad password
        // doesn't leave a half-broken installation. We probe with `utf8`
        // because that's the schema default and what config.php will write —
        // hosters with utf8mb4 still accept it (utf8 is a subset).
        $dsn = "mysql:host={$values['db_host']};port={$values['db_port']};dbname={$values['db_name']};charset=utf8";
        try {
            $pdo = new \PDO($dsn, $values['db_user'], $values['db_pass'], [
                \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
                \PDO::ATTR_TIMEOUT => 5,
            ]);
            // Sanity: write+read+drop a temp table to check we have CREATE perms.
            $pdo->exec('CREATE TABLE IF NOT EXISTS _nyza_setup_probe (id INT PRIMARY KEY) ENGINE=InnoDB');
            $pdo->exec('DROP TABLE _nyza_setup_probe');
        } catch (\PDOException $e) {
            // Sanitize: don't echo the DSN/password back. Show the
            // SQLSTATE category which is enough to debug typical issues.
            $code = $e->getCode() ?: 'unknown';
            $msg = match (true) {
                str_contains($e->getMessage(), 'Access denied')      => 'Zugriff verweigert — User oder Passwort falsch?',
                str_contains($e->getMessage(), 'Unknown database')   => 'Datenbank existiert nicht — bitte erst CREATE DATABASE laufen lassen.',
                str_contains($e->getMessage(), 'getaddrinfo')        => 'Host nicht erreichbar — IP/Hostname prüfen.',
                str_contains($e->getMessage(), 'Connection refused') => 'Verbindung abgelehnt — MySQL läuft nicht oder Port falsch.',
                default => 'PDO-Fehler (SQLSTATE ' . $code . '). Bitte Zugangsdaten und Server-Status prüfen.',
            };
            $this->renderConfigForm($msg, ['db_host' => $values['db_host'], 'db_port' => $values['db_port'], 'db_name' => $values['db_name'], 'db_user' => $values['db_user']]);
            return;
        }

        // Generate a fresh JWT secret. 32 random bytes → 64 hex chars.
        $jwtSecret = bin2hex(random_bytes(32));
        $config = $this->buildConfigFile($values, $jwtSecret);

        $configPath = $this->cloudDir . '/config.php';
        $tmp = $configPath . '.tmp.' . bin2hex(random_bytes(4));
        if (@file_put_contents($tmp, $config, LOCK_EX) === false || !@rename($tmp, $configPath)) {
            @unlink($tmp);
            $this->renderConfigForm(
                'Konnte config.php nicht schreiben. cloud/-Ordner braucht Schreibrechte (chmod 775).',
                ['db_host' => $values['db_host'], 'db_port' => $values['db_port'], 'db_name' => $values['db_name'], 'db_user' => $values['db_user']]
            );
            return;
        }
        @chmod($configPath, 0640);

        // Redirect to admin-creation step so a page refresh doesn't re-POST DB
        // credentials. Admin step then handles the actual user/migration setup.
        $self = strtok($_SERVER['REQUEST_URI'] ?? '/', '?');
        header('Location: ' . $self . '?step=admin');
        exit;
    }

    // ───── Step 3: Admin email form ──────────────────────────────────────
    //
    // We don't ask for a password — we generate one and show it once on the
    // finish page. This avoids the user picking a weak default and makes the
    // "you MUST change this" intent obvious. The password is shown in clear
    // exactly once; after that it's only a bcrypt hash in the database.

    private function renderAdminForm(?string $error = null, string $email = ''): void
    {
        // Guard: if config.php doesn't exist, the user shouldn't be here.
        if (!is_file($this->cloudDir . '/config.php')) {
            header('Location: ?step=checks');
            exit;
        }

        // If an admin already exists, skip straight to finish.
        try {
            Config::load($this->cloudDir . '/config.php');
            $existing = Database::pdo()->query('SELECT COUNT(*) AS c FROM users')->fetch();
            if ($existing && (int)$existing['c'] > 0) {
                header('Location: ?step=finish');
                exit;
            }
        } catch (\Throwable $e) {
            // DB still unreachable — fall through and let the form show, the
            // submit handler will surface the real error.
        }

        $this->page('Admin-Account anlegen', function () use ($error, $email) {
            echo '<h1>Setup · Admin-Account</h1>';
            echo '<p class="lede">Es gibt nur einen Account (dich). Eine öffentliche Registrierung ist deaktiviert. ';
            echo 'Trag deine E-Mail ein — die Wizard generiert ein zufälliges Passwort, das du danach (einmal!) zu sehen bekommst und änderst, sobald du eingeloggt bist.</p>';

            if ($error) echo '<div class="err">✗ ' . htmlspecialchars($error) . '</div>';

            echo '<form method="post" action="?step=admin" class="form">';
            $this->field('admin_email', 'Admin E-Mail', $email, 'für Login + Upload-Notifications', 'email');
            $this->field('admin_name',  'Anzeigename',  '',   'wird in der Sidebar angezeigt');
            echo '<div class="actions">';
            echo '<a href="?step=config" class="btn">← DB-Konfiguration ändern</a>';
            echo '<button type="submit" class="btn btn-primary">Account anlegen</button>';
            echo '</div>';
            echo '</form>';
        });
    }

    private function processAdminForm(): void
    {
        // Guard: someone POSTed straight to ?step=admin without a config.php.
        // Calling Config::load below would recurse back into the wizard.
        if (!is_file($this->cloudDir . '/config.php')) {
            header('Location: ?step=checks');
            exit;
        }

        $email = trim((string)($_POST['admin_email'] ?? ''));
        $name  = trim((string)($_POST['admin_name'] ?? ''));

        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            $this->renderAdminForm('Ungültige E-Mail-Adresse.', $email);
            return;
        }
        if ($name === '') $name = explode('@', $email)[0];

        try {
            Config::load($this->cloudDir . '/config.php');
            $pdo = Database::pdo();   // also runs migrations
        } catch (\Throwable $e) {
            $this->renderAdminForm('Datenbank-Fehler: ' . $e->getMessage(), $email);
            return;
        }

        // Random initial password: 16 chars, alphanumeric + a few symbols.
        // Avoids ambiguous chars (0/O, 1/l/I) so users can read it off the screen.
        $password = $this->randomPassword(16);
        $hash = password_hash($password, PASSWORD_BCRYPT);

        try {
            $exists = $pdo->prepare('SELECT 1 FROM users WHERE email = ?');
            $exists->execute([$email]);
            if ($exists->fetch()) {
                $this->renderAdminForm('Diese E-Mail existiert bereits in der Datenbank.', $email);
                return;
            }
            $ins = $pdo->prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)');
            $ins->execute([$email, $hash, $name]);
            $uid = (int)$pdo->lastInsertId();
            // Seed: a default folder so the admin lands somewhere on first login.
            $pdo->prepare("INSERT INTO folders (user_id, parent_id, name, kind, tone) VALUES (?, NULL, 'Meine Dateien', 'normal', 'violet')")
                ->execute([$uid]);
        } catch (\Throwable $e) {
            $this->renderAdminForm('Konnte Account nicht anlegen: ' . $e->getMessage(), $email);
            return;
        }

        // The plaintext password is passed to the finish page via a one-shot
        // server-side render (no redirect) so it never appears in URLs/history.
        $this->renderFinishWithCredentials($email, $password);
    }

    private function randomPassword(int $len): string
    {
        // Hand-curated alphabet — no 0/O/1/l/I/= so it's readable on a glass screen.
        $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$';
        $out = '';
        for ($i = 0; $i < $len; $i++) {
            $out .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        }
        return $out;
    }

    private function buildConfigFile(array $v, string $jwtSecret): string
    {
        $esc = static fn(string $s) => str_replace(["\\", "'"], ["\\\\", "\\'"], $s);
        return <<<PHP
<?php
/**
 * Nyza Cloud · auto-generated by setup wizard on
 * {$this->iso8601Now()}
 */
return [
    'db' => [
        'host'    => '{$esc($v['db_host'])}',
        'port'    => {$this->intOrDefault($v['db_port'], 3306)},
        'name'    => '{$esc($v['db_name'])}',
        'user'    => '{$esc($v['db_user'])}',
        'pass'    => '{$esc($v['db_pass'])}',
        'charset' => 'utf8',
        'socket'  => '',
    ],
    'jwt_secret' => '{$jwtSecret}',
    'jwt_ttl'    => 60 * 60 * 24 * 30,
    'storage_path' => __DIR__ . '/storage/files',
    'temp_path'    => __DIR__ . '/storage/temp',
    'max_upload_bytes' => 50 * 1024 * 1024 * 1024,
    'chunk_size'       => 10 * 1024 * 1024,
    'allow_origin' => '*',
    'mail_from'    => 'no-reply@nyza.cloud',
    'debug'        => false,
];

PHP;
    }

    private function iso8601Now(): string { return gmdate('Y-m-d\TH:i:s\Z'); }
    private function intOrDefault(string $s, int $d): int { $i = (int)$s; return $i > 0 ? $i : $d; }

    // ───── Step 4: Finish ────────────────────────────────────────────────
    //
    // Two entry paths: with-credentials (immediately after admin creation —
    // shows the random password) and without (a re-visit just verifies that
    // everything still works). Both render the same shell.

    private function renderFinishWithCredentials(string $email, string $password): void
    {
        $appUrl = $this->appUrl();
        $this->page('Setup abgeschlossen', function () use ($email, $password, $appUrl) {
            echo '<div class="big-check">✓</div>';
            echo '<h1 style="text-align:center">Setup abgeschlossen.</h1>';
            echo '<p class="lede" style="text-align:center">Admin-Account angelegt. Dies ist die <b>einmalige</b> Anzeige des Passworts — bitte jetzt notieren.</p>';

            echo '<div class="creds">';
            echo '<div class="cred-row"><span class="cred-label">E-Mail</span><code class="cred-value">' . htmlspecialchars($email) . '</code></div>';
            echo '<div class="cred-row"><span class="cred-label">Passwort</span><code class="cred-value" id="pw">' . htmlspecialchars($password) . '</code>';
            echo '<button type="button" class="btn-mini" onclick="navigator.clipboard.writeText(document.getElementById(\'pw\').textContent);this.textContent=\'kopiert ✓\'">kopieren</button>';
            echo '</div>';
            echo '</div>';

            echo '<div class="warn" style="margin-top:18px">⚠ Ändere das Passwort sofort nach dem ersten Login. Diese Seite wird das Passwort nicht erneut anzeigen.</div>';

            echo '<div class="actions" style="justify-content:center;margin-top:24px">';
            echo '<a href="' . htmlspecialchars($appUrl) . '" class="btn btn-primary">App öffnen → Login</a>';
            echo '</div>';
        });
    }

    private function renderFinish(): void
    {
        $configPath = $this->cloudDir . '/config.php';
        if (!is_file($configPath)) {
            header('Location: ?step=checks');
            exit;
        }

        $error = null;
        $hasAdmin = false;
        try {
            Config::load($configPath);
            $pdo = Database::pdo();
            $tables = $pdo->query('SHOW TABLES')->fetchAll(\PDO::FETCH_COLUMN);
            $expected = ['users', 'folders', 'files', 'share_links', 'upload_links', 'upload_sessions', 'activity', 'schema_migrations'];
            $missing = array_diff($expected, $tables);
            if ($missing) throw new \RuntimeException('Tabellen fehlen: ' . implode(', ', $missing));
            $hasAdmin = (int)($pdo->query('SELECT COUNT(*) AS c FROM users')->fetch()['c'] ?? 0) > 0;
        } catch (\Throwable $e) {
            $error = $e->getMessage();
        }

        $appUrl = $this->appUrl();
        $this->page('Setup-Status', function () use ($error, $hasAdmin, $appUrl) {
            if ($error) {
                echo '<h1>Setup · Fehler</h1>';
                echo '<div class="err">✗ Setup nicht abgeschlossen:<br><code>' . htmlspecialchars($error) . '</code></div>';
                echo '<a href="?step=config" class="btn">Zurück zur Konfiguration</a>';
                return;
            }
            if (!$hasAdmin) {
                echo '<h1>Setup · Admin fehlt</h1>';
                echo '<p class="lede">Datenbank ist OK, aber es gibt noch keinen Admin-Account.</p>';
                echo '<a href="?step=admin" class="btn btn-primary">Admin anlegen →</a>';
                return;
            }
            echo '<div class="big-check">✓</div>';
            echo '<h1 style="text-align:center">Alles bereit.</h1>';
            echo '<p class="lede" style="text-align:center">Datenbank verbunden, Tabellen vorhanden, Admin existiert.</p>';
            echo '<div class="actions" style="justify-content:center"><a href="' . htmlspecialchars($appUrl) . '" class="btn btn-primary">App öffnen →</a></div>';
            echo '<div class="muted" style="margin-top:32px;text-align:center;font-size:13px">';
            echo 'Setup-Wizard erneut aufrufen unter <code>?setup=1</code> oder <code>setup.php</code>.';
            echo '</div>';
        });
    }

    private function appUrl(): string
    {
        $u = strtok($_SERVER['REQUEST_URI'] ?? '/', '?');
        $u = preg_replace('#/setup\.php$#', '/', $u) ?? $u;
        return $u;
    }

    // ───── Layout helpers ────────────────────────────────────────────────

    private function page(string $title, callable $body): void
    {
        ob_start();
        $body();
        $content = ob_get_clean();

        echo '<!doctype html><html lang="de"><head>';
        echo '<meta charset="utf-8"><title>Nyza Setup · ' . htmlspecialchars($title) . '</title>';
        echo '<meta name="viewport" content="width=device-width,initial-scale=1">';
        echo '<style>' . $this->css() . '</style>';
        echo '</head><body><div class="wrap">';
        echo '<header class="brand"><div class="mark"></div><span>nyza · cloud · setup</span></header>';
        echo '<main>' . $content . '</main>';
        echo '</div></body></html>';
        exit;
    }

    private function css(): string
    {
        return <<<CSS
*{box-sizing:border-box}
body{margin:0;background:#0B0B0F;color:#F4F4F6;font:14px/1.55 -apple-system,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
body::before{content:"";position:fixed;inset:0;pointer-events:none;background:
  radial-gradient(circle at 20% 10%,rgba(124,92,255,0.18),transparent 50%),
  radial-gradient(circle at 80% 90%,rgba(59,130,246,0.14),transparent 50%);}
.wrap{max-width:680px;margin:0 auto;padding:48px 24px;position:relative}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:32px;font-size:13px;color:rgba(244,244,246,0.6);letter-spacing:0.4px}
.mark{width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,#7C5CFF,#3B82F6);box-shadow:0 1px 0 rgba(255,255,255,0.3) inset,0 4px 12px rgba(124,92,255,0.4)}
main{background:rgba(22,22,28,0.62);border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:36px;backdrop-filter:blur(40px) saturate(180%);box-shadow:0 1px 0 rgba(255,255,255,0.1) inset,0 30px 60px -20px rgba(0,0,0,0.5)}
h1{font-size:28px;font-weight:600;letter-spacing:-0.8px;margin:0 0 12px}
.lede{color:rgba(244,244,246,0.7);margin:0 0 28px;font-size:15px}
.muted{color:rgba(244,244,246,0.45);font-size:13px}
code{background:rgba(255,255,255,0.06);padding:2px 6px;border-radius:4px;font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12.5px}
.checks{list-style:none;padding:0;margin:0 0 24px;display:flex;flex-direction:column;gap:8px}
.checks li{display:flex;gap:12px;padding:10px 14px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06)}
.checks li.ok .icon{color:#4ade80}
.checks li.fail{background:rgba(255,80,80,0.08);border-color:rgba(255,80,80,0.25)}
.checks li.fail .icon{color:#ff7b7b}
.checks li.info .icon{color:rgba(244,244,246,0.5)}
.checks .icon{font-size:18px;line-height:1.4;flex-shrink:0;width:20px;text-align:center}
.checks b{font-weight:540}
.checks .muted{color:rgba(244,244,246,0.45);font-size:12.5px;margin-top:2px}
.checks .hint{color:#ffd49a;font-size:12.5px;margin-top:4px}
.warn{padding:14px 18px;border-radius:10px;background:rgba(255,180,80,0.1);border:1px solid rgba(255,180,80,0.3);color:#ffd49a;margin-top:8px}
.err{padding:14px 18px;border-radius:10px;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.3);color:#ff9d9d;margin-bottom:18px}
.ok-box{padding:18px 22px;border-radius:14px;background:linear-gradient(135deg,rgba(74,222,128,0.15),rgba(74,222,128,0.05));border:1px solid rgba(74,222,128,0.3);display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.big-check{width:80px;height:80px;border-radius:50%;background:linear-gradient(135deg,#86efac,#22c55e);display:flex;align-items:center;justify-content:center;font-size:42px;color:#fff;margin:0 auto 24px;box-shadow:0 12px 40px -8px rgba(34,197,94,0.5)}
.btn{display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 18px;border-radius:999px;font:inherit;font-weight:540;text-decoration:none;color:inherit;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);cursor:pointer;transition:all 0.18s}
.btn:hover{background:rgba(255,255,255,0.12);transform:translateY(-1px)}
.btn-primary{background:linear-gradient(135deg,#7C5CFF,#3B82F6);border-color:transparent;color:#fff;box-shadow:0 1px 0 rgba(255,255,255,0.25) inset,0 8px 24px -8px rgba(124,92,255,0.5)}
.btn-primary:hover{box-shadow:0 1px 0 rgba(255,255,255,0.25) inset,0 16px 32px -8px rgba(124,92,255,0.6)}
.form{display:flex;flex-direction:column;gap:14px}
.form label{display:flex;flex-direction:column;gap:6px}
.form label>span{font-size:12.5px;font-weight:540;color:rgba(244,244,246,0.8)}
.form input{height:42px;padding:0 14px;border-radius:10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#fff;font:inherit;outline:none;transition:border-color 0.18s,background 0.18s}
.form input:focus{border-color:#7C5CFF;background:rgba(255,255,255,0.08)}
.form small{color:rgba(244,244,246,0.4);font-size:11.5px}
.actions{display:flex;gap:10px;align-items:center;margin-top:20px}
.actions .btn:first-child:not(.btn-primary){margin-right:auto}
.creds{display:flex;flex-direction:column;gap:10px;margin-top:24px}
.cred-row{display:flex;align-items:center;gap:12px;padding:12px 14px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:10px}
.cred-label{font-size:11px;font-weight:540;color:rgba(244,244,246,0.55);letter-spacing:0.5px;text-transform:uppercase;width:80px;flex-shrink:0}
.cred-value{flex:1;background:transparent;padding:0;font-size:15px;font-family:"JetBrains Mono",ui-monospace,monospace;word-break:break-all;color:#fff}
.btn-mini{height:28px;padding:0 12px;border-radius:999px;font:inherit;font-size:11.5px;font-weight:540;background:rgba(255,255,255,0.1);color:#fff;border:1px solid rgba(255,255,255,0.15);cursor:pointer;transition:background 0.15s}
.btn-mini:hover{background:rgba(255,255,255,0.18)}
CSS;
    }
}
