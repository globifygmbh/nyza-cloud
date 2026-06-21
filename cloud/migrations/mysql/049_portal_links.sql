-- Portals can also bundle a signature request and/or an upload link per item.
ALTER TABLE portal_items ADD COLUMN signature_id   BIGINT UNSIGNED NULL DEFAULT NULL;
ALTER TABLE portal_items ADD COLUMN upload_link_id BIGINT UNSIGNED NULL DEFAULT NULL;
