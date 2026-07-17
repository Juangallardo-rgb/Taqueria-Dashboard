-- DENIX phase 2 cutover.
-- Execute only after the new backend is validated with restaurant 1 and the
-- 002 preflight returns no nulls, duplicates or orphaned tenant references.

BEGIN;

DO $$
DECLARE
  problem_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO problem_count
  FROM (
    SELECT restaurante_id FROM pedidos WHERE restaurante_id IS NULL
    UNION ALL
    SELECT restaurante_id FROM deliveries WHERE restaurante_id IS NULL
    UNION ALL
    SELECT restaurante_id FROM productos WHERE restaurante_id IS NULL
    UNION ALL
    SELECT restaurante_id FROM push_subscriptions WHERE restaurante_id IS NULL
    UNION ALL
    SELECT restaurante_id FROM acciones_woo WHERE restaurante_id IS NULL
  ) null_tenants;

  IF problem_count > 0 THEN
    RAISE EXCEPTION 'Cutover cancelado: existen % restaurante_id nulos', problem_count;
  END IF;

  SELECT COUNT(*) INTO problem_count
  FROM (
    SELECT restaurante_id, woo_order_id
    FROM pedidos
    GROUP BY restaurante_id, woo_order_id
    HAVING COUNT(*) > 1
  ) duplicates;

  IF problem_count > 0 THEN
    RAISE EXCEPTION 'Cutover cancelado: existen duplicados de pedidos';
  END IF;

  SELECT COUNT(*) INTO problem_count
  FROM (
    SELECT restaurante_id, order_number
    FROM deliveries
    GROUP BY restaurante_id, order_number
    HAVING COUNT(*) > 1
  ) duplicates;

  IF problem_count > 0 THEN
    RAISE EXCEPTION 'Cutover cancelado: existen duplicados de deliveries';
  END IF;

  SELECT COUNT(*) INTO problem_count
  FROM (
    SELECT restaurante_id, woo_product_id
    FROM productos
    GROUP BY restaurante_id, woo_product_id
    HAVING COUNT(*) > 1
  ) duplicates;

  IF problem_count > 0 THEN
    RAISE EXCEPTION 'Cutover cancelado: existen duplicados de productos';
  END IF;

  SELECT COUNT(*) INTO problem_count
  FROM (
    SELECT u.restaurante_id
    FROM usuarios u LEFT JOIN restaurantes r ON r.id = u.restaurante_id
    WHERE u.restaurante_id IS NOT NULL AND r.id IS NULL
    UNION ALL
    SELECT p.restaurante_id
    FROM pedidos p LEFT JOIN restaurantes r ON r.id = p.restaurante_id
    WHERE p.restaurante_id IS NOT NULL AND r.id IS NULL
    UNION ALL
    SELECT d.restaurante_id
    FROM deliveries d LEFT JOIN restaurantes r ON r.id = d.restaurante_id
    WHERE d.restaurante_id IS NOT NULL AND r.id IS NULL
    UNION ALL
    SELECT p.restaurante_id
    FROM productos p LEFT JOIN restaurantes r ON r.id = p.restaurante_id
    WHERE p.restaurante_id IS NOT NULL AND r.id IS NULL
    UNION ALL
    SELECT ps.restaurante_id
    FROM push_subscriptions ps LEFT JOIN restaurantes r ON r.id = ps.restaurante_id
    WHERE ps.restaurante_id IS NOT NULL AND r.id IS NULL
    UNION ALL
    SELECT aw.restaurante_id
    FROM acciones_woo aw LEFT JOIN restaurantes r ON r.id = aw.restaurante_id
    WHERE aw.restaurante_id IS NOT NULL AND r.id IS NULL
  ) orphans;

  IF problem_count > 0 THEN
    RAISE EXCEPTION 'Cutover cancelado: existen referencias de restaurante huérfanas';
  END IF;
END
$$;

