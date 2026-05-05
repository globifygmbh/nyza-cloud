<?php
declare(strict_types=1);

namespace Nyza;

use PDO;

/**
 * MySQL connection (PDO). Auto-runs migrations from migrations/mysql/ on first
 * connect; tracks applied versions in a `schema_migrations` table.
 */
final class Database
{
    private static ?PDO $pdo = null;

    public static function pdo(): PDO
    {
        if (self::$pdo !== null) return self::$pdo;

        $host    = getenv('DB_HOST') ?: '127.0.0.1';
        $port    = (int)(getenv('DB_PORT') ?: 3306);
        $name    = getenv('DB_NAME') ?: 'nyza';
        $user    = getenv('DB_USER') ?: 'root';
        $pass    = getenv('DB_PASS') ?: '';
        $charset = getenv('DB_CHARSET') ?: 'utf8mb4';
        $socket  = getenv('DB_SOCKET') ?: '';

        $dsn = $socket
            ? "mysql:unix_socket={$socket};dbname={$name};charset={$charset}"
            : "mysql:host={$host};port={$port};dbname={$name};charset={$charset}";

        try {
            $pdo = new PDO($dsn, $user, $pass, [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES   => false,
                PDO::MYSQL_ATTR_INIT_COMMAND => "SET NAMES {$charset} COLLATE utf8mb4_0900_ai_ci, "
                                              . "sql_mode='STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION', "
                                              . "time_zone='+00:00'",
            ]);
        } catch (\PDOException $e) {
            throw new \RuntimeException('Could not connect to MySQL: ' . $e->getMessage(), 0, $e);
        }

        self::migrate($pdo);
        return self::$pdo = $pdo;
    }

    public static function migrate(PDO $pdo): void
    {
        $pdo->exec(
            'CREATE TABLE IF NOT EXISTS schema_migrations ('
            . '  version VARCHAR(64) NOT NULL PRIMARY KEY,'
            . '  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP'
            . ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
        );

        $applied = [];
        foreach ($pdo->query('SELECT version FROM schema_migrations')->fetchAll() as $r) {
            $applied[$r['version']] = true;
        }

        $dir = __DIR__ . '/../migrations/mysql';
        $files = glob($dir . '/*.sql') ?: [];
        sort($files);
        foreach ($files as $f) {
            $version = basename($f, '.sql');
            if (isset($applied[$version])) continue;
            $sql = (string) file_get_contents($f);
            // Split on `;` at line ends (between statements). Keeps inline `;`
            // inside string literals intact because we only split on `;` followed
            // by newline.
            $stmts = preg_split('/;\s*\R/', $sql) ?: [];
            $pdo->beginTransaction();
            try {
                foreach ($stmts as $s) {
                    $s = trim($s);
                    if ($s === '' || str_starts_with($s, '--')) continue;
                    $pdo->exec($s);
                }
                $pdo->prepare('INSERT INTO schema_migrations (version) VALUES (?)')->execute([$version]);
                $pdo->commit();
            } catch (\Throwable $e) {
                $pdo->rollBack();
                throw new \RuntimeException("Migration $version failed: " . $e->getMessage(), 0, $e);
            }
        }
    }
}
