<?php
declare(strict_types=1);

namespace Nyza;

use PHPMailer\PHPMailer\PHPMailer;

/**
 * Sends mail via SMTP (PHPMailer) when SMTP_HOST is configured, otherwise
 * falls back to PHP mail(). All failures are swallowed → return false; callers
 * treat mail as best-effort.
 */
final class Mailer
{
    public static function send(string $to, string $subject, string $body, ?string $replyTo = null, ?string $replyName = null): bool
    {
        $from     = getenv('MAIL_FROM') ?: 'no-reply@nyza.cloud';
        $fromName = getenv('MAIL_FROM_NAME') ?: 'Nyza Cloud';
        $host     = getenv('SMTP_HOST') ?: '';

        if ($host !== '') {
            try {
                $m = new PHPMailer(true);
                $m->isSMTP();
                $m->Host = $host;
                $m->Port = (int)(getenv('SMTP_PORT') ?: 587);
                $user = getenv('SMTP_USER') ?: '';
                if ($user !== '') {
                    $m->SMTPAuth = true;
                    $m->Username = $user;
                    $m->Password = getenv('SMTP_PASS') ?: '';
                }
                $sec = strtolower((string)(getenv('SMTP_SECURE') ?: 'tls'));
                if ($sec === 'ssl') {
                    $m->SMTPSecure = PHPMailer::ENCRYPTION_SMTPS;
                } elseif ($sec === 'tls') {
                    $m->SMTPSecure = PHPMailer::ENCRYPTION_STARTTLS;
                } // 'none' → no encryption
                $m->CharSet = 'UTF-8';
                $m->setFrom($from, $fromName);
                $m->addAddress($to);
                if ($replyTo) $m->addReplyTo($replyTo, $replyName ?: '');
                $m->Subject = $subject;
                $m->Body = $body;
                $m->send();
                return true;
            } catch (\Throwable $e) {
                return false;
            }
        }

        $headers = "From: $fromName <$from>\r\n"
                 . ($replyTo ? "Reply-To: $replyTo\r\n" : '')
                 . "Content-Type: text/plain; charset=utf-8\r\n";
        return @mail($to, $subject, $body, $headers);
    }
}
