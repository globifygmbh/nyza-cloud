-- Inspiration board for the Content app: saved external links (TikTok,
-- Instagram, YouTube, Pinterest, …) or uploaded screenshots, per account.
CREATE TABLE IF NOT EXISTS content_inspiration (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    account_id BIGINT UNSIGNED NOT NULL,
    kind       VARCHAR(10)     NOT NULL DEFAULT 'link',
    url        VARCHAR(1000)   NULL,
    file_path  VARCHAR(500)    NULL,
    file_name  VARCHAR(255)    NULL,
    file_mime  VARCHAR(100)    NULL,
    note       VARCHAR(500)    NULL,
    created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_cinsp_account (account_id),
    CONSTRAINT fk_cinsp_account FOREIGN KEY (account_id) REFERENCES content_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
