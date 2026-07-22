'use strict';

const PRODUCT_COLUMNS = `
  id,
  woo_product_id,
  nombre,
  precio,
  regular_price,
  sale_price,
  estado,
  stock_status,
  imagen,
  categorias,
  raw,
  deleted,
  updated_at`;

const CLIENT_MESSAGES = {
  create_product: 'Producto creado',
  update_product: 'Producto actualizado',
  delete_product: 'Producto eliminado'
};

const OPTIMISTIC_FIELDS = [
  'name',
  'price',
  'regular_price',
  'sale_price',
  'description',
  'short_description',
  'status',
  'stock_status',
  'categories',
  'images'
];

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function asObject(value) {
  const parsed = parseJson(value, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed
    : {};
}

function asArray(value) {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function toDatabaseNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeProductRow(row) {
  if (!row) return null;

  const raw = asObject(row.raw);
  const categories = asArray(row.categorias ?? raw.categories);
  const wooProductId = String(row.woo_product_id);
  const numericId = Number(wooProductId);
  const image = row.imagen || raw.images?.[0]?.src || null;

  return {
    ...raw,
    id: Number.isSafeInteger(numericId) ? numericId : wooProductId,
    woo_product_id: wooProductId,
    name: row.nombre || raw.name || 'Producto',
    nombre: row.nombre || raw.name || 'Producto',
    price: String(row.precio ?? raw.price ?? '0'),
    precio: row.precio,
    regular_price: String(row.regular_price ?? raw.regular_price ?? '0'),
    sale_price: String(row.sale_price ?? raw.sale_price ?? ''),
    status: row.estado || raw.status || '',
    stock_status: row.stock_status || raw.stock_status || '',
    images: image ? [{ src: image }] : (raw.images || []),
    categories,
    db_id: row.id,
    deleted: Boolean(row.deleted),
    updated_at: row.updated_at
  };
}

function mergeLocalProduct(row, payload) {
  const currentRaw = asObject(row.raw);
  const nextRaw = { ...currentRaw, ...(payload || {}) };
  const categories = hasOwn(payload, 'categories')
    ? asArray(payload.categories)
    : asArray(row.categorias ?? currentRaw.categories);
  const images = hasOwn(payload, 'images')
    ? asArray(payload.images)
    : asArray(currentRaw.images);

  return {
    nombre: hasOwn(payload, 'name') ? String(payload.name || '') : row.nombre,
    precio: hasOwn(payload, 'price')
      ? toDatabaseNumber(payload.price, row.precio)
      : row.precio,
    regularPrice: hasOwn(payload, 'regular_price')
      ? toDatabaseNumber(payload.regular_price, row.regular_price)
      : row.regular_price,
    salePrice: hasOwn(payload, 'sale_price')
      ? toDatabaseNumber(payload.sale_price, row.sale_price)
      : row.sale_price,
    estado: hasOwn(payload, 'status') ? String(payload.status || '') : row.estado,
    stockStatus: hasOwn(payload, 'stock_status')
      ? String(payload.stock_status || '')
      : row.stock_status,
    imagen: images[0]?.src || row.imagen || null,
    categorias: categories,
    raw: nextRaw
  };
}

function parseWooModifiedAt(product) {
  const value = product?.date_modified_gmt;
  if (!value) return null;
  const timestamp = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function shouldProtectOptimisticFields(action, product, now = Date.now()) {
  if (!action) return false;
  if (action.estado === 'pending') return true;
  if (action.estado !== 'completed') return false;

  const completedAt = Date.parse(action.completed_at);
  if (!Number.isFinite(completedAt)) return false;

  const wooModifiedAt = parseWooModifiedAt(product);
  if (wooModifiedAt !== null) return wooModifiedAt <= completedAt;

  return now - completedAt <= 30000;
}

function protectWebhookProduct(product, action, now) {
  if (!shouldProtectOptimisticFields(action, product, now)) return product;

  const expected = asObject(action.payload);
  const protectedProduct = { ...product };

  for (const field of OPTIMISTIC_FIELDS) {
    if (hasOwn(expected, field)) protectedProduct[field] = expected[field];
  }

  return protectedProduct;
}

class ProductMutationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ProductMutationError';
    this.statusCode = statusCode;
  }
}

function createProductCrudService({ pool, cache, now = Date.now }) {
  async function listProducts(restauranteId, { fresh = false } = {}) {
    if (!fresh) {
      const cached = cache.get(restauranteId);
      if (cached !== undefined) return cached;
    }

    const result = await pool.query(
      `SELECT ${PRODUCT_COLUMNS}
       FROM productos
       WHERE restaurante_id = $1
         AND deleted = false
       ORDER BY nombre ASC`,
      [restauranteId]
    );

    return cache.set(restauranteId, result.rows);
  }

  async function findDuplicateAction(client, restauranteId, tipo, wooProductId, payload) {
    if (tipo === 'create_product') return null;

    const actionKey = [
      restauranteId,
      tipo,
      wooProductId,
      JSON.stringify(payload || {})
    ].join(':');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [actionKey]
    );

    const result = await client.query(
      `SELECT *
       FROM acciones_woo
       WHERE restaurante_id = $1
         AND tipo = $2
         AND woo_product_id IS NOT DISTINCT FROM $3
         AND estado = 'pending'
         AND payload::jsonb = $4::jsonb
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [restauranteId, tipo, wooProductId, JSON.stringify(payload || {})]
    );

    return result.rows[0] || null;
  }

  async function insertAction(client, restauranteId, tipo, wooProductId, payload) {
    const duplicate = await findDuplicateAction(
      client,
      restauranteId,
      tipo,
      wooProductId,
      payload
    );
    if (duplicate) return duplicate;

    const result = await client.query(
      `INSERT INTO acciones_woo
        (restaurante_id, tipo, woo_product_id, payload, estado, created_at, updated_at)
       VALUES
        ($1, $2, $3, $4, 'pending', NOW(), NOW())
       RETURNING *`,
      [restauranteId, tipo, wooProductId, JSON.stringify(payload || {})]
    );

    return result.rows[0];
  }

  async function lockProduct(client, restauranteId, wooProductId) {
    const result = await client.query(
      `SELECT ${PRODUCT_COLUMNS}
       FROM productos
       WHERE restaurante_id = $1
         AND woo_product_id = $2
         AND deleted = false
       FOR UPDATE`,
      [restauranteId, wooProductId]
    );

    if (!result.rows.length) {
      throw new ProductMutationError('Producto no encontrado', 404);
    }

    return result.rows[0];
  }

  async function updateLocalProduct(client, restauranteId, wooProductId, payload) {
    const current = await lockProduct(client, restauranteId, wooProductId);
    const next = mergeLocalProduct(current, payload);
    const result = await client.query(
      `UPDATE productos
       SET nombre = $3,
           precio = $4,
           regular_price = $5,
           sale_price = $6,
           estado = $7,
           stock_status = $8,
           imagen = $9,
           categorias = $10,
           raw = $11,
           updated_at = NOW()
       WHERE restaurante_id = $1
         AND woo_product_id = $2
         AND deleted = false
       RETURNING ${PRODUCT_COLUMNS}`,
      [
        restauranteId,
        wooProductId,
        next.nombre,
        next.precio,
        next.regularPrice,
        next.salePrice,
        next.estado,
        next.stockStatus,
        next.imagen,
        JSON.stringify(next.categorias),
        JSON.stringify(next.raw)
      ]
    );

    return result.rows[0];
  }

  async function deleteLocalProduct(client, restauranteId, wooProductId) {
    await lockProduct(client, restauranteId, wooProductId);
    const result = await client.query(
      `UPDATE productos
       SET deleted = true,
           updated_at = NOW()
       WHERE restaurante_id = $1
         AND woo_product_id = $2
         AND deleted = false
       RETURNING ${PRODUCT_COLUMNS}`,
      [restauranteId, wooProductId]
    );

    return result.rows[0];
  }

  async function mutateProduct({ restauranteId, tipo, wooProductId, payload = {} }) {
    if (!CLIENT_MESSAGES[tipo]) {
      throw new ProductMutationError('Tipo de acción de producto inválido');
    }
    if (tipo !== 'create_product' && !wooProductId) {
      throw new ProductMutationError('Falta woo_product_id');
    }

    const normalizedWooProductId = wooProductId ? String(wooProductId) : null;
    const client = await pool.connect();
    let product = null;

    try {
      await client.query('BEGIN');

      if (tipo === 'update_product') {
        product = await updateLocalProduct(
          client,
          restauranteId,
          normalizedWooProductId,
          payload
        );
      } else if (tipo === 'delete_product') {
        product = await deleteLocalProduct(
          client,
          restauranteId,
          normalizedWooProductId
        );
      }

      const action = await insertAction(
        client,
        restauranteId,
        tipo,
        normalizedWooProductId,
        payload
      );

      await client.query('COMMIT');
      cache.invalidate(restauranteId);

      return {
        success: true,
        message: CLIENT_MESSAGES[tipo],
        producto: normalizeProductRow(product),
        accion: action
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function reconcileWooProduct({ restauranteId, product, topic = '' }) {
    const wooProductId = String(product.id);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const actionResult = await client.query(
        `SELECT payload, estado, completed_at
         FROM acciones_woo
         WHERE restaurante_id = $1
           AND woo_product_id = $2
           AND tipo = 'update_product'
           AND (
             estado = 'pending'
             OR (estado = 'completed' AND completed_at >= NOW() - INTERVAL '5 minutes')
           )
         ORDER BY created_at DESC
         LIMIT 1`,
        [restauranteId, wooProductId]
      );

      const isDeleted = topic.includes('deleted') || product.status === 'trash';
      const reconciled = isDeleted
        ? product
        : protectWebhookProduct(product, actionResult.rows[0], now());
      const image = reconciled.images?.[0]?.src || null;
      const categories = asArray(reconciled.categories);

      const result = await client.query(
        `INSERT INTO productos
          (
            restaurante_id,
            woo_product_id,
            nombre,
            precio,
            regular_price,
            sale_price,
            estado,
            stock_status,
            imagen,
            categorias,
            raw,
            deleted,
            updated_at
          )
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
         ON CONFLICT (restaurante_id, woo_product_id)
         DO UPDATE SET
            nombre = EXCLUDED.nombre,
            precio = EXCLUDED.precio,
            regular_price = EXCLUDED.regular_price,
            sale_price = EXCLUDED.sale_price,
            estado = EXCLUDED.estado,
            stock_status = EXCLUDED.stock_status,
            imagen = EXCLUDED.imagen,
            categorias = EXCLUDED.categorias,
            raw = EXCLUDED.raw,
            deleted = EXCLUDED.deleted,
            updated_at = NOW()
         RETURNING ${PRODUCT_COLUMNS}`,
        [
          restauranteId,
          wooProductId,
          reconciled.name || '',
          toDatabaseNumber(reconciled.price),
          toDatabaseNumber(reconciled.regular_price),
          toDatabaseNumber(reconciled.sale_price),
          reconciled.status || '',
          reconciled.stock_status || '',
          image,
          JSON.stringify(categories),
          JSON.stringify(reconciled),
          isDeleted
        ]
      );

      await client.query('COMMIT');
      cache.invalidate(restauranteId);
      return normalizeProductRow(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    listProducts,
    mutateProduct,
    reconcileWooProduct
  };
}

module.exports = {
  CLIENT_MESSAGES,
  ProductMutationError,
  createProductCrudService,
  normalizeProductRow,
  protectWebhookProduct,
  shouldProtectOptimisticFields
};
