-- Nyza Cloud · 002 · Papierkorb (soft delete)
-- Files get a nullable deleted_at. NULL = live, timestamp = in trash.
-- All normal listings filter `deleted_at IS NULL`; the trash view selects the
-- inverse. Blobs are only removed on permanent delete / empty-trash.

ALTER TABLE files ADD COLUMN deleted_at DATETIME NULL DEFAULT NULL;
CREATE INDEX ix_files_deleted ON files (user_id, deleted_at);
