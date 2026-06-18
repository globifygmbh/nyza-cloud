<?php
declare(strict_types=1);

namespace Nyza;

/**
 * Receipt OCR. Digital PDFs are read with `pdftotext`; scanned PDFs are
 * rasterised with `pdftoppm` and, like images, run through `tesseract`. The
 * extracted text is parsed with German/Austrian heuristics into expense fields
 * (gross, VAT rate, date, vendor) — no AI credits, fully on the server.
 */
final class Ocr
{
    public static function available(): bool
    {
        return self::which('tesseract') !== null;
    }

    private static function which(string $bin): ?string
    {
        $out = []; $code = 1;
        @exec('command -v ' . escapeshellarg($bin) . ' 2>/dev/null', $out, $code);
        return ($code === 0 && !empty($out[0])) ? trim($out[0]) : null;
    }

    public static function extractText(string $abs, string $mime): string
    {
        $mime = strtolower($mime);
        if (str_contains($mime, 'pdf')) {
            $txt = self::pdfText($abs);
            if (mb_strlen(trim($txt)) >= 25) return $txt;   // digital PDF
            return self::pdfOcr($abs);                       // scanned PDF
        }
        if (str_starts_with($mime, 'image/')) return self::imageOcr($abs);
        return '';
    }

    private static function pdfText(string $abs): string
    {
        if (!self::which('pdftotext')) return '';
        $o = []; $c = 1;
        @exec('pdftotext -layout -q ' . escapeshellarg($abs) . ' - 2>/dev/null', $o, $c);
        return $c === 0 ? implode("\n", $o) : '';
    }

    private static function pdfOcr(string $abs): string
    {
        if (!self::which('pdftoppm') || !self::which('tesseract')) return '';
        $prefix = Storage::temp() . '/ocr_' . bin2hex(random_bytes(6));
        $o = []; $c = 1;
        @exec('pdftoppm -png -r 200 -f 1 -l 3 ' . escapeshellarg($abs) . ' ' . escapeshellarg($prefix) . ' 2>/dev/null', $o, $c);
        $text = '';
        foreach (glob($prefix . '*.png') ?: [] as $img) {
            $text .= self::imageOcr($img) . "\n";
            @unlink($img);
        }
        return $text;
    }

    private static function imageOcr(string $abs): string
    {
        if (!self::which('tesseract')) return '';
        foreach (['deu+eng', 'eng', ''] as $lang) {
            $o = []; $c = 1;
            $cmd = 'tesseract ' . escapeshellarg($abs) . ' stdout'
                . ($lang !== '' ? ' -l ' . escapeshellarg($lang) : '') . ' 2>/dev/null';
            @exec($cmd, $o, $c);
            if ($c === 0 && !empty($o)) return implode("\n", $o);
        }
        return '';
    }

    // ───── parsing ─────────────────────────────────────────────────────────
    public static function parse(string $text): array
    {
        $rate = self::findRate($text);
        $gross = self::findGross($text);
        $date = self::findDate($text);
        $vendor = self::findVendor($text);
        $net = null;
        if ($gross !== null) {
            $r = $rate ?? 20.0;
            $net = round($gross / (1 + $r / 100), 2);
        }
        return [
            'gross' => $gross,
            'net' => $net,
            'tax_rate' => $rate,
            'date' => $date,
            'vendor' => $vendor,
            'text' => mb_substr(trim($text), 0, 4000),
        ];
    }

    /** Parse a "1.234,56" / "1234.56" money token into a float. */
    private static function money(string $s): ?float
    {
        $s = trim($s);
        if ($s === '') return null;
        $s = preg_replace('/[^\d.,]/', '', $s);
        if ($s === '') return null;
        $hasC = str_contains($s, ','); $hasD = str_contains($s, '.');
        if ($hasC && $hasD) {
            // last separator is the decimal point
            if (strrpos($s, ',') > strrpos($s, '.')) $s = str_replace('.', '', $s);
            else $s = str_replace(',', '', $s);
            $s = str_replace(',', '.', $s);
        } elseif ($hasC) {
            $s = str_replace(',', '.', $s);
        }
        return is_numeric($s) ? (float)$s : null;
    }

    private static function findRate(string $text): ?float
    {
        // Prefer an explicit rate near a VAT keyword, else any "NN %".
        if (preg_match('/(?:USt|MwSt|Mehrwertsteuer|Umsatzsteuer)[^\d%]{0,12}(\d{1,2})\s*%/iu', $text, $m)) {
            $r = (int)$m[1]; if (in_array($r, [20, 19, 13, 10, 7, 0], true)) return (float)$r;
        }
        if (preg_match_all('/\b(20|19|13|10|7)\s*%/u', $text, $m)) {
            $cands = array_map('intval', $m[1]);
            foreach ([20, 19, 13, 10, 7] as $pref) if (in_array($pref, $cands, true)) return (float)$pref;
        }
        return null;
    }

    private static function findGross(string $text): ?float
    {
        $lines = preg_split('/\r?\n/', $text) ?: [];
        $kw = '/(gesamt|summe|total|brutto|zu\s*zahlen|zahlbetrag|rechnungsbetrag|endbetrag|betrag|to\s*pay|amount due)/iu';
        $amt = '/(\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})|\d+,\d{2}|\d+\.\d{2})/';
        $best = null;
        foreach ($lines as $ln) {
            if (!preg_match($kw, $ln)) continue;
            if (preg_match_all($amt, $ln, $mm)) {
                foreach ($mm[1] as $tok) { $v = self::money($tok); if ($v !== null && ($best === null || $v > $best)) $best = $v; }
            }
        }
        if ($best !== null) return $best;
        // Fallback: largest money-looking token in the whole text.
        if (preg_match_all($amt, $text, $mm)) {
            foreach ($mm[1] as $tok) { $v = self::money($tok); if ($v !== null && ($best === null || $v > $best)) $best = $v; }
        }
        return $best;
    }

    private static function findDate(string $text): ?string
    {
        if (preg_match('/\b(\d{4})-(\d{2})-(\d{2})\b/', $text, $m)) return "$m[1]-$m[2]-$m[3]";
        if (preg_match('/\b(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})\b/', $text, $m)) {
            $y = strlen($m[3]) === 2 ? '20' . $m[3] : $m[3];
            $mo = (int)$m[2]; $d = (int)$m[1];
            if ($mo >= 1 && $mo <= 12 && $d >= 1 && $d <= 31) return sprintf('%04d-%02d-%02d', (int)$y, $mo, $d);
        }
        return null;
    }

    private static function findVendor(string $text): ?string
    {
        foreach (preg_split('/\r?\n/', $text) ?: [] as $ln) {
            $ln = trim($ln);
            if (mb_strlen($ln) < 3 || mb_strlen($ln) > 60) continue;
            if (!preg_match('/\p{L}{3,}/u', $ln)) continue;            // needs letters
            if (preg_match('/^\d/', $ln)) continue;                    // skip number/date lines
            if (preg_match('/(rechnung|beleg|quittung|kassenbon|datum|uid|atu|tel|www|http|seite)/iu', $ln)) continue;
            return mb_substr($ln, 0, 120);
        }
        return null;
    }
}
