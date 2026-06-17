-- Nyza Cloud · 027 · Papierkorb für Ordner (folder soft delete)
-- Folders get a nullable deleted_at mirroring the files table (002_trash).
-- NULL = live, timestamp = in trash. Deleting a folder now soft-deletes the
-- folder AND every nested subfolder + file (set deleted_at = now) instead of a
-- hard cascade delete, so the whole subtree can be restored from the trash.
-- All normal folder/file listings filter `deleted_at IS NULL`.

ALTER TABLE folders ADD COLUMN deleted_at DATETIME NULL DEFAULT NULL;
CREATE INDEX ix_folders_deleted ON folders (user_id, deleted_at);
