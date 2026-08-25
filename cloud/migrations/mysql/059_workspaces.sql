-- Kontogruppen (workspaces) — an isolation layer ABOVE companies.
--
-- Until now the installation was one big shared workspace: tasks and calendar
-- events were visible to every logged-in user, the member list showed every
-- account, and any admin implicitly saw every company's accounting. That works
-- for one team, but not for several unrelated teams sharing the install.
--
-- A workspace owns both USERS and COMPANIES. Everything a user can reach is
-- resolved through their workspace, so two groups on the same installation
-- never see each other's tasks, times, contacts, employees or Buchhaltung.
-- Only the Hauptadmin (users.is_primary) crosses workspace boundaries.
--
-- Backfill keeps the status quo exactly: one workspace holding everything that
-- exists today. New groups are created afterwards in the admin UI.
CREATE TABLE IF NOT EXISTS workspaces (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(190) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO workspaces (id, name)
SELECT 1, 'Mein Team' FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM workspaces);

ALTER TABLE users           ADD COLUMN workspace_id BIGINT UNSIGNED NULL AFTER role;
ALTER TABLE companies       ADD COLUMN workspace_id BIGINT UNSIGNED NULL;
ALTER TABLE tasks           ADD COLUMN workspace_id BIGINT UNSIGNED NULL;
ALTER TABLE calendar_events ADD COLUMN workspace_id BIGINT UNSIGNED NULL;
ALTER TABLE time_entries    ADD COLUMN workspace_id BIGINT UNSIGNED NULL;

UPDATE users           SET workspace_id = (SELECT MIN(id) FROM workspaces) WHERE workspace_id IS NULL;
UPDATE companies       SET workspace_id = (SELECT MIN(id) FROM workspaces) WHERE workspace_id IS NULL;
UPDATE tasks           SET workspace_id = (SELECT MIN(id) FROM workspaces) WHERE workspace_id IS NULL;
UPDATE calendar_events SET workspace_id = (SELECT MIN(id) FROM workspaces) WHERE workspace_id IS NULL;
UPDATE time_entries    SET workspace_id = (SELECT MIN(id) FROM workspaces) WHERE workspace_id IS NULL;

ALTER TABLE users           ADD KEY ix_users_workspace (workspace_id);
ALTER TABLE companies       ADD KEY ix_companies_workspace (workspace_id);
ALTER TABLE tasks           ADD KEY ix_tasks_workspace (workspace_id);
ALTER TABLE calendar_events ADD KEY ix_calendar_workspace (workspace_id);
ALTER TABLE time_entries    ADD KEY ix_time_workspace (workspace_id);

-- ON DELETE SET NULL rather than CASCADE: deleting a group must never silently
-- delete its members' work. WorkspaceContext re-homes orphaned rows instead.
ALTER TABLE users     ADD CONSTRAINT fk_users_workspace     FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;
ALTER TABLE companies ADD CONSTRAINT fk_companies_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;
