<?php
declare(strict_types=1);

namespace Nyza;

/**
 * Minimal streaming ZIP writer. Writes a STORE-only (uncompressed) archive
 * directly to an output stream with constant memory and no temp file — the
 * download starts immediately and never buffers a whole archive on disk.
 *
 * Store is ideal here: the payload is already-compressed media (images, video,
 * PDFs) where deflate buys almost nothing but costs CPU. Each file is read
 * twice — once to compute its CRC-32, once to stream the bytes — so memory
 * stays flat regardless of file size.
 *
 * ZIP64 is emitted per-entry and for the end-of-central-directory whenever a
 * file, an offset or the entry count crosses the 4 GB / 65535 limits, so very
 * large archives stay valid. Requires 64-bit PHP for >4 GB members (pack 'P').
 */
final class ZipStreamer
{
    private const U32 = 0xFFFFFFFF;
    private const READ = 1048576; // 1 MiB read buffer

    /** @var resource */
    private $out;
    private int $offset = 0;
    /** @var string[] central directory records */
    private array $cdir = [];
    /** @var array<string,bool> */
    private array $used = [];

    /** @param resource $outStream */
    public function __construct($outStream)
    {
        $this->out = $outStream;
    }

    private function w(string $bytes): void
    {
        fwrite($this->out, $bytes);
        $this->offset += strlen($bytes);
    }

    private function uniqueName(string $name): string
    {
        // Strip leading slashes / drive-style prefixes; keep sub-paths.
        $name = ltrim(str_replace('\\', '/', $name), '/');
        if ($name === '') $name = 'datei';
        $base = $name; $i = 1;
        while (isset($this->used[$base])) {
            $info = pathinfo($name);
            $dir = isset($info['dirname']) && $info['dirname'] !== '.' ? $info['dirname'] . '/' : '';
            $ext = isset($info['extension']) ? '.' . $info['extension'] : '';
            $base = $dir . $info['filename'] . " ($i)" . $ext;
            $i++;
        }
        $this->used[$base] = true;
        return $base;
    }

    /** @return array{0:int,1:int} DOS time, DOS date */
    private static function dosTime(int $ts): array
    {
        $d = getdate($ts);
        if ($d['year'] < 1980) { $d = getdate(315532800); } // clamp to 1980
        $time = ($d['hours'] << 11) | ($d['minutes'] << 5) | (intdiv($d['seconds'], 2));
        $date = (($d['year'] - 1980) << 9) | ($d['mon'] << 5) | $d['mday'];
        return [$time & 0xFFFF, $date & 0xFFFF];
    }

