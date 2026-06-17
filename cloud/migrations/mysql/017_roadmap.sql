CREATE TABLE IF NOT EXISTS roadmap_steps (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id      BIGINT UNSIGNED NOT NULL,
    title        VARCHAR(300)    NOT NULL,
    description  TEXT            NULL,
    date         DATE            NULL DEFAULT NULL,
    labels       VARCHAR(500)    NULL,
    color        VARCHAR(32)     NOT NULL DEFAULT 'violet',
    completed    TINYINT(1)      NOT NULL DEFAULT 0,
    completed_at TIMESTAMP       NULL DEFAULT NULL,
    sort_order   INT             NOT NULL DEFAULT 0,
    created_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_roadmap_user (user_id),
    CONSTRAINT fk_roadmap_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE TABLE IF NOT EXISTS roadmap_tasks (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    step_id      BIGINT UNSIGNED NOT NULL,
    user_id      BIGINT UNSIGNED NOT NULL,
    title        VARCHAR(300)    NOT NULL,
    completed    TINYINT(1)      NOT NULL DEFAULT 0,
    completed_at TIMESTAMP       NULL DEFAULT NULL,
    sort_order   INT             NOT NULL DEFAULT 0,
    created_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_rtask_step (step_id),
    CONSTRAINT fk_rtask_step FOREIGN KEY (step_id) REFERENCES roadmap_steps(id) ON DELETE CASCADE,
    CONSTRAINT fk_rtask_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;
