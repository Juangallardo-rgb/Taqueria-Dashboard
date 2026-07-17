-- DENIX phase 1: additive multi-restaurant foundation.
-- Review this file before running it. It has not been executed by Codex.

BEGIN;

ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS restaurante_id INTEGER;

ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

UPDATE deliveries
SET restaurante_id = 1
WHERE restaurante_id IS NULL;

ALTER TABLE restaurantes
  ADD COLUMN IF NOT EXISTS activo BOOLEAN DEFAULT TRUE;

ALTER TABLE restaurantes
  ADD COLUMN IF NOT EXISTS webhook_token TEXT;

ALTER TABLE restaurantes
  ADD COLUMN IF NOT EXISTS woo_webhook_secret TEXT;

ALTER TABLE restaurantes
  ADD COLUMN IF NOT EXISTS shipday_webhook_secret TEXT;

ALTER TABLE restaurantes
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE restaurantes
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- connect-pg-simple uses this table. Runtime DDL is intentionally disabled.
CREATE TABLE IF NOT EXISTS user_sessions (
  sid VARCHAR PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP(6) WITHOUT TIME ZONE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_expire
  ON user_sessions (expire);

CREATE INDEX IF NOT EXISTS idx_pedidos_restaurante_created_at
  ON pedidos (restaurante_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pedidos_restaurante_woo_order_id
  ON pedidos (restaurante_id, woo_order_id);

CREATE INDEX IF NOT EXISTS idx_deliveries_restaurante_order_number
  ON deliveries (restaurante_id, order_number);

CREATE INDEX IF NOT EXISTS idx_productos_restaurante_deleted
  ON productos (restaurante_id, deleted);

CREATE INDEX IF NOT EXISTS idx_acciones_woo_restaurante_estado_created_at
  ON acciones_woo (restaurante_id, estado, created_at);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_restaurante_activo
  ON push_subscriptions (restaurante_id, activo);

COMMIT;

-- Diagnóstico: estas consultas solamente reportan problemas; no corrigen ni borran datos.

SELECT restaurante_id, woo_order_id, COUNT(*) AS cantidad
FROM pedidos
GROUP BY restaurante_id, woo_order_id
HAVING COUNT(*) > 1
ORDER BY cantidad DESC, restaurante_id, woo_order_id;

SELECT restaurante_id, order_number, COUNT(*) AS cantidad
FROM deliveries
GROUP BY restaurante_id, order_number
HAVING COUNT(*) > 1
ORDER BY cantidad DESC, restaurante_id, order_number;

SELECT restaurante_id, woo_product_id, COUNT(*) AS cantidad
FROM productos
GROUP BY restaurante_id, woo_product_id
HAVING COUNT(*) > 1
ORDER BY cantidad DESC, restaurante_id, woo_product_id;

SELECT 'pedidos.restaurante_id' AS campo, COUNT(*) AS valores_nulos
FROM pedidos
WHERE restaurante_id IS NULL
UNION ALL
SELECT 'deliveries.restaurante_id', COUNT(*)
FROM deliveries
WHERE restaurante_id IS NULL
UNION ALL
SELECT 'productos.restaurante_id', COUNT(*)
FROM productos
WHERE restaurante_id IS NULL
UNION ALL
SELECT 'acciones_woo.restaurante_id', COUNT(*)
FROM acciones_woo
WHERE restaurante_id IS NULL
UNION ALL
SELECT 'push_subscriptions.restaurante_id', COUNT(*)
FROM push_subscriptions
WHERE restaurante_id IS NULL;
