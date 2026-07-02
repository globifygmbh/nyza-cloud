-- Text-Bausteine: reusable text blocks for mails/offers, organized by category.
CREATE TABLE IF NOT EXISTS text_snippets (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id    BIGINT UNSIGNED NOT NULL,
    company_id BIGINT UNSIGNED NULL,
    category   VARCHAR(100)    NULL,
    title      VARCHAR(255)    NOT NULL,
    body       MEDIUMTEXT      NOT NULL,
    use_count  INT UNSIGNED    NOT NULL DEFAULT 0,
    created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_snippets_user (user_id, category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
