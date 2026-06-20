-- Locked Vault: a folder can require a separate password (PIN) to list its
-- contents. Hash only; never returned to the client.
ALTER TABLE folders ADD COLUMN lock_hash VARCHAR(255) NULL DEFAULT NULL;
