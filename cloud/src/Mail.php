<?php
declare(strict_types=1);

namespace Nyza;

use PHPMailer\PHPMailer\PHPMailer;

/**
 * Mail access for a mailbox row: IMAP receive (requires the php-imap extension)
 * and SMTP send (PHPMailer, always available). Credentials are decrypted via
 * Crypto on demand and never leave the server.
 */
final class Mail
{
    public static function imapAvailable(): bool
    {
        return function_exists('imap_open');
    }

    // ───── IMAP ────────────────────────────────────────────────────────────────
    private static function imapRef(array $mb, string $folder = 'INBOX'): string
    {
        $host = (string)$mb['imap_host'];
        $port = (int)$mb['imap_port'] ?: 993;
        $flags = ((int)$mb['imap_ssl'] === 1 ? '/imap/ssl/novalidate-cert' : '/imap/notls');
        return '{' . $host . ':' . $port . $flags . '}' . $folder;
    }

    /** @return resource */
    private static function open(array $mb, string $folder = 'INBOX')
    {
        if (!self::imapAvailable()) throw new \RuntimeException('IMAP nicht verfügbar (php-imap fehlt)', 503);
        // Bound connection/read time so a slow server can never hang the cron.
        @imap_timeout(IMAP_OPENTIMEOUT, 6);
        @imap_timeout(IMAP_READTIMEOUT, 10);
        $pass = Crypto::decrypt($mb['imap_pass_enc'] ?? '');
        $stream = @imap_open(self::imapRef($mb, $folder), (string)$mb['imap_user'], $pass, 0, 1);
        if (!$stream) throw new \RuntimeException('IMAP-Login fehlgeschlagen: ' . imap_last_error(), 502);
        return $stream;
    }

    public static function listMessages(array $mb, int $limit = 30): array
    {
        $stream = self::open($mb);
        try {
            $uids = @imap_sort($stream, SORTDATE, 1, SE_UID) ?: [];
            $uids = array_slice($uids, 0, $limit);
            $out = [];
            foreach ($uids as $uid) {
                $ov = imap_fetch_overview($stream, (string)$uid, FT_UID);
                if (!$ov || !isset($ov[0])) continue;
                $o = $ov[0];
                $struct = @imap_fetchstructure($stream, (int)$uid, FT_UID);
                $out[] = [
                    'uid'         => (int)$uid,
                    'subject'     => self::decodeText($o->subject ?? '(kein Betreff)'),
                    'from'        => self::decodeText($o->from ?? ''),
                    'date'        => isset($o->date) ? date('Y-m-d H:i', strtotime($o->date)) : '',
                    'seen'        => !empty($o->seen),
                    'attachments' => $struct ? self::countAttachments($struct) : 0,
                ];
            }
            return $out;
        } finally { imap_close($stream); }
    }

    public static function readMessage(array $mb, int $uid): array
    {
        $stream = self::open($mb);
        try {
            $ov = imap_fetch_overview($stream, (string)$uid, FT_UID);
            $o = $ov[0] ?? null;
            $struct = imap_fetchstructure($stream, $uid, FT_UID);
            $text = ''; $atts = [];
            if ($struct) self::walk($stream, $uid, $struct, '', $text, $atts);
            @imap_setflag_full($stream, (string)$uid, '\\Seen', ST_UID);
            return [
                'uid'     => $uid,
                'subject' => self::decodeText($o->subject ?? ''),
                'from'    => self::decodeText($o->from ?? ''),
                'to'      => self::decodeText($o->to ?? ''),
                'date'    => isset($o->date) ? date('Y-m-d H:i', strtotime($o->date)) : '',
                'body'    => $text,
                'attachments' => array_map(static fn($a) => ['part' => $a['part'], 'name' => $a['name'], 'mime' => $a['mime'], 'size' => $a['size']], $atts),
            ];
        } finally { imap_close($stream); }
    }

    /** @return array{name:string,mime:string,data:string}|null */
    public static function fetchAttachment(array $mb, int $uid, string $part): ?array
    {
        $stream = self::open($mb);
        try {
            $struct = imap_fetchstructure($stream, $uid, FT_UID);
            $text = ''; $atts = [];
            if ($struct) self::walk($stream, $uid, $struct, '', $text, $atts);
            foreach ($atts as $a) {
                if ($a['part'] === $part) {
                    return ['name' => $a['name'], 'mime' => $a['mime'], 'data' => $a['data']];
                }
            }
            return null;
        } finally { imap_close($stream); }
    }

