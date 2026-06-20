-- Mail accounts (IMAP receive + SMTP send). Credentials are encrypted via the
-- Crypto helper. One mailbox can be flagged as the "Belege" inbox whose PDF/
-- image attachments are filed into belege_folder_id and booked as open expenses.
CREATE TABLE IF NOT EXISTS mailboxes (
    id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id          BIGINT UNSIGNED NOT NULL,
    company_id       BIGINT UNSIGNED NULL,
    name             VARCHAR(120)    NOT NULL,
    email            VARCHAR(255)    NOT NULL,
    imap_host        VARCHAR(255)    NULL,
    imap_port        INT UNSIGNED    NOT NULL DEFAULT 993,
    imap_user        VARCHAR(255)    NULL,
    imap_pass_enc    TEXT            NULL,
    imap_ssl         TINYINT(1)      NOT NULL DEFAULT 1,
    smtp_host        VARCHAR(255)    NULL,
    smtp_port        INT UNSIGNED    NOT NULL DEFAULT 465,
    smtp_user        VARCHAR(255)    NULL,
    smtp_pass_enc    TEXT            NULL,
    smtp_secure      VARCHAR(8)      NOT NULL DEFAULT 'ssl',
    from_name        VARCHAR(120)    NULL,
    is_belege        TINYINT(1)      NOT NULL DEFAULT 0,
    belege_folder_id BIGINT UNSIGNED NULL,
    belege_seen_uid  INT UNSIGNED    NOT NULL DEFAULT 0,
    created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_mailboxes_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
