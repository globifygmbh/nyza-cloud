# Nyza Cloud — Setup

Premium Cloud-Storage mit Upload-Links. **PHP 8.1+ / MySQL 8.0+ Backend (Slim 4) + React-SPA (Vite-build)**.

Deployment: **`cloud/`-Ordner via FTP in den Webroot ziehen, `config.php` mit DB-Daten anlegen, fertig.**

---

## Ordnerstruktur

```
repo/
├── cloud/                      ← DAS hier in deinen Webroot ziehen (z.B. /www/cloud/)
│   ├── index.php               · Slim-Entry, routed API + serviert SPA
│   ├── .htaccess               · Apache-Rewrites + denied private dirs
│   ├── config.example.php      · Beispiel-Konfiguration (kopieren → config.php)
│   ├── config.php              · DEINE DB-Credentials (NICHT in Git, NICHT öffentlich)
│   ├── src/                    · PHP-Quellcode (von .htaccess geblockt)
│   ├── vendor/                 · vor-installierte Composer-Pakete
│   ├── migrations/mysql/       · DB-Schema (läuft beim ersten Request automatisch)
│   ├── assets/                 · gebautes Frontend (Vite-Output) — webfähig
│   └── storage/                · Upload-Daten (von .htaccess geblockt)
│       ├── files/              · Datei-Blobs
│       └── temp/               · Chunk-Upload temp
│
├── frontend/                   ← Quellcode des Frontends (nur am Dev-Rechner)
│   ├── src/                    · main.jsx, app.jsx, system.jsx, …
│   ├── vite.config.js          · Build-Output → ../cloud/assets/
│   └── package.json
│
└── project/                    ← Original-Designs aus Claude Design (Referenz)
```

---

## Deployment in 5 Minuten (auf nyza-studio.at/cloud)

### 1. MySQL-DB anlegen

Im Webhoster-Panel (z.B. Plesk, cPanel, oder phpMyAdmin):
```sql
CREATE DATABASE nyza CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'nyza'@'localhost' IDENTIFIED BY 'DEIN_PASSWORT';
GRANT ALL PRIVILEGES ON nyza.* TO 'nyza'@'localhost';
FLUSH PRIVILEGES;
```

### 2. `cloud/`-Ordner hochladen

Den ganzen `cloud/`-Ordner via FTP/SFTP in den Webroot ziehen — z.B. nach `/www/cloud/` (so dass die URL `https://nyza-studio.at/cloud/` ergibt).

> **Wichtig:** Den `vendor/`-Ordner mit hochladen — er enthält die PHP-Dependencies. (Der Repo committet ihn schon.)

### 3. `config.php` anlegen

Auf dem Server:
```bash
cd /www/cloud
cp config.example.php config.php
```

Dann `config.php` editieren:
```php
'db' => [
    'host'    => '127.0.0.1',     // oder localhost
    'name'    => 'nyza',
    'user'    => 'nyza',
    'pass'    => 'DEIN_PASSWORT',
],
'jwt_secret' => 'GENERIERE_64_ZEICHEN_HIER',  // wichtig!
```

JWT-Secret generieren (per SSH oder lokal):
```bash
php -r "echo bin2hex(random_bytes(32));"
```

### 4. Erster Aufruf

`https://nyza-studio.at/cloud/` öffnen.
- Wenn `config.php` fehlt: Setup-Hinweis-Seite
- Wenn alles passt: Anmeldemaske

Beim **ersten Request** werden die DB-Tabellen automatisch angelegt (Migration `001_init.sql` läuft via `Database::migrate()`).

### 5. Account erstellen

In der UI auf "Registrieren" klicken — der erste Account wird normaler User mit 200 GB-Quota. (Es gibt keinen separaten Admin-Account — alle Accounts haben gleiche Rechte auf ihre eigenen Daten.)

---

## URLs

Beispiel-Domain `nyza-studio.at/cloud`:

| URL                                       | Wer?         | Was?                                    |
|-------------------------------------------|--------------|-----------------------------------------|
| `nyza-studio.at/cloud/`                   | Eingeloggt   | Dashboard, Dateien, Ordner, Settings   |
| `nyza-studio.at/cloud/s/<token>`          | Öffentlich   | Empfänger sieht geteilte Dateien       |
| `nyza-studio.at/cloud/u/<token>`          | Öffentlich   | Kunde lädt Dateien hoch (kein Login)   |
| `nyza-studio.at/cloud/api/...`            | (intern)     | JSON-API                               |
| `nyza-studio.at/cloud/healthz`            | (intern)     | `{"ok":true}` für Monitoring           |

---

## Frontend-Entwicklung (lokal)

