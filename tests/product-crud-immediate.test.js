'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createRestaurantProductCache } = require('../lib/product-cache');
const {
  ProductMutationError,
  createProductCrudService,
  protectWebhookProduct
} = require('../lib/product-crud');

const root = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

function productKey(restauranteId, wooProductId) {
  return `${restauranteId}:${wooProductId}`;
}

function productRow(restauranteId, wooProductId, overrides = {}) {
  return {
    id: `${restauranteId}-${wooProductId}`,
    restaurante_id: restauranteId,
    woo_product_id: String(wooProductId),
    nombre: 'Taco',
    precio: 10,
    regular_price: 10,
    sale_price: 0,
    estado: 'publish',
    stock_status: 'instock',
    imagen: null,
    categorias: [],
    raw: { id: Number(wooProductId), name: 'Taco', price: '10' },
    deleted: false,
    updated_at: new Date('2026-07-22T12:00:00Z'),
    ...overrides
  };
}

class MemoryProductPool {
  constructor(rows = []) {
    this.products = new Map(rows.map(row => [
      productKey(row.restaurante_id, row.woo_product_id),
      { ...row }
    ]));
    this.actions = [];
    this.statements = [];
  }

  async query(sql, params) {
    this.statements.push(sql);
    if (sql.includes('FROM productos') && sql.includes('ORDER BY nombre ASC')) {
      return {
        rows: [...this.products.values()]
          .filter(row => row.restaurante_id === params[0] && !row.deleted)
          .sort((left, right) => left.nombre.localeCompare(right.nombre))
      };
    }
    throw new Error(`Pool query no implementada: ${sql}`);
  }

  async connect() {
    const pool = this;
    return {
      async query(sql, params = []) {
        pool.statements.push(sql);
        const compact = sql.replace(/\s+/g, ' ').trim();

        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(compact)) return { rows: [] };
        if (compact.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}] };

        if (compact.includes('FROM productos') && compact.includes('FOR UPDATE')) {
          const row = pool.products.get(productKey(params[0], params[1]));
          return { rows: row && !row.deleted ? [{ ...row }] : [] };
        }

        if (compact.startsWith('UPDATE productos SET nombre')) {
          const key = productKey(params[0], params[1]);
          const row = pool.products.get(key);
          if (!row || row.deleted) return { rows: [] };
          Object.assign(row, {
            nombre: params[2],
            precio: params[3],
            regular_price: params[4],
            sale_price: params[5],
            estado: params[6],
            stock_status: params[7],
            imagen: params[8],
            categorias: JSON.parse(params[9]),
            raw: JSON.parse(params[10]),
            updated_at: new Date('2026-07-22T12:01:00Z')
          });
          return { rows: [{ ...row }] };
        }

        if (compact.startsWith('UPDATE productos SET deleted = true')) {
          const row = pool.products.get(productKey(params[0], params[1]));
          if (!row || row.deleted) return { rows: [] };
          row.deleted = true;
          return { rows: [{ ...row }] };
        }

        if (compact.startsWith('SELECT * FROM acciones_woo')) {
          const payload = JSON.stringify(JSON.parse(params[3]));
          const action = [...pool.actions].reverse().find(row => (
            row.restaurante_id === params[0] &&
            row.tipo === params[1] &&
            row.woo_product_id === params[2] &&
            row.estado === 'pending' &&
            JSON.stringify(row.payload) === payload
          ));
          return { rows: action ? [{ ...action }] : [] };
        }

        if (compact.startsWith('INSERT INTO acciones_woo')) {
          const action = {
            id: pool.actions.length + 1,
            restaurante_id: params[0],
            tipo: params[1],
            woo_product_id: params[2],
            payload: JSON.parse(params[3]),
            estado: 'pending',
            created_at: new Date('2026-07-22T12:01:00Z')
          };
          pool.actions.push(action);
          return { rows: [{ ...action }] };
        }

        if (compact.startsWith('SELECT payload, estado, completed_at FROM acciones_woo')) {
          const action = [...pool.actions].reverse().find(row => (
            row.restaurante_id === params[0] &&
            row.woo_product_id === params[1] &&
            row.tipo === 'update_product' &&
            ['pending', 'completed'].includes(row.estado)
          ));
          return { rows: action ? [{ ...action }] : [] };
        }

