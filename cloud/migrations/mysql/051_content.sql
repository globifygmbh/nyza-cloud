-- Content planning app ("TikTok"-Ideen): multiple content accounts per user
-- (Arcade Room, Lokalio, …), each with its own ideas/categories/hashtags/files.
-- Accounts are a shared workspace like companies — owner + explicit members.
CREATE TABLE IF NOT EXISTS content_accounts (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    owner_id   BIGINT UNSIGNED NOT NULL,
    name       VARCHAR(255)    NOT NULL,
    created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_content_accounts_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS content_account_members (
    account_id BIGINT UNSIGNED NOT NULL,
    user_id    BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (account_id, user_id),
    CONSTRAINT fk_cam_account FOREIGN KEY (account_id) REFERENCES content_accounts(id) ON DELETE CASCADE,
    CONSTRAINT fk_cam_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS content_categories (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    account_id BIGINT UNSIGNED NOT NULL,
    name       VARCHAR(100)    NOT NULL,
    sort_order INT             NOT NULL DEFAULT 0,
    KEY ix_cc_account (account_id),
    CONSTRAINT fk_cc_account FOREIGN KEY (account_id) REFERENCES content_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS content_hashtags (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    account_id BIGINT UNSIGNED NOT NULL,
    tag        VARCHAR(100)    NOT NULL,
    KEY ix_ch_account (account_id),
    CONSTRAINT fk_ch_account FOREIGN KEY (account_id) REFERENCES content_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS content_ideas (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    account_id     BIGINT UNSIGNED NOT NULL,
    title          VARCHAR(255)    NOT NULL,
    description    TEXT            NULL,
    category_id    BIGINT UNSIGNED NULL,
    status         VARCHAR(20)     NOT NULL DEFAULT 'idee',
    platforms      VARCHAR(255)    NULL,
    priority       TINYINT         NOT NULL DEFAULT 1,
    content_type   VARCHAR(30)     NULL,
    capture_device VARCHAR(20)     NULL,
    duration       VARCHAR(10)     NULL,
    hook           TEXT            NULL,
    script         MEDIUMTEXT      NULL,
    shotlist       MEDIUMTEXT      NULL,
    hashtags       TEXT            NULL,
    music          VARCHAR(255)    NULL,
    sound_ideas    TEXT            NULL,
    notes          TEXT            NULL,
    scheduled_at   DATE            NULL,
    position       INT             NOT NULL DEFAULT 0,
    created_by     BIGINT UNSIGNED NULL,
    created_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_ci_account (account_id, status),
    CONSTRAINT fk_ci_account FOREIGN KEY (account_id) REFERENCES content_accounts(id) ON DELETE CASCADE,
    CONSTRAINT fk_ci_category FOREIGN KEY (category_id) REFERENCES content_categories(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS content_files (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    idea_id    BIGINT UNSIGNED NOT NULL,
    path       VARCHAR(500)    NOT NULL,
    name       VARCHAR(255)    NOT NULL,
    mime       VARCHAR(100)    NULL,
    size       BIGINT UNSIGNED NOT NULL DEFAULT 0,
    created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_cf_idea (idea_id),
    CONSTRAINT fk_cf_idea FOREIGN KEY (idea_id) REFERENCES content_ideas(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
