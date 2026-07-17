const test = require('node:test');
const assert = require('node:assert/strict');

function tenantKey(restauranteId, externalId) {
  return `${Number(restauranteId)}:${String(externalId)}`;
}

class TenantCharacterizationStore {
  constructor() {
    this.orders = new Map();
    this.deliveries = new Map();
    this.products = new Map();
    this.pushSubscriptions = [];
    this.actions = [];
    this.cache = new Map();
  }

  upsert(collection, restauranteId, externalId, value) {
    collection.set(tenantKey(restauranteId, externalId), {
      restaurante_id: restauranteId,
      external_id: externalId,
      ...value
    });
  }

  read(collection, sessionRestaurantId, externalId) {
    return collection.get(tenantKey(sessionRestaurantId, externalId)) || null;
  }
}

test('IDs Woo, Shipday y productos iguales permanecen separados', () => {
  const store = new TenantCharacterizationStore();

  store.upsert(store.orders, 1, 100, { customer: 'R1' });
  store.upsert(store.orders, 2, 100, { customer: 'R2' });
  store.upsert(store.deliveries, 1, 100, { driver: 'Driver R1' });
  store.upsert(store.deliveries, 2, 100, { driver: 'Driver R2' });
  store.upsert(store.products, 1, 50, { name: 'Producto R1' });
  store.upsert(store.products, 2, 50, { name: 'Producto R2' });

  assert.equal(store.orders.size, 2);
  assert.equal(store.deliveries.size, 2);
  assert.equal(store.products.size, 2);
  assert.equal(store.read(store.orders, 1, 100).customer, 'R1');
  assert.equal(store.read(store.orders, 2, 100).customer, 'R2');
  assert.equal(store.read(store.deliveries, 1, 100).driver, 'Driver R1');
  assert.equal(store.read(store.products, 2, 50).name, 'Producto R2');
});

test('la sesión domina query/body y no puede leer otro restaurante', () => {
  const store = new TenantCharacterizationStore();
  store.upsert(store.orders, 1, 100, { customer: 'R1' });
  store.upsert(store.orders, 2, 100, { customer: 'R2' });

  const request = {
    session: { restaurante_id: 1 },
    query: { restaurante_id: 2 },
    body: { restaurante_id: 2 }
  };

  const visible = store.read(store.orders, request.session.restaurante_id, 100);
  assert.equal(visible.customer, 'R1');
  assert.notEqual(visible.customer, 'R2');
});

test('push y Bridge solo seleccionan filas del tenant actual', () => {
  const store = new TenantCharacterizationStore();
  store.pushSubscriptions.push(
    { restaurante_id: 1, endpoint: 'push-r1', activo: true },
    { restaurante_id: 2, endpoint: 'push-r2', activo: true }
  );
  store.actions.push(
    { id: 7, restaurante_id: 1, estado: 'pending' },
    { id: 8, restaurante_id: 2, estado: 'pending' }
  );

  const pushR2 = store.pushSubscriptions.filter(row => (
    row.restaurante_id === 2 && row.activo
  ));
  const bridgeR1 = store.actions.filter(row => (
    row.restaurante_id === 1 && row.estado === 'pending'
  ));

  assert.deepEqual(pushR2.map(row => row.endpoint), ['push-r2']);
  assert.deepEqual(bridgeR1.map(row => row.id), [7]);
});

test('refund y caché usan restaurante más ID externo como identidad', () => {
  const store = new TenantCharacterizationStore();
  store.upsert(store.orders, 1, 100, { total: 20, refunded: false });
  store.upsert(store.orders, 2, 100, { total: 30, refunded: false });

  const refundTarget = store.read(store.orders, 1, 100);
  refundTarget.refunded = true;

  store.cache.set('1', [store.read(store.orders, 1, 100)]);
  store.cache.set('2', [store.read(store.orders, 2, 100)]);

  assert.equal(store.read(store.orders, 1, 100).refunded, true);
  assert.equal(store.read(store.orders, 2, 100).refunded, false);
  assert.equal(store.cache.get('1')[0].restaurante_id, 1);
  assert.equal(store.cache.get('2')[0].restaurante_id, 2);
});
