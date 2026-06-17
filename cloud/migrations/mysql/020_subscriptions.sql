CREATE TABLE IF NOT EXISTS subscriptions (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id       BIGINT UNSIGNED NOT NULL,
    contact_id    BIGINT UNSIGNED NULL,
    name          VARCHAR(255)    NOT NULL,
    description   TEXT            NULL,
    interval_unit VARCHAR(12)     NOT NULL DEFAULT 'monthly',
    net_price     DECIMAL(12,2)   NOT NULL DEFAULT 0,
    tax_rate      DECIMAL(5,2)    NOT NULL DEFAULT 20.00,
    active        TINYINT(1)      NOT NULL DEFAULT 1,
    start_date    DATE            NULL DEFAULT NULL,
    created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_subs_user (user_id),
    CONSTRAINT fk_subs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_subs_contact FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE TABLE IF NOT EXISTS subscription_periods (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    subscription_id BIGINT UNSIGNED NOT NULL,
    user_id         BIGINT UNSIGNED NOT NULL,
    contact_id      BIGINT UNSIGNED NULL,
    due_date        DATE            NOT NULL,
    net_price       DECIMAL(12,2)   NOT NULL DEFAULT 0,
    tax_rate        DECIMAL(5,2)    NOT NULL DEFAULT 20.00,
    paid_at         TIMESTAMP       NULL DEFAULT NULL,
    invoice_id      BIGINT UNSIGNED NULL DEFAULT NULL,
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_periods_sub (subscription_id),
    KEY ix_periods_user (user_id),
    CONSTRAINT fk_periods_sub FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE,
    CONSTRAINT fk_periods_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;
