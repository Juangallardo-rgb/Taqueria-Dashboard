-- DENIX phase 2 preflight. Read-only: this file does not modify data or schema.

-- Null tenant identifiers.
SELECT 'pedidos' AS tabla, COUNT(*) AS restaurante_id_nulo
FROM pedidos WHERE restaurante_id IS NULL
UNION ALL
SELECT 'deliveries', COUNT(*) FROM deliveries WHERE restaurante_id IS NULL
UNION ALL
SELECT 'productos', COUNT(*) FROM productos WHERE restaurante_id IS NULL
UNION ALL
SELECT 'push_subscriptions', COUNT(*) FROM push_subscriptions WHERE restaurante_id IS NULL
UNION ALL
SELECT 'acciones_woo', COUNT(*) FROM acciones_woo WHERE restaurante_id IS NULL;

-- Composite-key duplicates.
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

-- Webhook tokens must resolve one restaurant only.
SELECT webhook_token, COUNT(*) AS cantidad
FROM restaurantes
WHERE webhook_token IS NOT NULL
GROUP BY webhook_token
HAVING COUNT(*) > 1;

-- Orphaned tenant references.
SELECT 'usuarios' AS tabla, u.id::TEXT AS registro_id, u.restaurante_id
FROM usuarios u
LEFT JOIN restaurantes r ON r.id = u.restaurante_id
WHERE u.restaurante_id IS NOT NULL AND r.id IS NULL
UNION ALL
SELECT 'pedidos', p.id::TEXT, p.restaurante_id
FROM pedidos p
LEFT JOIN restaurantes r ON r.id = p.restaurante_id
WHERE p.restaurante_id IS NOT NULL AND r.id IS NULL
UNION ALL
SELECT 'deliveries', d.order_number::TEXT, d.restaurante_id
FROM deliveries d
LEFT JOIN restaurantes r ON r.id = d.restaurante_id
WHERE d.restaurante_id IS NOT NULL AND r.id IS NULL
UNION ALL
SELECT 'productos', p.id::TEXT, p.restaurante_id
FROM productos p
LEFT JOIN restaurantes r ON r.id = p.restaurante_id
WHERE p.restaurante_id IS NOT NULL AND r.id IS NULL
UNION ALL
SELECT 'push_subscriptions', ps.id::TEXT, ps.restaurante_id
FROM push_subscriptions ps
LEFT JOIN restaurantes r ON r.id = ps.restaurante_id
WHERE ps.restaurante_id IS NOT NULL AND r.id IS NULL
UNION ALL
SELECT 'acciones_woo', aw.id::TEXT, aw.restaurante_id
FROM acciones_woo aw
LEFT JOIN restaurantes r ON r.id = aw.restaurante_id
WHERE aw.restaurante_id IS NOT NULL AND r.id IS NULL
ORDER BY tabla, registro_id;

-- Exact current constraint names and definitions. Review the single-column
-- unique constraints before running the cutover migration.
SELECT
  ns.nspname AS schema_name,
  tbl.relname AS table_name,
  con.conname AS constraint_name,
  con.contype AS constraint_type,
  pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class tbl ON tbl.oid = con.conrelid
JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
WHERE ns.nspname = 'public'
  AND tbl.relname IN (
    'restaurantes',
    'usuarios',
    'pedidos',
    'deliveries',
    'productos',
    'push_subscriptions',
    'acciones_woo'
  )
ORDER BY tbl.relname, con.contype, con.conname;

-- Standalone unique indexes are reported too, because ON CONFLICT may depend
-- on an index that is not represented as a pg_constraint row.
SELECT
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('pedidos', 'deliveries', 'productos')
  AND indexdef ILIKE '%UNIQUE%'
ORDER BY tablename, indexname;
