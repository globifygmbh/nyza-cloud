-- Nyza Cloud · MySQL schema
-- Charset: utf8 + utf8_unicode_ci. Works on MySQL 5.5+ and MariaDB 10+.
-- Note: this is the legacy 3-byte utf8 (BMP only — no emoji in filenames /
-- shared content). To use full 4-byte utf8mb4 instead, set
--   'charset' => 'utf8mb4'
-- in config.php AND swap CHARSET=utf8 → utf8mb4 + COLLATE here before
-- the first migration runs. Engine: InnoDB (FK + transactional).

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

-- folders: the self-referencing parent_id FK is added AFTER the table is
-- created. Inline self-FK in CREATE TABLE trips errno 150 ("Foreign key
-- constraint is incorrectly formed") on some MariaDB and shared-host MySQL
-- builds. Splitting it sidesteps the issue without changing semantics.
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
    CONSTRAINT fk_folders_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

ALTER TABLE folders
    ADD CONSTRAINT fk_folders_parent FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE;

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
    KEY ix_uplink_folder (folder_id),
    CONSTRAINT fk_uplink_user   FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
    CONSTRAINT fk_uplink_folder FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

-- share_links: the "exactly one of folder_id/file_id is set" invariant is
-- enforced in PHP (ShareRoutes::create checks before INSERT). A SQL CHECK
-- constraint is silently ignored on MySQL ≤ 8.0.16 and triggers parser
-- errors on a few older builds, so we don't ship one.
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
    KEY ix_share_folder (folder_id),
    KEY ix_share_file (file_id),
    CONSTRAINT fk_share_user   FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
    CONSTRAINT fk_share_folder FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
    CONSTRAINT fk_share_file   FOREIGN KEY (file_id)   REFERENCES files(id)   ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

-- payload is TEXT (not JSON) so this works on MariaDB 10.0 and MySQL ≤ 5.7.7.
-- We never query inside the payload — it's just a serialised event blob.
CREATE TABLE IF NOT EXISTS activity (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT UNSIGNED NOT NULL,
    kind        VARCHAR(40)     NOT NULL,
    payload     TEXT            NOT NULL,
    created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_activity_user (user_id, created_at),
    CONSTRAINT fk_activity_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;
