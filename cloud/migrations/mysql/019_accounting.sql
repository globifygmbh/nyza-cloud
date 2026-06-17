CREATE TABLE IF NOT EXISTS documents (
    id                      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id                 BIGINT UNSIGNED NOT NULL,
    type                    VARCHAR(10)     NOT NULL,
    number                  VARCHAR(32)     NOT NULL,
    contact_id              BIGINT UNSIGNED NULL,
    client_snapshot         TEXT            NULL,
    doc_date                DATE            NULL,
    delivery_date           DATE            NULL,
    intro_text              TEXT            NULL,
    footer_text             TEXT            NULL,
    notes                   TEXT            NULL,
    net                     DECIMAL(12,2)   NOT NULL DEFAULT 0,
    tax                     DECIMAL(12,2)   NOT NULL DEFAULT 0,
    gross                   DECIMAL(12,2)   NOT NULL DEFAULT 0,
    paid_at                 TIMESTAMP       NULL DEFAULT NULL,
    accepted_at             TIMESTAMP       NULL DEFAULT NULL,
    converted_invoice_id    BIGINT UNSIGNED NULL,
    converted_from_offer_id BIGINT UNSIGNED NULL,
    created_at              TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP       DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_documents_user (user_id),
    CONSTRAINT fk_documents_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_documents_contact FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE TABLE IF NOT EXISTS document_items (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    document_id    BIGINT UNSIGNED NOT NULL,
    position       INT             NOT NULL DEFAULT 0,
    description    VARCHAR(500)    NOT NULL DEFAULT '',
    quantity       DECIMAL(12,3)   NOT NULL DEFAULT 1,
    unit           VARCHAR(20)     NOT NULL DEFAULT 'Stk',
    unit_price_net DECIMAL(12,2)   NOT NULL DEFAULT 0,
    tax_rate       DECIMAL(5,2)    NOT NULL DEFAULT 20.00,
    KEY ix_docitems_doc (document_id),
    CONSTRAINT fk_docitems_doc FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE TABLE IF NOT EXISTS products (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id        BIGINT UNSIGNED NOT NULL,
    name           VARCHAR(255)    NOT NULL,
    description    TEXT            NULL,
    unit           VARCHAR(20)     NOT NULL DEFAULT 'Stk',
    unit_price_net DECIMAL(12,2)   NOT NULL DEFAULT 0,
    tax_rate       DECIMAL(5,2)    NOT NULL DEFAULT 20.00,
    type           VARCHAR(12)     NOT NULL DEFAULT 'service',
    created_at     TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,
    KEY ix_products_user (user_id),
    CONSTRAINT fk_products_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE TABLE IF NOT EXISTS counters (
    user_id BIGINT UNSIGNED NOT NULL,
    name    VARCHAR(32)     NOT NULL,
    value   INT             NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, name),
    CONSTRAINT fk_counters_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;