        if (compact.startsWith('INSERT INTO productos')) {
          const key = productKey(params[0], params[1]);
          const previous = pool.products.get(key);
          const row = {
            id: previous?.id || `${params[0]}-${params[1]}`,
            restaurante_id: params[0],
            woo_product_id: params[1],
            nombre: params[2],
            precio: params[3],
            regular_price: params[4],
            sale_price: params[5],
            estado: params[6],
            stock_status: params[7],
            imagen: params[8],
            categorias: JSON.parse(params[9]),
            raw: JSON.parse(params[10]),
            deleted: params[11],
            updated_at: new Date('2026-07-22T12:02:00Z')
          };
          pool.products.set(key, row);
          return { rows: [{ ...row }] };
        }

        throw new Error(`Client query no implementada: ${compact}`);
      },
      release() {}
    };
  }
}

function createHarness(rows) {
  const pool = new MemoryProductPool(rows);
  const cache = createRestaurantProductCache();
  const service = createProductCrudService({ pool, cache });
  return { pool, cache, service };
}

test('actualizar producto persiste el precio, crea una sola acción y responde sin detalles internos', async () => {
  const { pool, cache, service } = createHarness([
    productRow(1, 50),
    productRow(4, 50, { nombre: 'Taco R4', precio: 12 })
  ]);
  cache.set(1, ['cache-r1']);
  cache.set(4, ['cache-r4']);
  const mutation = {
    restauranteId: 4,
    tipo: 'update_product',
    wooProductId: 50,
    payload: { name: 'Taco R4', price: '19.50', regular_price: '19.50' }
  };

  const first = await service.mutateProduct(mutation);
  const second = await service.mutateProduct(mutation);
  const cacheWasInvalidated = !cache.has(4);
  const reloaded = await service.listProducts(4);

  assert.equal(pool.products.get('4:50').precio, 19.5);
  assert.equal(pool.products.get('1:50').precio, 10);
  assert.equal(pool.actions.length, 1);
  assert.equal(pool.actions[0].restaurante_id, 4);
  assert.equal(pool.actions[0].tipo, 'update_product');
  assert.equal(first.message, 'Producto actualizado');
  assert.equal(first.producto.price, '19.5');
  assert.doesNotMatch(JSON.stringify(first), /bridge/i);
  assert.equal(second.accion.id, first.accion.id);
  assert.equal(cacheWasInvalidated, true);
  assert.equal(cache.has(1), true);
  assert.equal(reloaded[0].precio, 19.5);
  assert.ok(pool.statements.includes('BEGIN'));
  assert.ok(pool.statements.includes('COMMIT'));
});

test('restaurantes 1 y 4 no pueden modificar un producto que solo pertenece al otro', async () => {
  const { pool, service } = createHarness([
    productRow(1, 101),
    productRow(4, 404)
  ]);

  await assert.rejects(
    service.mutateProduct({
      restauranteId: 4,
      tipo: 'update_product',
      wooProductId: 101,
      payload: { price: '99' }
    }),
    error => error instanceof ProductMutationError && error.statusCode === 404
  );
  await assert.rejects(
    service.mutateProduct({
      restauranteId: 1,
      tipo: 'update_product',
      wooProductId: 404,
      payload: { price: '99' }
    }),
    error => error instanceof ProductMutationError && error.statusCode === 404
  );

  assert.equal(pool.products.get('1:101').precio, 10);
  assert.equal(pool.products.get('4:404').precio, 10);
  assert.equal(pool.actions.length, 0);
});

test('webhook posterior reconcilia la misma identidad y no revierte un precio optimista pendiente', async () => {
  const { pool, cache, service } = createHarness([
    productRow(1, 50),
    productRow(4, 50, { precio: 12 })
  ]);
  await service.mutateProduct({
    restauranteId: 4,
    tipo: 'update_product',
    wooProductId: 50,
    payload: { name: 'Taco R4', price: '21', regular_price: '21' }
  });
  cache.set(1, ['cache-r1']);
  cache.set(4, ['cache-r4']);

  const reconciled = await service.reconcileWooProduct({
    restauranteId: 4,
    topic: 'product.updated',
    product: {
      id: 50,
      name: 'Dato anterior',
      price: '12',
      regular_price: '12',
      sale_price: '',
      status: 'publish',
      stock_status: 'instock',
      categories: []
    }
  });

  assert.equal(pool.products.size, 2);
  assert.equal(pool.products.get('4:50').precio, 21);
  assert.equal(pool.products.get('1:50').precio, 10);
  assert.equal(reconciled.price, '21');
  assert.equal(cache.has(4), false);
  assert.equal(cache.has(1), true);
});

