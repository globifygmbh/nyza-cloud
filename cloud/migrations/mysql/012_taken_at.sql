ALTER TABLE files ADD COLUMN taken_at DATETIME NULL DEFAULT NULL COMMENT 'EXIF DateTimeOriginal — fällt auf created_at zurück';
