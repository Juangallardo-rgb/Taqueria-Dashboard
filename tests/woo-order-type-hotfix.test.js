const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  detectarTipoPedidoWoo,
  resolverTipoPedidoWoo
} = require('../lib/order-utils');

const root = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8');

function explicitOrderType(value, overrides = {}) {
  return {
    id: 100,
    meta_data: [{
      id: 123,
      key: '_denix_order_type',
      value
    }],
    shipping_lines: [],
    ...overrides
  };
}

function sourceBetween(start, end) {
  const startIndex = indexSource.indexOf(start);
  const endIndex = indexSource.indexOf(end, startIndex);

  assert.ok(startIndex >= 0, `No se encontró el inicio: ${start}`);
  assert.ok(endIndex > startIndex, `No se encontró el final: ${end}`);
  return indexSource.slice(startIndex, endIndex);
}

class PedidoStore {
  constructor() {
    this.rows = new Map();
  }

  upsert(restauranteId, order) {
    const key = `${Number(restauranteId)}:${String(order.id)}`;
    this.rows.set(key, {
      restaurante_id: Number(restauranteId),
      woo_order_id: String(order.id),
      tipo_pedido: detectarTipoPedidoWoo(order)
    });
  }

  get(restauranteId, wooOrderId) {
    return this.rows.get(`${Number(restauranteId)}:${String(wooOrderId)}`);
  }
}

test('_denix_order_type=pickup se resuelve para guardar pickup', () => {
  const resolved = resolverTipoPedidoWoo(explicitOrderType('pickup'));

  assert.deepEqual(resolved, {
    tipoPedido: 'pickup',
    tipoPedidoExplicito: true
  });
  assert.match(
    sourceBetween(
      'async function processWooOrderWebhook',
      "app.post('/webhooks/woo/:webhookToken/order'"
    ),
    /const \{ tipoPedido \} = resolverTipoPedidoWoo\(order\)/
  );
});

test('_denix_order_type=delivery se resuelve para guardar delivery', () => {
  assert.deepEqual(
    resolverTipoPedidoWoo(explicitOrderType('delivery')),
    {
      tipoPedido: 'delivery',
      tipoPedidoExplicito: true
    }
  );
});

test('Pickup con mayúscula se normaliza a pickup', () => {
  assert.equal(detectarTipoPedidoWoo(explicitOrderType('Pickup')), 'pickup');
});

test('Delivery con espacios se normaliza a delivery', () => {
  assert.equal(
    detectarTipoPedidoWoo(explicitOrderType('  Delivery  ')),
    'delivery'
  );
});

test('pickup explícito sin shipping address sigue siendo pickup', () => {
  assert.equal(detectarTipoPedidoWoo(explicitOrderType('pickup', {
    shipping: {}
  })), 'pickup');
});

test('pickup explícito gana ante una dirección antigua guardada', () => {
  assert.equal(detectarTipoPedidoWoo(explicitOrderType('pickup', {
    shipping: {
      address_1: 'Dirección anterior',
      city: 'Quito',
      postcode: '170101'
    },
    billing: {
      address_1: 'Dirección de facturación'
    }
  })), 'pickup');
});

test('delivery explícito con billing address se mantiene delivery', () => {
  assert.equal(detectarTipoPedidoWoo(explicitOrderType('delivery', {
    billing: {
      address_1: '100 Main St',
      city: 'Quito'
    }
  })), 'delivery');
});

test('sin metadato conserva la lógica heredada actual', () => {
  assert.equal(detectarTipoPedidoWoo({
    shipping_lines: [{
      method_id: 'local_pickup',
      method_title: 'Pickup'
    }]
  }), 'pickup');

  assert.equal(detectarTipoPedidoWoo({
    shipping: { address_1: '100 Main St' },
    shipping_lines: []
  }), 'delivery');

  assert.equal(detectarTipoPedidoWoo({ shipping_lines: [] }), 'delivery');
});

test('meta_data inválido no rompe el resolver ni el webhook', () => {
  for (const metaData of [
    undefined,
    null,
    {},
    'pickup',
    [null, 7, {}, { key: '_denix_order_type', value: 42 }],
    [{ key: '_denix_order_type', value: 'curbside' }]
  ]) {
    assert.doesNotThrow(() => detectarTipoPedidoWoo({
      meta_data: metaData,
      shipping_lines: []
    }));
    assert.equal(detectarTipoPedidoWoo({
      meta_data: metaData,
      shipping_lines: []
    }), 'delivery');
  }

  assert.equal(detectarTipoPedidoWoo({
    meta_data: [
      { key: '_denix_order_type', value: 42 },
      { key: '_denix_order_type', value: ' Pickup ' }
    ]
  }), 'pickup');
});

test('restaurante 4 no modifica pedidos del restaurante 1', () => {
  const store = new PedidoStore();
  store.upsert(1, explicitOrderType('delivery'));
  store.upsert(4, explicitOrderType('pickup'));

  assert.equal(store.rows.size, 2);
  assert.equal(store.get(1, 100).tipo_pedido, 'delivery');
  assert.equal(store.get(4, 100).tipo_pedido, 'pickup');

  const wooWebhookSource = sourceBetween(
    'async function processWooOrderWebhook',
    "app.post('/webhooks/woo/:webhookToken/order'"
  );
  assert.match(
    wooWebhookSource,
    /ON CONFLICT \(restaurante_id, woo_order_id\)/
  );
});

test('callback posterior de Shipday no convierte pickup guardado a delivery', () => {
  const shipdaySource = sourceBetween(
    'async function processShipdayWebhook',
    "app.post('/webhooks/shipday/:webhookToken'"
  );

  assert.match(shipdaySource, /resolverTipoPedidoWoo\(order\)/);
  assert.match(
    shipdaySource,
    /WHEN \$13::boolean THEN EXCLUDED\.tipo_pedido[\s\S]*?WHEN pedidos\.tipo_pedido = 'pickup' THEN pedidos\.tipo_pedido/
  );
  assert.doesNotMatch(
    shipdaySource,
    /const tipoPedido = tipoPedidoWoo === 'delivery'[\s\S]*?: 'delivery'/
  );
});

test('webhook legacy del restaurante 1 conserva su comportamiento', () => {
  const legacySource = sourceBetween(
    "app.post('/webhook-order'",
    'async function processShipdayWebhook'
  );

  assert.match(legacySource, /getLegacyRestaurantOneOperationalConfig/);
  assert.match(legacySource, /verifyWooWebhookSignature/);
  assert.match(
    legacySource,
    /return processWooOrderWebhook\(req, res, 1\)/
  );
});

test('el upsert no crea duplicados por restaurante_id + woo_order_id', () => {
  const store = new PedidoStore();
  store.upsert(4, explicitOrderType('pickup'));
  store.upsert(4, explicitOrderType('pickup', { status: 'processing' }));

  assert.equal(store.rows.size, 1);
  assert.equal(store.get(4, 100).tipo_pedido, 'pickup');
  assert.ok(
    (indexSource.match(
      /ON CONFLICT \(restaurante_id, woo_order_id\)/g
    ) || []).length >= 2
  );
  assert.doesNotMatch(indexSource, /ON CONFLICT \(woo_order_id\)/);
});