ALTER TABLE usuarios VALIDATE CONSTRAINT fk_usuarios_restaurante;
ALTER TABLE pedidos VALIDATE CONSTRAINT fk_pedidos_restaurante;
ALTER TABLE deliveries VALIDATE CONSTRAINT fk_deliveries_restaurante;
ALTER TABLE productos VALIDATE CONSTRAINT fk_productos_restaurante;
ALTER TABLE push_subscriptions VALIDATE CONSTRAINT fk_push_subscriptions_restaurante;
ALTER TABLE acciones_woo VALIDATE CONSTRAINT fk_acciones_woo_restaurante;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_pedidos_restaurante_woo_order_id'
      AND conrelid = 'pedidos'::regclass
  ) THEN
    ALTER TABLE pedidos
      ADD CONSTRAINT uq_pedidos_restaurante_woo_order_id
      UNIQUE USING INDEX ux_pedidos_restaurante_woo_order_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_deliveries_restaurante_order_number'
      AND conrelid = 'deliveries'::regclass
  ) THEN
    ALTER TABLE deliveries
      ADD CONSTRAINT uq_deliveries_restaurante_order_number
      UNIQUE USING INDEX ux_deliveries_restaurante_order_number;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_productos_restaurante_woo_product_id'
      AND conrelid = 'productos'::regclass
  ) THEN
    ALTER TABLE productos
      ADD CONSTRAINT uq_productos_restaurante_woo_product_id
      UNIQUE USING INDEX ux_productos_restaurante_woo_product_id;
  END IF;
END
$$;

ALTER TABLE pedidos ALTER COLUMN restaurante_id SET NOT NULL;
ALTER TABLE deliveries ALTER COLUMN restaurante_id SET NOT NULL;
ALTER TABLE productos ALTER COLUMN restaurante_id SET NOT NULL;
ALTER TABLE push_subscriptions ALTER COLUMN restaurante_id SET NOT NULL;
ALTER TABLE acciones_woo ALTER COLUMN restaurante_id SET NOT NULL;

-- Drop only single-column unique constraints that block duplicate external IDs
-- across tenants. Composite constraints created above are not selected.
DO $$
DECLARE
  target RECORD;
BEGIN
  FOR target IN
    SELECT
      con.conrelid::regclass AS table_name,
      con.conname AS constraint_name
    FROM pg_constraint con
    JOIN LATERAL (
      SELECT array_agg(att.attname::TEXT ORDER BY key_columns.ordinality) AS column_names
      FROM unnest(con.conkey) WITH ORDINALITY AS key_columns(attnum, ordinality)
      JOIN pg_attribute att
        ON att.attrelid = con.conrelid
       AND att.attnum = key_columns.attnum
    ) columns ON TRUE
    WHERE con.contype = 'u'
      AND (
        (con.conrelid = 'pedidos'::regclass
          AND columns.column_names = ARRAY['woo_order_id'])
        OR
        (con.conrelid = 'deliveries'::regclass
          AND columns.column_names = ARRAY['order_number'])
        OR
        (con.conrelid = 'productos'::regclass
          AND columns.column_names = ARRAY['woo_product_id'])
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE %s DROP CONSTRAINT %I',
      target.table_name,
      target.constraint_name
    );
  END LOOP;
END
$$;

-- Drop equivalent standalone single-column unique indexes, if any. Indexes
-- backing pg_constraint rows were already handled above.
DO $$
DECLARE
  target RECORD;
BEGIN
  FOR target IN
    SELECT
      index_ns.nspname AS schema_name,
      index_class.relname AS index_name
    FROM pg_index idx
    JOIN pg_class table_class ON table_class.oid = idx.indrelid
    JOIN pg_class index_class ON index_class.oid = idx.indexrelid
    JOIN pg_namespace index_ns ON index_ns.oid = index_class.relnamespace
    LEFT JOIN pg_constraint con ON con.conindid = idx.indexrelid
    JOIN LATERAL (
      SELECT array_agg(att.attname::TEXT ORDER BY key_columns.ordinality) AS column_names
      FROM unnest(idx.indkey) WITH ORDINALITY AS key_columns(attnum, ordinality)
      JOIN pg_attribute att
        ON att.attrelid = idx.indrelid
       AND att.attnum = key_columns.attnum
    ) columns ON TRUE
    WHERE idx.indisunique
      AND NOT idx.indisprimary
      AND con.oid IS NULL
      AND index_ns.nspname = 'public'
      AND (
        (table_class.relname = 'pedidos'
          AND columns.column_names = ARRAY['woo_order_id'])
        OR
        (table_class.relname = 'deliveries'
          AND columns.column_names = ARRAY['order_number'])
        OR
        (table_class.relname = 'productos'
          AND columns.column_names = ARRAY['woo_product_id'])
      )
  LOOP
    EXECUTE format('DROP INDEX %I.%I', target.schema_name, target.index_name);
  END LOOP;
END
$$;

COMMIT;
