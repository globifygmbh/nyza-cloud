-- Bind signature requests to an invoice/offer (preferred over a raw DMS file)
-- and track the signed state on the document itself.
ALTER TABLE signature_requests ADD COLUMN document_id BIGINT UNSIGNED NULL AFTER file_id;
ALTER TABLE signature_requests ADD KEY ix_sig_document (document_id);

ALTER TABLE documents ADD COLUMN signed_at DATETIME NULL DEFAULT NULL;
ALTER TABLE documents ADD COLUMN signed_file_id BIGINT UNSIGNED NULL DEFAULT NULL;
