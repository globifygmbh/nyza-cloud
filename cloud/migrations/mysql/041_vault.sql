-- Credential vault ("Zugänge"). Passwords, notes and custom field values are
-- stored encrypted (libsodium) via the Crypto helper; title/username/email/url
-- stay plaintext so the list is searchable.
CREATE TABLE IF NOT EXISTS vault_entries (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id      BIGINT UNSIGNED NOT NULL,
    company_id   BIGINT UNSIGNED NULL,
    title        VARCHAR(255)    NOT NULL,
    username     VARCHAR(255)    NULL,
    email        VARCHAR(255)    NULL,
    url          VARCHAR(500)    NULL,
    password_enc TEXT            NULL,
    notes_enc    MEDIUMTEXT      NULL,
    fields_enc   MEDIUMTEXT      NULL,
    created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_vault_user (user_id, title)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
