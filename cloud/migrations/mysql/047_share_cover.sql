-- Optional cover/title image for a shared gallery (a file id within the folder).
ALTER TABLE share_links ADD COLUMN cover_file_id BIGINT UNSIGNED NULL DEFAULT NULL;
