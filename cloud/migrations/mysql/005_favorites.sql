-- Nyza Cloud · 005 · Favoriten + "zuletzt geöffnet"
ALTER TABLE files ADD COLUMN starred TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE files ADD COLUMN opened_at DATETIME NULL DEFAULT NULL;
CREATE INDEX ix_files_starred ON files (user_id, starred);
CREATE INDEX ix_files_opened ON files (user_id, opened_at);
