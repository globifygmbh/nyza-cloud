-- Nyza Cloud · 027 · 2FA recovery codes
-- Stores a JSON array of HASHED single-use recovery codes (sha256 hex) so a
-- user who loses their authenticator can still complete the 2FA login step.
-- TEXT (not JSON column type) for portability with MariaDB 10.0 / MySQL <= 5.7.7.
ALTER TABLE users ADD COLUMN twofa_recovery TEXT NULL DEFAULT NULL;
