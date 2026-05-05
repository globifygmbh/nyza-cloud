<?php
declare(strict_types=1);

namespace Nyza;

/**
 * Liest config.php beim ersten Zugriff. Stellt $config-Werte als Env-Variablen
 * zur Verfügung, damit existierender Code (Database, Auth, etc.) der getenv()
 * nutzt, ohne Änderung weiterläuft.
 */
final class Config
{
    private static ?array $cfg = null;

    public static function load(string $path): void
    {
        if (!file_exists($path)) {
            // Hand off to the setup wizard. It runs without DB and writes
            // config.php on success, then sends the user to the admin step.
            (new SetupWizard(dirname($path)))->handle();
            exit;
        }
        $cfg = require $path;
        if (!is_array($cfg)) {
            throw new \RuntimeException('config.php must return an array');
        }
        self::$cfg = $cfg;

        // Map config → env so existing code (Database.php, Auth.php, …) keeps working.
        $db = $cfg['db'] ?? [];
        putenv('DB_HOST=' . ($db['host'] ?? '127.0.0.1'));
        putenv('DB_PORT=' . ($db['port'] ?? 3306));
        putenv('DB_NAME=' . ($db['name'] ?? 'nyza'));
        putenv('DB_USER=' . ($db['user'] ?? 'root'));
        putenv('DB_PASS=' . ($db['pass'] ?? ''));
        putenv('DB_CHARSET=' . ($db['charset'] ?? 'utf8'));
        putenv('DB_SOCKET=' . ($db['socket'] ?? ''));

        putenv('JWT_SECRET=' . ($cfg['jwt_secret'] ?? ''));
        putenv('JWT_TTL=' . ($cfg['jwt_ttl'] ?? 2592000));

        putenv('STORAGE_PATH=' . ($cfg['storage_path'] ?? __DIR__ . '/../storage/files'));
        putenv('TEMP_PATH=' . ($cfg['temp_path'] ?? __DIR__ . '/../storage/temp'));

        putenv('MAX_UPLOAD_BYTES=' . ($cfg['max_upload_bytes'] ?? 53687091200));
        putenv('CHUNK_SIZE=' . ($cfg['chunk_size'] ?? 10485760));

        putenv('ALLOW_ORIGIN=' . ($cfg['allow_origin'] ?? '*'));
        putenv('MAIL_FROM=' . ($cfg['mail_from'] ?? 'no-reply@nyza.cloud'));
        putenv('APP_DEBUG=' . (!empty($cfg['debug']) ? '1' : ''));
    }

    public static function get(string $key, $default = null)
    {
        return self::$cfg[$key] ?? $default;
    }

}
