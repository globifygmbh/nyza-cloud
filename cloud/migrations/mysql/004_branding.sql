-- Nyza Cloud · 004 · Profil & Branding
-- Per-user logo (path on disk) and accent preset key. Used in the app chrome
-- and on the public share / upload pages so client-facing links look on-brand.

ALTER TABLE users ADD COLUMN logo_path VARCHAR(500) NULL DEFAULT NULL;
ALTER TABLE users ADD COLUMN accent VARCHAR(20) NULL DEFAULT NULL;