    public function addFile(string $absPath, string $name): void
    {
        if (!is_file($absPath)) return;
        $name = $this->uniqueName($name);
        $size = (int) filesize($absPath);

        // Pass 1: CRC-32 over the file in chunks (hash('crc32b') == crc32()).
        $ctx = hash_init('crc32b');
        $fh = fopen($absPath, 'rb');
        if ($fh === false) return;
        while (!feof($fh)) {
            $buf = fread($fh, self::READ);
            if ($buf === false || $buf === '') break;
            hash_update($ctx, $buf);
        }
        $crc = (int) hexdec(hash_final($ctx));

        [$dosTime, $dosDate] = self::dosTime((int)(filemtime($absPath) ?: time()));
        $localOffset = $this->offset;
        $sizeZip64 = $size >= self::U32;
        $offZip64 = $localOffset >= self::U32;
        $flags = 0x0800; // UTF-8 filename
        $verNeeded = ($sizeZip64 || $offZip64) ? 45 : 20;
        $nameBytes = $name;

        // Local header (sizes known up front — store, so comp == uncomp).
        $localExtra = '';
        if ($sizeZip64) {
            $localExtra = pack('v', 0x0001) . pack('v', 16) . pack('P', $size) . pack('P', $size);
        }
        $this->w(
            pack('V', 0x04034b50)
            . pack('v', $verNeeded)
            . pack('v', $flags)
            . pack('v', 0)             // method: store
            . pack('v', $dosTime)
            . pack('v', $dosDate)
            . pack('V', $crc)
            . pack('V', $sizeZip64 ? self::U32 : $size) // compressed
            . pack('V', $sizeZip64 ? self::U32 : $size) // uncompressed
            . pack('v', strlen($nameBytes))
            . pack('v', strlen($localExtra))
            . $nameBytes
            . $localExtra
        );

        // Pass 2: stream the bytes.
        rewind($fh);
        while (!feof($fh)) {
            $buf = fread($fh, self::READ);
            if ($buf === false || $buf === '') break;
            $this->w($buf);
        }
        fclose($fh);

        // Central directory record.
        $cdExtra = '';
        if ($sizeZip64 || $offZip64) {
            $z = '';
            if ($sizeZip64) $z .= pack('P', $size) . pack('P', $size);
            if ($offZip64) $z .= pack('P', $localOffset);
            $cdExtra = pack('v', 0x0001) . pack('v', strlen($z)) . $z;
        }
        $this->cdir[] =
            pack('V', 0x02014b50)
            . pack('v', 45)            // version made by
            . pack('v', $verNeeded)
            . pack('v', $flags)
            . pack('v', 0)             // method: store
            . pack('v', $dosTime)
            . pack('v', $dosDate)
            . pack('V', $crc)
            . pack('V', $sizeZip64 ? self::U32 : $size)
            . pack('V', $sizeZip64 ? self::U32 : $size)
            . pack('v', strlen($nameBytes))
            . pack('v', strlen($cdExtra))
            . pack('v', 0)             // comment length
            . pack('v', 0)             // disk number start
            . pack('v', 0)             // internal attrs
            . pack('V', 0)             // external attrs
            . pack('V', $offZip64 ? self::U32 : $localOffset)
            . $nameBytes
            . $cdExtra;
    }

    /**
     * Emit HTTP headers and stream a store-only ZIP of the given members to the
     * client, then exit. Members are ['path' => absPath, 'name' => entryName].
     * Bypasses the PSR-7 response on purpose — nothing is buffered to disk.
     *
     * @param array<int,array{path:string,name:string}> $members
     */
    public static function emit(array $members, string $downloadName): void
    {
        while (ob_get_level() > 0) { @ob_end_clean(); }
        if (function_exists('set_time_limit')) { @set_time_limit(0); }
        $safe = str_replace(['"', "\r", "\n"], '', $downloadName);
        header('Content-Type: application/zip');
        header('Content-Disposition: attachment; filename="' . $safe . '"');
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: private, no-store');

        $out = fopen('php://output', 'wb');
        $zip = new self($out);
        foreach ($members as $m) {
            $zip->addFile($m['path'], $m['name']);
            @flush();
        }
        $zip->finish();
        @fflush($out);
        exit;
    }

    /** Write central directory + (zip64) end records. Call once, last. */
    public function finish(): void
    {
        $cdStart = $this->offset;
        foreach ($this->cdir as $rec) $this->w($rec);
        $cdSize = $this->offset - $cdStart;
        $count = count($this->cdir);

        $needZip64 = $count >= 0xFFFF || $cdSize >= self::U32 || $cdStart >= self::U32;
        if ($needZip64) {
            $z64Off = $this->offset;
            $this->w(
                pack('V', 0x06064b50)
                . pack('P', 44)            // size of remaining zip64 EOCD record
                . pack('v', 45) . pack('v', 45)
                . pack('V', 0) . pack('V', 0)
                . pack('P', $count) . pack('P', $count)
                . pack('P', $cdSize) . pack('P', $cdStart)
            );
            $this->w(
                pack('V', 0x07064b50)
                . pack('V', 0)
                . pack('P', $z64Off)
                . pack('V', 1)
            );
        }
        $this->w(
            pack('V', 0x06054b50)
            . pack('v', 0) . pack('v', 0)
            . pack('v', min($count, 0xFFFF)) . pack('v', min($count, 0xFFFF))
            . pack('V', $needZip64 ? self::U32 : $cdSize)
            . pack('V', $needZip64 ? self::U32 : $cdStart)
            . pack('v', 0)
        );
    }
}
