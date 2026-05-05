-- Nyza Cloud · MySQL schema (MySQL 8.0+)
-- Charset: utf8mb4 + utf8mb4_0900_ai_ci. Engine: InnoDB (FK + transactional).

-- IMPORTANT: each statement is single-statement so PDO::exec works without
-- multi-query semantics. The migrate runner splits on `;` at line ends.

CREATE TABLE IF NOT EXISTS users (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    email           VARCHAR(254)   NOT NULL,
    password_hash   VARCHAR(255)   NOT NULL,
    name            VARCHAR(120)   NOT NULL,
    storage_quota   BIGINT UNSIGNED NOT NULL DEFAULT 214748364800,
    storage_used    BIGINT UNSIGNED NOT NULL DEFAULT 0,
    created_at      TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY ux_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS folders (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT UNSIGNED NOT NULL,
    parent_id   BIGINT UNSIGNED NULL,
    name        VARCHAR(255)    NOT NULL,
    kind        VARCHAR(16)     NOT NULL DEFAULT 'normal',
    tone        VARCHAR(16)     NOT NULL DEFAULT 'violet',
    created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_folders_user (user_id),
    KEY ix_folders_parent (parent_id),
    CONSTRAINT fk_folders_user   FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
    CONSTRAINT fk_folders_parent FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS upload_links (
    id                      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id                 BIGINT UNSIGNED NOT NULL,
    folder_id               BIGINT UNSIGNED NOT NULL,
    token                   VARCHAR(64)     NOT NULL,
    title                   VARCHAR(255)    NOT NULL,
    description             TEXT            NULL,
    password_hash           VARCHAR(255)    NULL,
    expires_at              DATETIME        NULL,
    max_files               INT UNSIGNED    NULL,
    max_file_size           BIGINT UNSIGNED NULL,
    upload_count            INT UNSIGNED    NOT NULL DEFAULT 0,
    notify_email            TINYINT(1)      NOT NULL DEFAULT 1,
    require_uploader_name   TINYINT(1)      NOT NULL DEFAULT 0,
    created_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY ux_uplink_token (token),
    KEY ix_uplink_user (user_id),
    CONSTRAINT fk_uplink_user   FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
    CONSTRAINT fk_uplink_folder FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS files (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT UNSIGNED NOT NULL,
    folder_id       BIGINT UNSIGNED NULL,
    name            VARCHAR(255)    NOT NULL,
    storage_path    VARCHAR(500)    NOT NULL,
    mime_type       VARCHAR(160)    NOT NULL,
    size            BIGINT UNSIGNED NOT NULL,
    kind            VARCHAR(16)     NOT NULL DEFAULT 'doc',
    hue             SMALLINT UNSIGNED NOT NULL DEFAULT 280,
    upload_link_id  BIGINT UNSIGNED NULL,
    uploader_name   VARCHAR(120)    NULL,
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_files_user (user_id),
    KEY ix_files_folder (folder_id),
    KEY ix_files_uplink (upload_link_id),
    CONSTRAINT fk_files_user   FOREIGN KEY (user_id)        REFERENCES users(id)         ON DELETE CASCADE,
    CONSTRAINT fk_files_folder FOREIGN KEY (folder_id)      REFERENCES folders(id)       ON DELETE SET NULL,
    CONSTRAINT fk_files_uplink FOREIGN KEY (upload_link_id) REFERENCES upload_links(id)  ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS share_links (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT UNSIGNED NOT NULL,
    folder_id       BIGINT UNSIGNED NULL,
    file_id         BIGINT UNSIGNED NULL,
    token           VARCHAR(64)     NOT NULL,
    password_hash   VARCHAR(255)    NULL,
    expires_at      DATETIME        NULL,
    allow_download  TINYINT(1)      NOT NULL DEFAULT 1,
    view_count      INT UNSIGNED    NOT NULL DEFAULT 0,
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY ux_share_token (token),
    KEY ix_share_user (user_id),
    CONSTRAINT fk_share_user   FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
    CONSTRAINT fk_share_folder FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
    CONSTRAINT fk_share_file   FOREIGN KEY (file_id)   REFERENCES files(id)   ON DELETE CASCADE,
    CONSTRAINT chk_share_target CHECK (folder_id IS NOT NULL OR file_id IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS upload_sessions (
    id              CHAR(24)        NOT NULL PRIMARY KEY,
    upload_link_id  BIGINT UNSIGNED NULL,
    user_id         BIGINT UNSIGNED NOT NULL,
    folder_id       BIGINT UNSIGNED NULL,
    file_name       VARCHAR(255)    NOT NULL,
    total_size      BIGINT UNSIGNED NOT NULL,
    received        BIGINT UNSIGNED NOT NULL DEFAULT 0,
    chunk_size      INT UNSIGNED    NOT NULL,
    temp_path       VARCHAR(500)    NOT NULL,
    uploader_name   VARCHAR(120)    NULL,
    status          VARCHAR(16)     NOT NULL DEFAULT 'open',
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_us_uplink (upload_link_id),
    KEY ix_us_status_updated (status, updated_at),
    CONSTRAINT fk_us_uplink FOREIGN KEY (upload_link_id) REFERENCES upload_links(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS activity (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT UNSIGNED NOT NULL,
    kind        VARCHAR(40)     NOT NULL,
    payload     JSON            NOT NULL,
    created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_activity_user (user_id, created_at),
    CONSTRAINT fk_activity_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
