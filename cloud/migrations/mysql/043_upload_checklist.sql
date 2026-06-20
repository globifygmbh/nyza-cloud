-- Upload links can run as a checklist ("Datei-Anfrage"): predefined items the
-- uploader satisfies one by one. Uploaded files remember which item they fill.
ALTER TABLE upload_links ADD COLUMN checklist MEDIUMTEXT NULL;
ALTER TABLE files ADD COLUMN checklist_key VARCHAR(40) NULL DEFAULT NULL;
ALTER TABLE upload_sessions ADD COLUMN checklist_key VARCHAR(40) NULL DEFAULT NULL;
