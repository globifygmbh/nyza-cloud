-- Contacts were a flat "everyone with a login sees every contact" shared pool
-- (no scoping at all). Bring them under the same company-membership model
-- Buchhaltung already uses, so access has to be explicitly granted.
ALTER TABLE contacts ADD COLUMN company_id BIGINT UNSIGNED NULL AFTER user_id;
UPDATE contacts SET company_id = (SELECT id FROM (SELECT MIN(id) AS id FROM companies) t) WHERE company_id IS NULL;
ALTER TABLE contacts ADD KEY ix_contacts_company (company_id);
ALTER TABLE contacts ADD CONSTRAINT fk_contacts_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL;
