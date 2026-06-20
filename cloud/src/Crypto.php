<?php
declare(strict_types=1);

namespace Nyza;

/**
 * Authenticated symmetric encryption (libsodium secretbox) for secrets at rest
 * — credential vault passwords, mailbox logins, etc. The 32-byte key comes from
 * the NYZA_VAULT_KEY env var (base64) if set, otherwise it is generated once and
 * stored in app_kv. For best security set NYZA_VAULT_KEY so the key lives
 * outside the database.
 */
final class Crypto
{
    public static function encrypt(string $plain): string
    {
        if ($plain === '') return '';
        $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        $cipher = sodium_crypto_secretbox($plain, $nonce, self::key());
        return base64_encode($nonce . $cipher);
    }

    public static function decrypt(?string $enc): string
    {
        if ($enc === null || $enc === '') return '';
        $raw = base64_decode($enc, true);
        if ($raw === false || strlen($raw) <= SODIUM_CRYPTO_SECRETBOX_NONCEBYTES) return '';
        $nonce = substr($raw, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        $cipher = substr($raw, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        $plain = sodium_crypto_secretbox_open($cipher, $nonce, self::key());
        return $plain === false ? '' : $plain;
    }

    private static function key(): string
    {
        static $cached = null;
        if ($cached !== null) return $cached;

        $env = getenv('NYZA_VAULT_KEY');
        if (is_string($env) && $env !== '') {
            $k = base64_decode($env, true);
            if ($k !== false && strlen($k) === SODIUM_CRYPTO_SECRETBOX_KEYBYTES) return $cached = $k;
        }
        $pdo = Database::pdo();
        $s = $pdo->prepare('SELECT v FROM app_kv WHERE k = ?');
        $s->execute(['vault_key']);
        $row = $s->fetch();
        if ($row && $row['v']) {
            $k = base64_decode((string)$row['v'], true);
            if ($k !== false && strlen($k) === SODIUM_CRYPTO_SECRETBOX_KEYBYTES) return $cached = $k;
        }
        $k = random_bytes(SODIUM_CRYPTO_SECRETBOX_KEYBYTES);
        $pdo->prepare('INSERT INTO app_kv (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)')
            ->execute(['vault_key', base64_encode($k)]);
        return $cached = $k;
    }
}
