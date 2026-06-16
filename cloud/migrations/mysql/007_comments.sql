-- Nyza Cloud · 007 · Kommentare/Feedback auf Dateien
-- Owner comments (user_id set, source='owner') + guest feedback left on a
-- share page (user_id NULL, source='guest'). Cascade-deleted with the file.
CREATE TABLE IF NOT EXISTS comments (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    file_id     BIGINT UNSIGNED NOT NULL,
    user_id     BIGINT UNSIGNED NULL,
    author_name VARCHAR(120)    NOT NULL,
    body        TEXT            NOT NULL,
    source      VARCHAR(16)     NOT NULL DEFAULT 'owner',
    created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_comments_file (file_id, created_at),
    CONSTRAINT fk_comments_file FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;
