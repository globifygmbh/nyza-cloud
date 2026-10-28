-- Videos get a still-frame poster (JPEG, stored as storage/thumbs/{id}.jpg
-- like image thumbnails). It is captured in the browser — the server needs no
-- ffmpeg — and has_poster tells clients whether to show it or fall back.
ALTER TABLE files ADD COLUMN has_poster TINYINT(1) NOT NULL DEFAULT 0;
