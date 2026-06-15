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
        // Default = legacy utf8 (3-byte). Schema is also utf8 so this matches.
        // Hosters with full utf8mb4 can override via config['db']['charset'].
        $charset = getenv('DB_CHARSET') ?: 'utf8';
        $socket  = getenv('DB_SOCKET') ?: '';

        // Pick a collation that exists on whatever charset is configured.
        // utf8mb4_0900_ai_ci is MySQL 8.0+ only; utf8_unicode_ci is the safe
        // default that works on MySQL 5.5+/MariaDB 10+ regardless of edition.
        $collation = $charset === 'utf8mb4' ? 'utf8mb4_unicode_ci' : 'utf8_unicode_ci';

        $dsn = $socket
            ? "mysql:unix_socket={$socket};dbname={$name};charset={$charset}"
            : "mysql:host={$host};port={$port};dbname={$name};charset={$charset}";

        try {
            $pdo = new PDO($dsn, $user, $pass, [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES   => false,
                PDO::MYSQL_ATTR_INIT_COMMAND => "SET NAMES {$charset} COLLATE {$collation}, "
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
        // No charset/collate clause — picks up the database's defaults, which
        // line up with whatever charset Database::pdo() configured at connect.
        $pdo->exec(
            'CREATE TABLE IF NOT EXISTS schema_migrations ('
            . '  version VARCHAR(64) NOT NULL PRIMARY KEY,'
            . '  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP'
            . ') ENGINE=InnoDB'
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

            // NOTE: no transaction wrapping. MySQL issues an *implicit commit*
            // before every DDL statement (CREATE TABLE, ALTER TABLE, …), so a
            // beginTransaction()/commit() pair around DDL is meaningless — the
            // first CREATE TABLE silently ends the transaction, and the final
            // commit() then throws "There is no active transaction". DDL simply
            // can't be rolled back on MySQL. If a statement fails mid-file the
            // schema is left partially built; the setup wizard's "DB
            // zurücksetzen" button exists precisely to recover from that.
            try {
                foreach ($stmts as $s) {
                    // Strip any combination of leading whitespace, blank lines,
                    // and `--`-comment lines so a statement preceded by
                    // explanatory comments still runs. Stops at the first
                    // line that isn't whitespace and doesn't start with `--`.
                    // Mid-statement comments are valid SQL and stay untouched.
                    $s = preg_replace('/^\s*(?:--[^\n]*\R\s*)*/', '', $s);
                    $s = trim($s);
                    if ($s === '') continue;
                    $pdo->exec($s);
                }
                $pdo->prepare('INSERT INTO schema_migrations (version) VALUES (?)')->execute([$version]);
            } catch (\Throwable $e) {
                throw new \RuntimeException("Migration $version failed: " . $e->getMessage(), 0, $e);
            }
        }
    }
}