    /** New attachments (PDF/image) since the last seen UID — for Belege import. */
    public static function fetchBelegeAttachments(array $mb): array
    {
        $stream = self::open($mb);
        try {
            $sinceUid = (int)($mb['belege_seen_uid'] ?? 0);
            // Newest first; only inspect a bounded window so a huge inbox (or the
            // very first run with sinceUid=0) can never time out the cron.
            $uids = @imap_sort($stream, SORTDATE, 1, SE_UID) ?: [];
            $uids = array_slice($uids, 0, 30);
            $maxUid = $sinceUid;
            $found = [];
            foreach ($uids as $uid) {
                $uid = (int)$uid;
                if ($uid > $maxUid) $maxUid = $uid;
                if ($uid <= $sinceUid) continue;
                $struct = @imap_fetchstructure($stream, $uid, FT_UID);
                if (!$struct || self::countAttachments($struct) === 0) continue; // cheap skip
                $text = ''; $atts = [];
                self::walk($stream, $uid, $struct, '', $text, $atts);
                $ov = imap_fetch_overview($stream, (string)$uid, FT_UID);
                $from = self::decodeText($ov[0]->from ?? '');
                foreach ($atts as $a) {
                    $m = strtolower($a['mime']);
                    if (str_contains($m, 'pdf') || str_starts_with($m, 'image/')) {
                        $found[] = ['uid' => $uid, 'name' => $a['name'], 'mime' => $a['mime'], 'data' => $a['data'], 'from' => $from];
                        if (count($found) >= 20) return ['attachments' => $found, 'max_uid' => $maxUid];
                    }
                }
            }
            return ['attachments' => $found, 'max_uid' => $maxUid];
        } finally { imap_close($stream); }
    }

    // Recursive MIME walker → accumulates plain text and attachment parts.
    private static function walk($stream, int $uid, $struct, string $prefix, string &$text, array &$atts): void
    {
        if (isset($struct->parts) && $struct->parts) {
            foreach ($struct->parts as $i => $part) {
                $pn = $prefix === '' ? (string)($i + 1) : $prefix . '.' . ($i + 1);
                self::walkPart($stream, $uid, $part, $pn, $text, $atts);
            }
        } else {
            self::walkPart($stream, $uid, $struct, '1', $text, $atts);
        }
    }

    private static function walkPart($stream, int $uid, $part, string $pn, string &$text, array &$atts): void
    {
        if (isset($part->parts) && $part->parts) {
            foreach ($part->parts as $i => $sub) {
                self::walkPart($stream, $uid, $sub, $pn . '.' . ($i + 1), $text, $atts);
            }
            return;
        }
        $name = '';
        foreach (array_merge((array)($part->dparameters ?? []), (array)($part->parameters ?? [])) as $p) {
            if (in_array(strtolower($p->attribute), ['name', 'filename'], true) && $p->value) $name = self::decodeText($p->value);
        }
        $disp = strtolower((string)($part->disposition ?? ''));
        $isAttachment = $disp === 'attachment' || ($name !== '' && $disp !== 'inline');
        $mime = self::mimeOf($part);

        if (!$isAttachment && ($mime === 'text/plain' || $mime === 'text/html')) {
            $raw = imap_fetchbody($stream, $uid, $pn, FT_UID);
            $body = self::decodeBody($raw, (int)($part->encoding ?? 0));
            $body = self::toUtf8($body, self::charsetOf($part));
            if ($mime === 'text/html') $body = trim(html_entity_decode(strip_tags(preg_replace('#<(br|/p|/div)[^>]*>#i', "\n", $body)), ENT_QUOTES));
            if (trim($body) !== '') $text .= ($text !== '' ? "\n\n" : '') . $body;
            return;
        }
        if ($isAttachment || $mime === 'application/pdf' || str_starts_with($mime, 'image/')) {
            $raw = imap_fetchbody($stream, $uid, $pn, FT_UID);
            $data = self::decodeBody($raw, (int)($part->encoding ?? 0));
            $atts[] = ['part' => $pn, 'name' => $name ?: ('anhang-' . $pn), 'mime' => $mime, 'size' => strlen($data), 'data' => $data];
        }
    }

