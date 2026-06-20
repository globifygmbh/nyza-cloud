-- Custom intake forms (Typeform-style). Field definitions live as JSON on the
-- form; submissions store the answers as JSON, file uploads go to form_files.
CREATE TABLE IF NOT EXISTS forms (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT UNSIGNED NOT NULL,
    company_id  BIGINT UNSIGNED NULL,
    title       VARCHAR(255)    NOT NULL,
    description TEXT            NULL,
    fields      MEDIUMTEXT      NULL,
    token       VARCHAR(64)     NOT NULL,
    active      TINYINT(1)      NOT NULL DEFAULT 1,
    created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_form_token (token),
    KEY ix_forms_user (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS form_submissions (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    form_id    BIGINT UNSIGNED NOT NULL,
    data       MEDIUMTEXT      NULL,
    ip         VARCHAR(64)     NULL,
    created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_sub_form (form_id, created_at),
    CONSTRAINT fk_sub_form FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS form_files (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    submission_id BIGINT UNSIGNED NOT NULL,
    field_key     VARCHAR(64)     NOT NULL,
    name          VARCHAR(255)    NOT NULL,
    storage_path  VARCHAR(255)    NOT NULL,
    mime          VARCHAR(100)    NULL,
    size          BIGINT UNSIGNED NOT NULL DEFAULT 0,
    KEY ix_ff_sub (submission_id),
    CONSTRAINT fk_ff_sub FOREIGN KEY (submission_id) REFERENCES form_submissions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