Vor dem Hochladen kannst du das Frontend lokal weiterentwickeln. Du brauchst **Node 18+** und einen lokalen PHP/MySQL-Stack (XAMPP, MAMP, Laragon — alles fein).

```bash
# 1. Backend lokal aufsetzen (z.B. XAMPP htdocs/cloud/ symlink)
ln -s $(pwd)/cloud /opt/lampp/htdocs/cloud
# oder einfach den cloud/-Ordner kopieren

# 2. config.php mit lokalen MySQL-Credentials anlegen

# 3. Frontend dev-server starten
cd frontend
npm install
npm run dev          # http://localhost:5173
```

Vite startet auf Port 5173 und proxy't `/api/*`-Calls automatisch zu `http://127.0.0.1:8080`. Für andere Ziele:

```bash
VITE_API_TARGET=http://localhost/cloud npm run dev
```

### Production-Build erzeugen

```bash
cd frontend
npm run build
```

Das schreibt direkt nach `../cloud/assets/`. Dann den `cloud/`-Ordner deployen.

---

## Was die App kann

**Owner-Features (eingeloggt)**
- Ordner anlegen (zwei Sorten: `normal` für Mischdateien, `gallery` für reine Bilder-Folder)
- Dateien hochladen (Drag-Drop oder Klick) — mit echter Progress-Anzeige
- Dateien als ZIP herunterladen (Multi-Select)
- Share-Links erstellen (Passwort, Ablaufdatum, Download-Toggle)
- **Upload-Links** erstellen — Kunden können hochladen ohne Account
  - Optional: Passwort, Ablauf, Max-Dateien, Max-Größe pro Datei, Uploader-Name pflicht

**Empfänger-Features (öffentliche Pages)**
- Share-Page: Vorschau-Cards, ZIP-Download oder Einzeldatei
- Upload-Page: WeTransfer-artiges Drag-Drop, Echtzeit-Progress, Success-Screen
- E-Mail-Notification an den Owner bei jedem Upload (wenn `mail()` läuft)

**Sicherheit**
- JWT-Auth (Bearer-Token, 30 Tage TTL)
- bcrypt für User-Passwörter und Share/Upload-Link-Passwörter
- 24-byte zufällige Tokens (URL-safe Base64) für Share-Links, 32-byte für Upload-Links
- Storage-Quota wird server-seitig geprüft
- `.htaccess` blockt direkten Zugriff auf `src/`, `vendor/`, `storage/`, `config.php`, `composer.*`

---

## API-Übersicht

Alle Routes unterhalb `/cloud/api/...`. JSON-bodies, Bearer-Auth via `Authorization: Bearer <jwt>`.

### Auth
- `POST /api/auth/register` — `{ email, password, name }` → `{ token, user }`
- `POST /api/auth/login`    — `{ email, password }` → `{ token, user }`
- `GET  /api/auth/me`       — `{ user }`

### Ordner
- `GET    /api/folders[?parent_id=N]`
- `POST   /api/folders`               — `{ name, kind, tone, parent_id? }`
- `GET    /api/folders/{id}`          — Folder + Files + Subfolders
- `PATCH  /api/folders/{id}`          — `{ name?, kind?, tone? }`
- `DELETE /api/folders/{id}`          — rekursiv (löscht auch Datei-Blobs)

### Dateien
- `GET    /api/files[?folder_id=N]`
- `POST   /api/files`                 — multipart `file=` `+ folder_id?`
- `GET    /api/files/{id}/raw`        — streamt das Blob (Bearer-Auth required)
- `DELETE /api/files/{id}`
- `POST   /api/files/zip`             — `{ file_ids: [...] }` oder `{ folder_id }` → ZIP-Stream

### Shares (Owner)
- `GET    /api/shares`
- `POST   /api/shares`                — `{ folder_id|file_id, password?, expires_at?, allow_download? }`
- `DELETE /api/shares/{id}`

### Public Share (kein Login)
- `GET  /api/s/{token}[?p=password]`  — Meta + File-Liste
- `POST /api/s/{token}/unlock`        — `{ password }`
- `GET  /api/s/{token}/zip[?p=...]`   — ZIP aller Dateien
- `GET  /api/s/{token}/file/{id}[?p=...]`

### Upload-Links (Owner)
- `GET    /api/upload-links`
- `POST   /api/upload-links`          — `{ folder_id, title, description?, password?, expires_at?, max_files?, max_file_size?, notify_email?, require_uploader_name? }`
- `DELETE /api/upload-links/{id}`

