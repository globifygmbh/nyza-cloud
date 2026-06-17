-- Mandantenfähigkeit (multi-company) for accounting. Companies own all
-- accounting records; users join companies via company_members. The active
-- company is chosen per request (X-Company-Id header / ?company_id).
CREATE TABLE IF NOT EXISTS companies (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name       VARCHAR(255)    NOT NULL,
    profile    MEDIUMTEXT      NULL,
    created_at TIMESTAMP       DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE TABLE IF NOT EXISTS company_members (
    company_id BIGINT UNSIGNED NOT NULL,
    user_id    BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (company_id, user_id),
    CONSTRAINT fk_company_members_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
    CONSTRAINT fk_company_members_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

ALTER TABLE documents ADD COLUMN company_id BIGINT UNSIGNED NULL;
ALTER TABLE documents ADD KEY ix_documents_company (company_id);

ALTER TABLE expenses ADD COLUMN company_id BIGINT UNSIGNED NULL;
ALTER TABLE expenses ADD KEY ix_expenses_company (company_id);

ALTER TABLE subscriptions ADD COLUMN company_id BIGINT UNSIGNED NULL;
ALTER TABLE subscriptions ADD KEY ix_subscriptions_company (company_id);

ALTER TABLE subscription_periods ADD COLUMN company_id BIGINT UNSIGNED NULL;
ALTER TABLE subscription_periods ADD KEY ix_subscription_periods_company (company_id);

ALTER TABLE products ADD COLUMN company_id BIGINT UNSIGNED NULL;
ALTER TABLE products ADD KEY ix_products_company (company_id);

ALTER TABLE ledger_accounts ADD COLUMN company_id BIGINT UNSIGNED NULL;
ALTER TABLE ledger_accounts ADD KEY ix_ledger_accounts_company (company_id);

ALTER TABLE journal_entries ADD COLUMN company_id BIGINT UNSIGNED NULL;
ALTER TABLE journal_entries ADD KEY ix_journal_entries_company (company_id);

ALTER TABLE reminders ADD COLUMN company_id BIGINT UNSIGNED NULL;
ALTER TABLE reminders ADD KEY ix_reminders_company (company_id);

DROP TABLE counters;

CREATE TABLE counters (
    company_id BIGINT UNSIGNED NOT NULL,
    name       VARCHAR(32)     NOT NULL,
    value      INT             NOT NULL DEFAULT 0,
    PRIMARY KEY (company_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

INSERT INTO companies (name, profile) VALUES ('Mein Unternehmen', NULL);

INSERT INTO company_members (company_id, user_id) SELECT (SELECT MAX(id) FROM companies), id FROM users;

UPDATE documents SET company_id = (SELECT MAX(id) FROM companies) WHERE company_id IS NULL;

UPDATE expenses SET company_id = (SELECT MAX(id) FROM companies) WHERE company_id IS NULL;

UPDATE subscriptions SET company_id = (SELECT MAX(id) FROM companies) WHERE company_id IS NULL;

UPDATE subscription_periods SET company_id = (SELECT MAX(id) FROM companies) WHERE company_id IS NULL;

UPDATE products SET company_id = (SELECT MAX(id) FROM companies) WHERE company_id IS NULL;

UPDATE ledger_accounts SET company_id = (SELECT MAX(id) FROM companies) WHERE company_id IS NULL;

UPDATE journal_entries SET company_id = (SELECT MAX(id) FROM companies) WHERE company_id IS NULL;

UPDATE reminders SET company_id = (SELECT MAX(id) FROM companies) WHERE company_id IS NULL;

UPDATE companies SET profile = (SELECT data FROM app_settings WHERE ns='company' ORDER BY user_id ASC LIMIT 1) WHERE id = (SELECT MAX(id) FROM companies);
