-- Nyza Cloud · 006 · 2FA (TOTP) + Login-Verlauf
ALTER TABLE users ADD COLUMN totp_secret VARCHAR(64) NULL DEFAULT NULL;
ALTER TABLE users ADD COLUMN totp_enabled TINYINT(1) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS login_events (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT UNSIGNED NULL,
    email       VARCHAR(254)    NULL,
    ip          VARCHAR(64)     NULL,
    user_agent  VARCHAR(255)    NULL,
    ok          TINYINT(1)      NOT NULL DEFAULT 0,
    reason      VARCHAR(40)     NULL,
    created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_login_user (user_id, created_at),
    CONSTRAINT fk_login_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;
