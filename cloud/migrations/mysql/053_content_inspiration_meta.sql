-- Best-effort link preview metadata (fetched via each platform's public
-- oEmbed endpoint at save time — TikTok, YouTube, Instagram all support this
-- without an API key). NULL when the platform has no oEmbed (e.g. Pinterest)
-- or the fetch failed; falls back to a plain link card in that case.
ALTER TABLE content_inspiration ADD COLUMN title VARCHAR(500) NULL AFTER url;
ALTER TABLE content_inspiration ADD COLUMN thumb_url VARCHAR(1000) NULL AFTER title;
ALTER TABLE content_inspiration ADD COLUMN author_name VARCHAR(255) NULL AFTER thumb_url;
