-- Internal sharing between workspace members. An owner shares one folder OR one
-- file with a specific other member (read access). can_edit is stored for a
-- future write-permission feature but is not enforced yet.
CREATE TABLE IF NOT EXISTS internal_shares (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    owner_id       BIGINT UNSIGNED NOT NULL,
    target_user_id BIGINT UNSIGNED NOT NULL,
    folder_id      BIGINT UNSIGNED NULL,
    file_id        BIGINT UNSIGNED NULL,
    can_edit       TINYINT(1)      NOT NULL DEFAULT 0,
    created_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_is_target (target_user_id),
    KEY ix_is_folder (folder_id),
    KEY ix_is_file (file_id),
    CONSTRAINT fk_is_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_is_target FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;
