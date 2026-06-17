CREATE TABLE IF NOT EXISTS ledger_accounts (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id    BIGINT UNSIGNED NOT NULL,
    number     VARCHAR(10)     NOT NULL,
    name       VARCHAR(120)    NOT NULL,
    type       VARCHAR(12)     NOT NULL,
    created_at TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_ledacc (user_id, number),
    CONSTRAINT fk_ledacc_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE TABLE IF NOT EXISTS journal_entries (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT UNSIGNED NOT NULL,
    entry_date  DATE            NOT NULL,
    description VARCHAR(300)    NULL,
    created_at  TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,
    KEY ix_journal_entries_user (user_id),
    CONSTRAINT fk_journal_entries_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE TABLE IF NOT EXISTS journal_lines (
    id       BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    entry_id BIGINT UNSIGNED NOT NULL,
    account  VARCHAR(10)     NOT NULL,
    debit    DECIMAL(12,2)   NOT NULL DEFAULT 0,
    credit   DECIMAL(12,2)   NOT NULL DEFAULT 0,
    KEY ix_journal_lines_entry (entry_id),
    CONSTRAINT fk_journal_lines_entry FOREIGN KEY (entry_id) REFERENCES journal_entries(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;
