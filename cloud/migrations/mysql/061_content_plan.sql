-- Content Plan — redaktionelle Monatsplanung pro Kunde, mit Freigabe-Link.
--
-- Deliberately separate from the existing content_* tables: those are an
-- internal idea/media library, this is a per-client editorial calendar whose
-- months get shared with the customer for approval. Both stay usable side by
-- side.
--
-- Scoped by workspace_id (Kontogruppe), like tasks/calendar/times — a team only
-- ever sees its own clients and plans.

CREATE TABLE IF NOT EXISTS cp_clients (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NULL,
    name         VARCHAR(190)    NOT NULL,
    tone         VARCHAR(20)     NULL,          -- colour key for the calendar
    note         TEXT            NULL,
    archived_at  DATETIME        NULL,
    created_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_cpc_ws (workspace_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One planned piece of content. Several rows may share a plan_date (a post AND
-- a story on the same day), and linked_to_id ties together items that belong to
-- each other (e.g. the story that points at that day's giveaway post).
CREATE TABLE IF NOT EXISTS cp_items (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id  BIGINT UNSIGNED NULL,
    client_id     BIGINT UNSIGNED NOT NULL,
    plan_date     DATE            NOT NULL,
    plan_time     TIME            NULL,
    title         VARCHAR(300)    NOT NULL,
    idea          TEXT            NULL,         -- the concept / briefing
    caption       TEXT            NULL,         -- final copy incl. hashtags
    formats       VARCHAR(120)    NOT NULL DEFAULT '',  -- csv: post,story,reel
    platforms     VARCHAR(200)    NOT NULL DEFAULT '',  -- csv: instagram,tiktok,…
    status        VARCHAR(20)     NOT NULL DEFAULT 'idea', -- idea|draft|ready|scheduled|posted
    review_status VARCHAR(20)     NOT NULL DEFAULT 'pending', -- pending|approved|rejected|revision
    review_comment TEXT           NULL,
    reviewed_at   DATETIME        NULL,
    reviewed_by   VARCHAR(160)    NULL,
    linked_to_id  BIGINT UNSIGNED NULL,
    sort_order    INT             NOT NULL DEFAULT 0,
    created_by    BIGINT UNSIGNED NULL,
    created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_cpi_client_date (client_id, plan_date),
    KEY ix_cpi_ws (workspace_id),
    CONSTRAINT fk_cpi_client FOREIGN KEY (client_id) REFERENCES cp_clients(id) ON DELETE CASCADE,
    CONSTRAINT fk_cpi_link   FOREIGN KEY (linked_to_id) REFERENCES cp_items(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Two media slots per item: 'idea' (reference/mood) and 'result' (the finished
-- asset the customer approves). Several files per slot are allowed.
CREATE TABLE IF NOT EXISTS cp_media (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    item_id    BIGINT UNSIGNED NOT NULL,
    kind       VARCHAR(10)     NOT NULL DEFAULT 'result',  -- idea|result
    path       VARCHAR(500)    NOT NULL,
    name       VARCHAR(255)    NOT NULL,
    mime       VARCHAR(100)    NULL,
    size       BIGINT UNSIGNED NOT NULL DEFAULT 0,
    created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_cpm_item (item_id, kind),
    CONSTRAINT fk_cpm_item FOREIGN KEY (item_id) REFERENCES cp_items(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One shareable link per client and month. Re-sharing the same month returns
-- the existing token, so a link handed to a customer keeps working and simply
-- shows whatever the month currently holds.
CREATE TABLE IF NOT EXISTS cp_shares (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id  BIGINT UNSIGNED NULL,
    client_id     BIGINT UNSIGNED NOT NULL,
    year          SMALLINT UNSIGNED NOT NULL,
    month         TINYINT UNSIGNED  NOT NULL,
    token         VARCHAR(64)     NOT NULL,
    password_hash VARCHAR(255)    NULL,
    intro         TEXT            NULL,
    created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_cps_token (token),
    UNIQUE KEY uq_cps_month (client_id, year, month),
    CONSTRAINT fk_cps_client FOREIGN KEY (client_id) REFERENCES cp_clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Discussion thread per item. The customer writes through the share link
-- (user_id NULL), the team writes from inside the app.
CREATE TABLE IF NOT EXISTS cp_comments (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    item_id    BIGINT UNSIGNED NOT NULL,
    user_id    BIGINT UNSIGNED NULL,
    author     VARCHAR(160)    NOT NULL,
    body       TEXT            NOT NULL,
    decision   VARCHAR(20)     NULL,   -- set when the comment accompanied a review
    created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_cpcm_item (item_id, id),
    CONSTRAINT fk_cpcm_item FOREIGN KEY (item_id) REFERENCES cp_items(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
