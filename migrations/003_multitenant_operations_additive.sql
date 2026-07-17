-- DENIX phase 2 additive preparation.
-- Run only after 001 and a clean 002 preflight. No global unique constraint is removed here.

BEGIN;

ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS restaurante_id INTEGER;

UPDATE deliveries
SET restaurante_id = 1
WHERE restaurante_id IS NULL;

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

CREATE UNIQUE INDEX IF NOT EXISTS ux_pedidos_restaurante_woo_order_id
  ON pedidos (restaurante_id, woo_order_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_deliveries_restaurante_order_number
  ON deliveries (restaurante_id, order_number);

CREATE UNIQUE INDEX IF NOT EXISTS ux_productos_restaurante_woo_product_id
  ON productos (restaurante_id, woo_product_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_restaurantes_webhook_token_not_null
  ON restaurantes (webhook_token)
  WHERE webhook_token IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_usuarios_restaurante'
      AND conrelid = 'usuarios'::regclass
  ) THEN
    ALTER TABLE usuarios
      ADD CONSTRAINT fk_usuarios_restaurante
      FOREIGN KEY (restaurante_id) REFERENCES restaurantes(id) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_pedidos_restaurante'
      AND conrelid = 'pedidos'::regclass
  ) THEN
    ALTER TABLE pedidos
      ADD CONSTRAINT fk_pedidos_restaurante
      FOREIGN KEY (restaurante_id) REFERENCES restaurantes(id) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_deliveries_restaurante'
      AND conrelid = 'deliveries'::regclass
  ) THEN
    ALTER TABLE deliveries
      ADD CONSTRAINT fk_deliveries_restaurante
      FOREIGN KEY (restaurante_id) REFERENCES restaurantes(id) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_productos_restaurante'
      AND conrelid = 'productos'::regclass
  ) THEN
    ALTER TABLE productos
      ADD CONSTRAINT fk_productos_restaurante
      FOREIGN KEY (restaurante_id) REFERENCES restaurantes(id) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_push_subscriptions_restaurante'
      AND conrelid = 'push_subscriptions'::regclass
  ) THEN
    ALTER TABLE push_subscriptions
      ADD CONSTRAINT fk_push_subscriptions_restaurante
      FOREIGN KEY (restaurante_id) REFERENCES restaurantes(id) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_acciones_woo_restaurante'
      AND conrelid = 'acciones_woo'::regclass
  ) THEN
    ALTER TABLE acciones_woo
      ADD CONSTRAINT fk_acciones_woo_restaurante
      FOREIGN KEY (restaurante_id) REFERENCES restaurantes(id) NOT VALID;
  END IF;
END
$$;

COMMIT;
