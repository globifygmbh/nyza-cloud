-- Contacts scoping used to carry a legacy escape hatch: rows with a NULL
-- company_id were shown to everyone, so pre-scoping data wouldn't vanish.
-- With Kontogruppen (059) that hatch reaches ACROSS the isolation boundary —
-- a NULL contact would be visible to every group — so the query side now
-- requires a real company_id.
--
-- Anything still NULL (e.g. imported through the CSV path, which didn't set a
-- company before this release) is homed to the oldest company, which is where
-- migration 058 already put every other pre-existing contact.
UPDATE contacts
   SET company_id = (SELECT id FROM (SELECT MIN(id) AS id FROM companies) t)
 WHERE company_id IS NULL;
