-- Per-document "z. Hd." (attention) override, freely editable independent of
-- the linked contact's own contact_person, and a free-text info line per
-- invoice/offer line item shown under its description.
ALTER TABLE documents ADD COLUMN attn_name VARCHAR(255) NULL AFTER contact_id;
ALTER TABLE document_items ADD COLUMN note VARCHAR(1000) NULL AFTER description;
