<?php
declare(strict_types=1);

namespace Nyza\Pdf;

use setasign\Fpdi\Fpdi;

/**
 * FPDI subclass with the classic FPDF text-rotation helper, plus a small
 * UTF-8 → CP1252 encoder for the core fonts. Used for watermarks, stamps,
 * page numbers and Bates numbering — all drawn on top of imported pages.
 */
final class NyzaPdf extends Fpdi
{
    private float $angle = 0.0;

    /** Rotate the coordinate system around (x,y). Call rotate(0) to stop. */
    public function rotate(float $angle, ?float $x = null, ?float $y = null): void
    {
        if ($x === null) $x = $this->x;
        if ($y === null) $y = $this->y;
        if ($this->angle != 0.0) $this->_out('Q');
        $this->angle = $angle;
        if ($angle != 0.0) {
            $a = $angle * M_PI / 180;
            $c = cos($a); $s = sin($a);
            $cx = $x * $this->k; $cy = ($this->h - $y) * $this->k;
            $this->_out(sprintf('q %.5F %.5F %.5F %.5F %.5F %.5F cm 1 0 0 1 %.5F %.5F cm',
                $c, $s, -$s, $c, $cx, $cy, -$cx, -$cy));
        }
    }

    public function rotatedText(float $x, float $y, string $txt, float $angle): void
    {
        $this->rotate($angle, $x, $y);
        $this->Text($x, $y, $txt);
        $this->rotate(0);
    }

    protected function _endpage(): void
    {
        if ($this->angle != 0.0) { $this->angle = 0.0; $this->_out('Q'); }
        parent::_endpage();
    }

    /** Encode a UTF-8 string for the built-in (CP1252) core fonts. */
    public static function enc(string $s): string
    {
        if (function_exists('iconv')) {
            $r = @iconv('UTF-8', 'windows-1252//TRANSLIT//IGNORE', $s);
            if ($r !== false) return $r;
        }
        if (function_exists('mb_convert_encoding')) {
            return mb_convert_encoding($s, 'Windows-1252', 'UTF-8');
        }
        return $s;
    }
}