### Public Upload (kein Login)
- `GET  /api/u/{token}`               — Meta (Title, Beschreibung, Owner, Limits)
- `POST /api/u/{token}/unlock`        — `{ password }`
- `POST /api/u/{token}/upload`        — multipart `file=` `+ password? + uploader_name?` (Single-Shot)
- **Chunked-Upload (für große Dateien):**
  - `POST /api/u/{token}/chunk/init`        — `{ file_name, total_size, chunk_size?, password?, uploader_name? }` → `{ session_id }`
  - `POST /api/u/{token}/chunk/{sid}`       — Body = nächster Chunk
  - `GET  /api/u/{token}/chunk/{sid}`       — `{ received, total }` (Resume-Status)
  - `POST /api/u/{token}/chunk/{sid}/finalize` — verschiebt temp → storage, legt File-Row an

### Activity / Stats
- `GET /api/activity[?limit=50]`
- `GET /api/stats`

---

## Konfigurations-Referenz (`config.php`)

```php
return [
    'db' => [
        'host' => '127.0.0.1', 'port' => 3306,
        'name' => 'nyza', 'user' => 'nyza', 'pass' => '…',
        'charset' => 'utf8mb4',
        'socket' => '',  // alternativ Unix-socket-Pfad
    ],
    'jwt_secret' => '…',                  // ≥32 Zeichen, idealerweise 64
    'jwt_ttl' => 60 * 60 * 24 * 30,       // 30 Tage

    'storage_path' => __DIR__ . '/storage/files',
    'temp_path'    => __DIR__ . '/storage/temp',
    'max_upload_bytes' => 50 * 1024 * 1024 * 1024,
    'chunk_size'       => 10 * 1024 * 1024,

    'allow_origin' => '*',                // einschränken auf Produktions-Domain
    'mail_from'    => 'no-reply@nyza-studio.at',
    'debug'        => false,              // niemals in Production an!
];
```

**Beim ersten Request** legt `Database::migrate()` automatisch alle Tabellen an, inkl. `schema_migrations` für Versionierung. Künftige Migrationen einfach als `migrations/mysql/002_xxx.sql` ablegen.

---

## Hosting-Checkliste

- ✅ **PHP 8.1+** mit `pdo_mysql`, `zip`, `mbstring`, `fileinfo`
- ✅ **MySQL 8.0+** (für die `WITH RECURSIVE`-CTEs in `FolderRoutes::delete`). Auf MariaDB mind. 10.2.2.
- ✅ **Apache** mit `mod_rewrite` (für `.htaccess`). Bei Nginx: das Rewrite-Pattern selbst nachbauen (`try_files $uri /cloud/index.php`)
- ✅ `upload_max_filesize` und `post_max_size` in `php.ini` hochsetzen (z.B. 2G), oder Chunk-Upload-API nutzen
- ✅ Cron für Cleanup von verwaisten `upload_sessions` älter als ~24h:
  ```sql
  DELETE FROM upload_sessions WHERE status='open' AND updated_at < DATE_SUB(NOW(), INTERVAL 1 DAY);
  ```
  + dazugehörige `.part`-Files in `storage/temp/` löschen.
- ✅ HTTPS-Pflicht (sonst leakt das JWT). Kein HTTP fallback.
- ✅ `allow_origin` in `config.php` auf die echte Domain einschränken.
- ✅ Backup-Strategie: MySQL dump + `storage/files/` (das ist der eigentliche Wert).

---

## Bekannte Limitierungen / nächste Schritte

- **Image-Previews** in der Liste laden via `<img src="…/raw?token=…">` — funktional, aber leakt das Token in den Browser-History/Logs. Production: signed-URLs mit kurzer TTL (z.B. 5 Min) oder `URL.createObjectURL(blob)`-Flow.
- **Mail-Notifications** nutzen PHPs `mail()` — auf vielen Hostern unzuverlässig. Empfohlen: PHPMailer + SMTP einbauen (in `UploadLinkRoutes::notifyOwner`).
- **Folder-Detail-Ansicht** im Frontend ist gestubbt (Toast statt echter Seite). Backend-API ist da, nur die Route fehlt — easy fix.
- **Keine Tests.** Slim ist trivial zu testen; vor dem nächsten Feature-Push Integration-Tests einbauen.
- **Storage = lokales Filesystem.** `Storage`-Klasse ist klein genug für einen S3-Adapter (1 Tag Arbeit) — nur `relPath`, `abs`, `deleteRel`, plus die Stream-Code-Stellen in `FileRoutes` und `ShareRoutes`.

---

## Visuelle Referenz

Das ursprüngliche Claude-Design-Canvas mit allen 17 Artboards liegt unter `project/index.html` als Read-Only Referenz. Falls du daran weiter iterieren willst: `npm run dev` im `frontend/` und seitlich öffnen.
