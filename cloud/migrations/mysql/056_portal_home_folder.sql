-- Lets the owner designate one granted folder as the customer's "home" —
-- shown open with its content immediately instead of as a tile to click.
ALTER TABLE portals ADD COLUMN home_folder_id BIGINT UNSIGNED NULL AFTER upload_password_hash;
ALTER TABLE portals ADD CONSTRAINT fk_portals_home_folder FOREIGN KEY (home_folder_id) REFERENCES folders(id) ON DELETE SET NULL;