test('webhook completado solo protege eventos Woo anteriores al resultado', () => {
  const action = {
    estado: 'completed',
    completed_at: '2026-07-22T12:05:00Z',
    payload: { price: '20' }
  };

  assert.equal(protectWebhookProduct({
    price: '10',
    date_modified_gmt: '2026-07-22T12:04:59'
  }, action).price, '20');
  assert.equal(protectWebhookProduct({
    price: '22',
    date_modified_gmt: '2026-07-22T12:05:01'
  }, action).price, '22');
});

test('crear y eliminar usan los mensajes públicos exactos y actualizan el estado local seguro', async () => {
  const { pool, service } = createHarness([productRow(4, 50)]);

  const created = await service.mutateProduct({
    restauranteId: 4,
    tipo: 'create_product',
    payload: { name: 'Quesadilla', price: '8' }
  });
  const deleted = await service.mutateProduct({
    restauranteId: 4,
    tipo: 'delete_product',
    wooProductId: 50,
    payload: {}
  });

  assert.equal(created.message, 'Producto creado');
  assert.equal(created.producto, null);
  assert.equal(deleted.message, 'Producto eliminado');
  assert.equal(pool.products.get('4:50').deleted, true);
  assert.deepEqual(pool.actions.map(action => action.tipo), [
    'create_product',
    'delete_product'
  ]);
});

test('caché de productos usa claves por restaurante y expira sin afectar otras claves', () => {
  let timestamp = 1000;
  const cache = createRestaurantProductCache({ ttlMs: 100, now: () => timestamp });
  cache.set(1, ['r1']);
  cache.set(4, ['r4']);
  cache.invalidate(4);

  assert.deepEqual(cache.get(1), ['r1']);
  assert.equal(cache.get(4), undefined);
  timestamp = 1100;
  assert.equal(cache.get(1), undefined);
});

test('frontend actualiza DOM/estado y confirma con lectura fresca sin recargar la página', () => {
  const productSection = appSource.slice(
    appSource.indexOf('async function verProductos'),
    appSource.indexOf('async function cargarCategoriasPopup')
  );

  assert.match(appSource, /function actualizarProductoEnLista\(producto\)/);
  assert.match(appSource, /productosGlobal\[index\] = \{ \.\.\.productosGlobal\[index\], \.\.\.producto \}/);
  assert.match(appSource, /renderizarProductosActuales\(\)/);
  assert.match(appSource, /verProductos\(\{ background: true \}\)/);
  assert.match(appSource, /productos-db\?refresh=1&ts=/);
  assert.match(appSource, /cache: 'no-store'/);
  assert.doesNotMatch(productSection, /location\.reload\(/);
});

test('CRUD autenticado toma el restaurante de sesión y no expone mensajes sobre procesos internos', () => {
  assert.match(indexSource, /app\.post\('\/acciones-woo', requireSessionRestaurant/);
  assert.match(indexSource, /const restaurante_id = req\.restaurant\.id/);
  assert.doesNotMatch(indexSource, /req\.body\.restaurante_id/);
  assert.match(indexSource, /productCrud\.mutateProduct\(\{[\s\S]*?restauranteId: restaurante_id/);

  const visibleCrud = appSource.slice(
    appSource.indexOf('async function eliminarProducto'),
    appSource.indexOf('async function cargarCategoriasPopup')
  );
  assert.doesNotMatch(visibleCrud, /bridge|puente|cola|webhook|sincronizaci[oó]n interna/i);
  assert.match(visibleCrud, /Producto actualizado/);
  assert.match(visibleCrud, /Producto creado/);
  assert.match(visibleCrud, /Producto eliminado/);
});
