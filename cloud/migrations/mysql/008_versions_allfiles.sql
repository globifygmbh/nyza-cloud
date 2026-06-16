-- Nyza Cloud · 008 · Versionsverlauf für ALLE Dateitypen
-- Bisher wurde nur der Inhalt von Textdateien inline (content MEDIUMBLOB)
-- gesichert. Für beliebige (auch große, binäre) Dateien speichern wir die
-- vorherige Version stattdessen als Blob auf der Platte und merken uns Pfad,
-- MIME und Name. `content` bleibt für Text-Snapshots (Editor) und wird nullbar.
ALTER TABLE file_versions ADD COLUMN storage_path VARCHAR(500) NULL AFTER content;
ALTER TABLE file_versions ADD COLUMN mime_type VARCHAR(160) NULL AFTER storage_path;
ALTER TABLE file_versions ADD COLUMN name VARCHAR(255) NULL AFTER mime_type;
ALTER TABLE file_versions MODIFY content MEDIUMBLOB NULL;
