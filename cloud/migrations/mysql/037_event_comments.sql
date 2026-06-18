-- Comments on calendar events (shared workspace calendar). Mirrors the file
-- comments table; @-mentions are delivered as push and don't need storage.
CREATE TABLE IF NOT EXISTS event_comments (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    event_id    BIGINT UNSIGNED NOT NULL,
    user_id     BIGINT UNSIGNED NULL,
    author_name VARCHAR(120)    NOT NULL,
    body        TEXT            NOT NULL,
    created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_event_comments (event_id, created_at),
    CONSTRAINT fk_event_comments_event FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
