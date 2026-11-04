-- Public AGB page per company at /agbs/{agb_slug}. The text itself lives in
-- companies.profile (agb_text); the slug is set by the server, never taken
-- from the client-writable profile JSON.
ALTER TABLE companies ADD COLUMN agb_slug VARCHAR(80) NULL;
CREATE UNIQUE INDEX companies_agb_slug ON companies (agb_slug);
