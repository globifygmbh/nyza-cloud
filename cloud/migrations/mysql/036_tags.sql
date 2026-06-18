-- Tags / labels: a small per-user palette that can be attached to DMS files,
-- invoices/offers (documents) and expenses. Taggings are polymorphic so one
-- tag works across all three without separate join tables.
CREATE TABLE IF NOT EXISTS tags (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id    BIGINT UNSIGNED NOT NULL,
    name       VARCHAR(48)     NOT NULL,
    color      VARCHAR(16)     NOT NULL DEFAULT 'violet',
    created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_tag_name (user_id, name),
    KEY ix_tags_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS taggings (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tag_id      BIGINT UNSIGNED NOT NULL,
    entity_type VARCHAR(12)     NOT NULL,  -- 'file' | 'document' | 'expense'
    entity_id   BIGINT UNSIGNED NOT NULL,
    created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_tagging (tag_id, entity_type, entity_id),
    KEY ix_tagging_entity (entity_type, entity_id),
    CONSTRAINT fk_tagging_tag FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