    private static function countAttachments($struct): int
    {
        $text = ''; $atts = [];
        // light walk without a stream: only structure-based detection
        $count = 0;
        $scan = function ($p) use (&$scan, &$count) {
            if (isset($p->parts) && $p->parts) { foreach ($p->parts as $s) $scan($s); return; }
            $disp = strtolower((string)($p->disposition ?? ''));
            $hasName = false;
            foreach (array_merge((array)($p->dparameters ?? []), (array)($p->parameters ?? [])) as $pp) {
                if (in_array(strtolower($pp->attribute), ['name', 'filename'], true)) $hasName = true;
            }
            if ($disp === 'attachment' || ($hasName && $disp !== 'inline')) $count++;
        };
        if (isset($struct->parts) && $struct->parts) foreach ($struct->parts as $s) $scan($s);
        return $count;
    }

    private static function mimeOf($part): string
    {
        $types = ['text', 'multipart', 'message', 'application', 'audio', 'image', 'video', 'model', 'other'];
        $primary = $types[$part->type ?? 0] ?? 'application';
        $sub = strtolower((string)($part->subtype ?? 'octet-stream'));
        return $primary . '/' . $sub;
    }

    private static function charsetOf($part): string
    {
        foreach ((array)($part->parameters ?? []) as $p) {
            if (strtolower($p->attribute) === 'charset') return (string)$p->value;
        }
        return 'UTF-8';
    }

    private static function decodeBody(string $raw, int $encoding): string
    {
        switch ($encoding) {
            case 3: return base64_decode($raw) ?: '';      // BASE64
            case 4: return quoted_printable_decode($raw);  // QUOTED-PRINTABLE
            default: return $raw;
        }
    }

    private static function toUtf8(string $s, string $charset): string
    {
        $charset = strtoupper(trim($charset));
        if ($charset === '' || $charset === 'UTF-8' || $charset === 'US-ASCII') return $s;
        $conv = @mb_convert_encoding($s, 'UTF-8', $charset);
        return $conv !== false ? $conv : $s;
    }

    private static function decodeText($s): string
    {
        $s = (string)$s;
        if ($s === '') return '';
        $out = '';
        foreach (imap_mime_header_decode($s) as $part) {
            $cs = strtoupper($part->charset);
            $txt = $part->text;
            if ($cs !== 'DEFAULT' && $cs !== 'UTF-8') $txt = @mb_convert_encoding($txt, 'UTF-8', $cs) ?: $txt;
            $out .= $txt;
        }
        return $out;
    }

    // ───── SMTP send ────────────────────────────────────────────────────────────
    public static function send(array $mb, array $msg): void
    {
        $m = new PHPMailer(true);
        $m->isSMTP();
        $m->Host = (string)$mb['smtp_host'];
        $m->Port = (int)$mb['smtp_port'] ?: 587;
        $m->SMTPAuth = true;
        $m->Username = (string)($mb['smtp_user'] ?: $mb['email']);
        $m->Password = Crypto::decrypt($mb['smtp_pass_enc'] ?? '');
        $secure = strtolower((string)$mb['smtp_secure']);
        if ($secure === 'ssl') $m->SMTPSecure = PHPMailer::ENCRYPTION_SMTPS;
        elseif ($secure === 'tls') $m->SMTPSecure = PHPMailer::ENCRYPTION_STARTTLS;
        else { $m->SMTPSecure = false; $m->SMTPAutoTLS = false; }
        $m->CharSet = 'UTF-8';
        $m->setFrom((string)$mb['email'], (string)($mb['from_name'] ?: $mb['name']));
        foreach (self::addrs($msg['to'] ?? '') as $a) $m->addAddress($a);
        foreach (self::addrs($msg['cc'] ?? '') as $a) $m->addCC($a);
        $m->Subject = (string)($msg['subject'] ?? '');
        $m->Body = (string)($msg['body'] ?? '');
        $m->isHTML(false);
        foreach ((array)($msg['attachments'] ?? []) as $a) {
            if (!empty($a['data'])) $m->addStringAttachment($a['data'], (string)($a['name'] ?? 'anhang'), 'base64', (string)($a['mime'] ?? 'application/octet-stream'));
        }
        $m->send();
    }

    private static function addrs($v): array
    {
        if (is_array($v)) return array_filter(array_map('trim', $v));
        return array_values(array_filter(array_map('trim', preg_split('/[,;]+/', (string)$v) ?: [])));
    }
}
