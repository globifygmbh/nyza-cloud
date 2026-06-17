CREATE TABLE IF NOT EXISTS share_events (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    share_id   BIGINT UNSIGNED NOT NULL,
    type       VARCHAR(16)     NOT NULL,
    file_id    BIGINT UNSIGNED NULL,
    file_name  VARCHAR(255)    NULL,
    ip         VARCHAR(64)     NULL,
    user_agent VARCHAR(255)    NULL,
    created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_share_events (share_id, created_at),
    CONSTRAINT fk_share_events_share FOREIGN KEY (share_id) REFERENCES share_links(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;
