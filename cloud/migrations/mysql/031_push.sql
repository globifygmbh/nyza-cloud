-- Web Push notifications: per-user subscriptions, VAPID keypair store, and a
-- sent-dedup ledger so the cron never fires the same reminder twice.

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id    BIGINT UNSIGNED NOT NULL,
    endpoint   VARCHAR(500)    NOT NULL,
    p256dh     VARCHAR(255)    NOT NULL,
    auth       VARCHAR(255)    NOT NULL,
    created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_endpoint (endpoint(191)),
    KEY ix_push_user (user_id),
    CONSTRAINT fk_push_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE TABLE IF NOT EXISTS app_kv (
    k VARCHAR(64) NOT NULL PRIMARY KEY,
    v TEXT        NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE TABLE IF NOT EXISTS push_sent (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id    BIGINT UNSIGNED NOT NULL,
    dedup_key  VARCHAR(191)    NOT NULL,
    sent_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_sent (user_id, dedup_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;
