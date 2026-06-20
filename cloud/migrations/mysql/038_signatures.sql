-- E-signature requests. A DMS file (or just a title) is sent to a signer via a
-- public token link; the drawn signature + audit data produce a signed
-- certificate PDF archived back into the owner's DMS.
CREATE TABLE IF NOT EXISTS signature_requests (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id        BIGINT UNSIGNED NOT NULL,
    company_id     BIGINT UNSIGNED NULL,
    file_id        BIGINT UNSIGNED NULL,
    title          VARCHAR(255)    NOT NULL,
    signer_name    VARCHAR(255)    NULL,
    signer_email   VARCHAR(255)    NULL,
    message        TEXT            NULL,
    token          VARCHAR(64)     NOT NULL,
    status         VARCHAR(12)     NOT NULL DEFAULT 'pending',
    signed_name    VARCHAR(255)    NULL,
    signed_at      DATETIME        NULL,
    signer_ip      VARCHAR(64)     NULL,
    source_hash    VARCHAR(64)     NULL,
    signed_file_id BIGINT UNSIGNED NULL,
    created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_sig_token (token),
    KEY ix_sig_user (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
