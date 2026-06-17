-- Records the DMS file id of an archived, immutable PDF copy of the document.
ALTER TABLE documents ADD COLUMN archived_file_id BIGINT UNSIGNED NULL DEFAULT NULL;
ALTER TABLE documents ADD CONSTRAINT fk_documents_archived_file FOREIGN KEY (archived_file_id) REFERENCES files(id) ON DELETE SET NULL;
