# Nyza Cloud — Updaten

Es gibt zwei Wege. Deine Daten (`config.php` und der Ordner `storage/`) bleiben
bei beiden **immer erhalten** — die werden nie überschrieben oder gelöscht.

## Weg 1 — In-App Updater (empfohlen)

1. In der App oben rechts auf **⚙ Sicherheit** → Abschnitt **Updates** →
   **„Nach Updates suchen"**. (Direktlink: `https://cloud.nyza-studio.at/?update=1`)
2. Du siehst installierte vs. neueste Version. Auf **„Jetzt aktualisieren"**.
3. Der Updater lädt die neueste Version von GitHub, kopiert die neuen Dateien
   über die Installation und führt **automatisch alle neuen Datenbank-Felder/
   Migrationen** aus.
4. Danach einmal hart neu laden: **Strg/Cmd + Shift + R**.

Voraussetzungen: der Webserver muss ausgehende HTTPS-Verbindungen erlauben und
in den Installations-Ordner schreiben dürfen. Klappt das nicht, einfach Weg 2.

> Sicherheit: Die Update-Seite ist nur als eingeloggter Admin erreichbar
> (Token-geschützt, wie der Setup-Wizard).

## Weg 2 — Manuell per FTP

1. Neueste Version laden:
   `https://github.com/globifygmbh/nyza-cloud/archive/refs/heads/main.zip`
2. ZIP entpacken. Den **Inhalt von `cloud/`** per FTP in deinen Installations-
   Ordner hochladen und **überschreiben** —
   **außer `config.php` und dem Ordner `storage/`** (die NICHT überschreiben).
3. Einmal die App im Browser öffnen: die neuen DB-Migrationen laufen beim ersten
   Request automatisch durch. (Bei Bedarf `…/?setup=1` öffnen.)
4. Hart neu laden: **Strg/Cmd + Shift + R**.

## Hinweise

- **Backup**: Vor dem ersten Update kurz die MySQL-Datenbank exportieren und
  `storage/` sichern. Schadet nie.
- **vendor/**: Composer-Pakete werden vom Updater nicht angefasst. Sollte ein
  Update neue PHP-Pakete brauchen (selten), steht das in den Release-Notes —
  dann einmal `composer install --no-dev` laufen lassen oder das aktuelle
  `vendor/` mit hochladen.
- **Versionsnummer**: steht in der Datei `cloud/VERSION`.
