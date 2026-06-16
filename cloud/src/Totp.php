<?php
declare(strict_types=1);

namespace Nyza;

/**
 * Self-contained TOTP (RFC 6238, HMAC-SHA1, 6 digits, 30s) + RFC 4648 base32.
 * Compatible with Google Authenticator, Authy, 1Password, etc. No dependencies.
 */
final class Totp
{
    private const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    /** New random base32 secret (20 bytes → 32 chars). */
    public static function secret(int $bytes = 20): string
    {
        return self::base32encode(random_bytes($bytes));
    }

    /** otpauth:// URI for QR codes. */
    public static function uri(string $secret, string $label, string $issuer = 'Nyza Cloud'): string
    {
        return 'otpauth://totp/' . rawurlencode($issuer . ':' . $label)
             . '?secret=' . $secret
             . '&issuer=' . rawurlencode($issuer)
             . '&algorithm=SHA1&digits=6&period=30';
    }

    /** Verify a 6-digit code against the secret, allowing ±$window steps of clock drift. */
    public static function verify(string $code, string $secret, int $window = 1): bool
    {
        $code = preg_replace('/\D/', '', $code);
        if (strlen((string)$code) !== 6) return false;
        $key = self::base32decode($secret);
        if ($key === '') return false;
        $t = (int) floor(time() / 30);
        for ($i = -$window; $i <= $window; $i++) {
            if (hash_equals(self::codeAt($key, $t + $i), $code)) return true;
        }
        return false;
    }

    private static function codeAt(string $key, int $counter): string
    {
        // 8-byte big-endian counter (high word 0 for timesteps < 2^32).
        $bin = pack('N', 0) . pack('N', $counter);
        $hash = hash_hmac('sha1', $bin, $key, true);
        $off = ord($hash[19]) & 0x0f;
        $val = ((ord($hash[$off]) & 0x7f) << 24)
             | ((ord($hash[$off + 1]) & 0xff) << 16)
             | ((ord($hash[$off + 2]) & 0xff) << 8)
             | (ord($hash[$off + 3]) & 0xff);
        return str_pad((string)($val % 1000000), 6, '0', STR_PAD_LEFT);
    }

    public static function base32encode(string $bin): string
    {
        $out = ''; $buf = 0; $bits = 0;
        foreach (str_split($bin) as $ch) {
            $buf = ($buf << 8) | ord($ch); $bits += 8;
            while ($bits >= 5) { $bits -= 5; $out .= self::ALPHABET[($buf >> $bits) & 31]; }
        }
        if ($bits > 0) $out .= self::ALPHABET[($buf << (5 - $bits)) & 31];
        return $out;
    }

    public static function base32decode(string $b32): string
    {
        $b32 = strtoupper(preg_replace('/[^A-Z2-7]/', '', $b32));
        $out = ''; $buf = 0; $bits = 0;
        for ($i = 0, $n = strlen($b32); $i < $n; $i++) {
            $v = strpos(self::ALPHABET, $b32[$i]);
            if ($v === false) continue;
            $buf = ($buf << 5) | $v; $bits += 5;
            if ($bits >= 8) { $bits -= 8; $out .= chr(($buf >> $bits) & 0xff); }
        }
        return $out;
    }
}
