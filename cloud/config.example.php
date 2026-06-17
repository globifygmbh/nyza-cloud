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
    // ───── Datenbank (MySQL 5.5+ / MariaDB 10+) ──────────────────────────────
    'db' => [
        'host'    => '127.0.0.1',
        'port'    => 3306,
        'name'    => 'nyza',          // CREATE DATABASE nyza vorher anlegen
        'user'    => 'nyza',
        'pass'    => 'CHANGE_ME',
        // Default: legacy 3-byte 'utf8' — funktioniert auch auf älteren/
        // Shared-Hostern. Wenn dein Server volles utf8mb4 unterstützt (für
        // Emojis in Filenames), hier 'utf8mb4' eintragen UND VOR dem ersten
        // Setup das Schema in migrations/mysql/001_init.sql ebenfalls auf
        // utf8mb4 umstellen.
        'charset' => 'utf8',
        // Falls dein Hoster nur Unix-Socket erlaubt, hier den Pfad eintragen
        // und host/port leer lassen. Z.B.: '/var/run/mysqld/mysqld.sock'
        'socket'  => '',
    ],

    // ───── Auth ──────────────────────────────────────────────────────────────
    // MUSS mindestens 32 Zeichen sein. Generieren z.B.:
    //   php -r "echo bin2hex(random_bytes(32));"
    'jwt_secret' => 'CHANGE_ME_use_a_random_64_char_string_at_least_long_enough',
    'jwt_ttl'    => 60 * 60 * 24 * 30,    // 30 Tage in Sekunden

    // ───── Push-Benachrichtigungen: Cron-Token ───────────────────────────────
    // Geheimer Token für den Scheduler-Endpunkt /api/cron. Der Server-Cronjob
    // ruft alle paar Minuten   …/api/cron?token=<DIESER WERT>   auf und sendet
    // fällige Erinnerungen (Termine, Aufgaben, überfällige Rechnungen/Belege).
    // Generieren z.B.:  php -r "echo bin2hex(random_bytes(24));"
    // Wird hier KEIN Token gesetzt, generiert die App beim ersten /api/cron-
    // Aufruf automatisch eins und legt es in der Tabelle app_kv (k='cron_token')
    // ab — dann diesen Wert dort auslesen.
    // 'cron_token' => 'CHANGE_ME_random_token',

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

    // ───── E-Mail ─────────────────────────────────────────────────────────────
    // Absender. Wenn 'smtp.host' gesetzt ist, wird via SMTP gesendet
    // (zuverlässig, empfohlen). Sonst Fallback auf PHPs mail().
    'mail_from'      => 'no-reply@nyza-studio.at',
    'mail_from_name' => 'Nyza Cloud',
    'smtp' => [
        'host'   => '',          // z.B. 'smtp.gmail.com' oder 'mail.nyza-studio.at' — leer = mail()
        'port'   => 587,         // 587 (TLS) oder 465 (SSL)
        'user'   => '',          // SMTP-Benutzer (oft die volle E-Mail)
        'pass'   => '',          // SMTP-Passwort / App-Passwort
        'secure' => 'tls',       // 'tls' | 'ssl' | 'none'
    ],

    // ───── Misc ──────────────────────────────────────────────────────────────
    'debug' => false,   // true = ausführliche Fehlermeldungen (NIE in Production)
];
