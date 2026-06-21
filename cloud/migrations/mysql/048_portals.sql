-- Customer portals: a password-gated page per customer that bundles folders
-- and files you attach. Like a share link, but multi-item and managed in an app.
CREATE TABLE IF NOT EXISTS portals (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id       BIGINT UNSIGNED NOT NULL,
    company_id    BIGINT UNSIGNED NULL,
    name          VARCHAR(160)    NOT NULL,
    contact_id    BIGINT UNSIGNED NULL,
    intro         TEXT            NULL,
    token         VARCHAR(64)     NOT NULL,
    password_hash VARCHAR(255)    NULL,
    created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_portal_token (token),
    KEY ix_portals_user (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS portal_items (
    id        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    portal_id BIGINT UNSIGNED NOT NULL,
    folder_id BIGINT UNSIGNED NULL,
    file_id   BIGINT UNSIGNED NULL,
    created_at DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_portal_items (portal_id),
    CONSTRAINT fk_portal_items FOREIGN KEY (portal_id) REFERENCES portals(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
