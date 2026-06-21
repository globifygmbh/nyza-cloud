-- Per-share-link options: show file metadata/info in the viewer, and allow the
-- red/yellow/green labelling UI on the public gallery.
ALTER TABLE share_links ADD COLUMN show_info   TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE share_links ADD COLUMN show_labels TINYINT(1) NOT NULL DEFAULT 1;
