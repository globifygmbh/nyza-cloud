CREATE TABLE IF NOT EXISTS time_entries (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id    BIGINT UNSIGNED NOT NULL,
    contact_id BIGINT UNSIGNED NULL,
    task       VARCHAR(500)    NULL,
    note       TEXT            NULL,
    started_at DATETIME        NOT NULL,
    ended_at   DATETIME        NULL DEFAULT NULL,
    created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_time_user (user_id),
    KEY ix_time_running (user_id, ended_at),
    CONSTRAINT fk_time_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_time_contact FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;
