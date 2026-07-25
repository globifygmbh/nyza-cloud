-- The very first account (the real owner) can never be deleted or demoted
-- away from admin/active, no matter who else gets admin rights later.
ALTER TABLE users ADD COLUMN is_primary TINYINT(1) NOT NULL DEFAULT 0;
UPDATE users SET is_primary = 1 WHERE id = (SELECT id FROM (SELECT MIN(id) AS id FROM users) t);
