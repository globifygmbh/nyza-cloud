CREATE TABLE IF NOT EXISTS tasks (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT UNSIGNED NOT NULL,
    title       VARCHAR(500)    NOT NULL,
    notes       TEXT            NULL,
    due_date    DATE            NULL DEFAULT NULL,
    priority    TINYINT         NOT NULL DEFAULT 1,
    done_at     TIMESTAMP       NULL DEFAULT NULL,
    archived_at TIMESTAMP       NULL DEFAULT NULL,
    created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_tasks_user (user_id),
    CONSTRAINT fk_tasks_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;
