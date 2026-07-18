-- Customer-portal uploads: a separate password (independent from the portal's
-- own view password) gates an upload-only capability into an owner-chosen set
-- of folders. Guests can never delete/browse via this path — only add files.
ALTER TABLE portals ADD COLUMN upload_password_hash VARCHAR(255) NULL AFTER password_hash;

CREATE TABLE IF NOT EXISTS portal_upload_folders (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    portal_id  BIGINT UNSIGNED NOT NULL,
    folder_id  BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY ux_portal_upload_folder (portal_id, folder_id),
    KEY ix_portal_upload_folders_portal (portal_id),
    CONSTRAINT fk_portal_upload_folders_portal FOREIGN KEY (portal_id) REFERENCES portals(id) ON DELETE CASCADE,
    CONSTRAINT fk_portal_upload_folders_folder FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

-- Reuse the existing chunked-upload-session mechanism (see upload_sessions,
-- 001_init.sql) for portal uploads too, instead of building a parallel one.
ALTER TABLE upload_sessions ADD COLUMN portal_id BIGINT UNSIGNED NULL AFTER upload_link_id;
ALTER TABLE upload_sessions ADD KEY ix_us_portal (portal_id);
ALTER TABLE upload_sessions ADD CONSTRAINT fk_us_portal FOREIGN KEY (portal_id) REFERENCES portals(id) ON DELETE CASCADE;
