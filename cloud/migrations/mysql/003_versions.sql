-- Nyza Cloud · 003 · Versionsverlauf für (Text-)Dateien
-- Each save snapshots the PREVIOUS content here before overwriting. Restoring
-- a version snapshots the current one first, so history is never lost. Content
-- is stored inline (MEDIUMBLOB, charset-agnostic) — versions cap at ~50/file.

CREATE TABLE IF NOT EXISTS file_versions (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    file_id     BIGINT UNSIGNED NOT NULL,
    user_id     BIGINT UNSIGNED NOT NULL,
    content     MEDIUMBLOB      NOT NULL,
    size        BIGINT UNSIGNED NOT NULL,
    created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_fv_file (file_id, created_at),
    CONSTRAINT fk_fv_file FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
    CONSTRAINT fk_fv_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;
