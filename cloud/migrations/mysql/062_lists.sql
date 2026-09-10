-- Listen — simple shared checklists for the team.
--
-- Scoped by workspace_id (Kontogruppe) like tasks and calendar, so every member
-- of a group sees and edits the same lists, and other groups see none of them.
CREATE TABLE IF NOT EXISTS checklists (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NULL,
    name         VARCHAR(190)    NOT NULL,
    note         TEXT            NULL,
    tone         VARCHAR(20)     NULL,
    sort_order   INT             NOT NULL DEFAULT 0,
    created_by   BIGINT UNSIGNED NULL,
    created_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_cl_ws (workspace_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- done_by/done_at are kept so a shared list shows who ticked something off.
CREATE TABLE IF NOT EXISTS checklist_items (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    list_id    BIGINT UNSIGNED NOT NULL,
    text       TEXT            NOT NULL,
    note       TEXT            NULL,
    done       TINYINT(1)      NOT NULL DEFAULT 0,
    done_at    DATETIME        NULL,
    done_by    BIGINT UNSIGNED NULL,
    sort_order INT             NOT NULL DEFAULT 0,
    created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_cli_list (list_id, sort_order, id),
    CONSTRAINT fk_cli_list FOREIGN KEY (list_id) REFERENCES checklists(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
