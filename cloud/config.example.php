<?php
/**
 * Nyza Cloud · Konfiguration
 *
 * 1) Diese Datei nach `config.php` kopieren.
 * 2) Werte unten anpassen (vor allem DB-Zugang + JWT_SECRET).
 * 3) Datei NICHT in Git committen — sie enthält dein Passwort.
 *
 * Es ist eine simple PHP-Datei, kein .env-Format. Vorteile:
 *  - jeder PHP-Hoster versteht sie sofort
 *  - PHP-Syntax-Errors zeigen sofort beim ersten Request, nicht erst beim Parsen
 *  - keine zusätzliche Library nötig
 */

return [
    // ───── Datenbank (MySQL 8.0+) ────────────────────────────────────────────
    'db' => [
        'host'    => '127.0.0.1',
        'port'    => 3306,
        'name'    => 'nyza',          // CREATE DATABASE nyza vorher anlegen
        'user'    => 'nyza',
        'pass'    => 'CHANGE_ME',
        'charset' => 'utf8mb4',
        // Falls dein Hoster nur Unix-Socket erlaubt, hier den Pfad eintragen
        // und host/port leer lassen. Z.B.: '/var/run/mysqld/mysqld.sock'
        'socket'  => '',
    ],

    // ───── Auth ──────────────────────────────────────────────────────────────
    // MUSS mindestens 32 Zeichen sein. Generieren z.B.:
    //   php -r "echo bin2hex(random_bytes(32));"
    'jwt_secret' => 'CHANGE_ME_use_a_random_64_char_string_at_least_long_enough',
    'jwt_ttl'    => 60 * 60 * 24 * 30,    // 30 Tage in Sekunden

    // ───── Speicher ──────────────────────────────────────────────────────────
    // Wo Datei-Blobs landen (relativ zum nyza-Ordner oder absoluter Pfad).
    // Empfohlen: ein Pfad AUSSERHALB des Webroots, falls möglich.
    'storage_path' => __DIR__ . '/storage/files',
    'temp_path'    => __DIR__ . '/storage/temp',

    // Größenlimits (in Bytes). Server-seitige Validation; PHPs upload_max_filesize
    // muss separat in php.ini hochgesetzt werden für Single-Shot uploads.
    // Für Dateien >50MB nutze die Chunked-Upload-Endpoints.
    'max_upload_bytes' => 50 * 1024 * 1024 * 1024,   // 50 GB
    'chunk_size'       => 10 * 1024 * 1024,          // 10 MB pro Chunk

    // ───── CORS ──────────────────────────────────────────────────────────────
    // '*' = jede Origin. Für Production auf deine Domain einschränken,
    // z.B. 'https://nyza.example.com'.
    'allow_origin' => '*',

    // ───── E-Mail (für Upload-Notifications) ─────────────────────────────────
    // Optional — leer lassen wenn keine Mails verschickt werden sollen.
    // Es wird PHPs eingebautes mail() benutzt; bei vielen Mails einen echten
    // Mailer (PHPMailer/Symfony Mailer + SMTP) einsetzen.
    'mail_from' => 'no-reply@nyza.cloud',

    // ───── Misc ──────────────────────────────────────────────────────────────
    'debug' => false,   // true = ausführliche Fehlermeldungen (NIE in Production)
];
