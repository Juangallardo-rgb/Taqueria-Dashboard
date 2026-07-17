const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createOperationalConfig } = require('../lib/operational-config');
const {
  verifyWooWebhookSignature,
  verifyShipdaySecret
} = require('../lib/webhook-security');
const {
  detectarTipoPedidoWoo,
  shouldIgnoreWooOrder,
  buildWooOrderItems
} = require('../lib/order-utils');

function createConfigHarness(configs, tokenMap, env = {}) {
  const pool = {
    async query(sql, params) {
      assert.match(sql, /WHERE webhook_token = \$1/);
      const id = tokenMap[params[0]];
      return { rows: id ? [{ id }] : [] };
    }
  };

  return createOperationalConfig({
    pool,
    env,
    getRestaurantIntegrationConfig: async id => configs[id] || null
  });
}

test('resuelve tokens de dos restaurantes sin compartir credenciales', async () => {
  const configs = {
    1: {
      id: 1,
      activo: true,
      woo_url: 'https://one.example',
      consumer_key: 'one-key',
      consumer_secret: 'one-secret',
      legacy: true
    },
    2: {
      id: 2,
      activo: true,
      woo_url: 'https://two.example',
      consumer_key: 'two-key',
      consumer_secret: 'two-secret',
      legacy: false
    }
  };
  const harness = createConfigHarness(
    configs,
    { 'token-one': 1, 'token-two': 2 },
    { ENABLE_LEGACY_RESTAURANT_1: 'true' }
  );

  const one = await harness.resolveOperationalRestaurantByToken('token-one');
  const two = await harness.resolveOperationalRestaurantByToken('token-two');

  assert.equal(one.consumer_secret, 'one-secret');
  assert.equal(two.consumer_secret, 'two-secret');
  assert.notEqual(one.consumer_secret, two.consumer_secret);
});

test('rechaza token incorrecto, restaurante inactivo y credenciales faltantes', async () => {
  const harness = createConfigHarness(
    {
      2: { id: 2, activo: true, legacy: false, woo_url: null },
      3: { id: 3, activo: false, legacy: false }
    },
    { 'token-two': 2, 'token-three': 3 }
  );

  await assert.rejects(
    harness.resolveOperationalRestaurantByToken('incorrecto'),
    error => error.statusCode === 404 && error.code === 'WEBHOOK_TOKEN_NOT_FOUND'
  );
  await assert.rejects(
    harness.resolveOperationalRestaurantByToken('token-three'),
    error => error.statusCode === 403 && error.code === 'OPERATIONAL_RESTAURANT_INACTIVE'
  );
  await assert.rejects(
    harness.getOperationalRestaurantConfig(2, { required: ['woo_url'] }),
    error => error.statusCode === 503 && error.code === 'OPERATIONAL_CONFIG_INCOMPLETE'
  );
});

test('compatibilidad legacy solo habilita restaurante 1 con flag explícita', async () => {
  const enabled = createConfigHarness(
    { 1: { id: 1, activo: true, legacy: true } },
    {},
    { ENABLE_LEGACY_RESTAURANT_1: 'true' }
  );
  assert.equal((await enabled.getLegacyRestaurantOneOperationalConfig()).id, 1);

  const disabled = createConfigHarness(
    { 1: { id: 1, activo: true, legacy: false } },
    {},
    { ENABLE_LEGACY_RESTAURANT_1: 'false' }
  );
  await assert.rejects(
    disabled.getLegacyRestaurantOneOperationalConfig(),
    error => error.statusCode === 404 && error.code === 'LEGACY_RESTAURANT_ONE_DISABLED'
  );
});

test('firma Woo valida exactamente el raw body y secreto del restaurante', () => {
  const body = Buffer.from(JSON.stringify({ id: 100, status: 'processing' }));
  const signature = crypto
    .createHmac('sha256', 'restaurant-two-secret')
    .update(body)
    .digest('base64');

  assert.equal(
    verifyWooWebhookSignature(body, 'restaurant-two-secret', signature),
    true
  );
  assert.equal(
    verifyWooWebhookSignature(body, 'restaurant-one-secret', signature),
    false
  );
  assert.equal(
    verifyWooWebhookSignature(Buffer.from('{}'), 'restaurant-two-secret', signature),
    false
  );
});

test('secreto Shipday acepta header o query y rechaza valores incorrectos', () => {
  assert.equal(verifyShipdaySecret({ headers: { 'x-shipday-secret': 's2' } }, 's2'), true);
  assert.equal(verifyShipdaySecret({ headers: {}, query: { secret: 's2' } }, 's2'), true);
  assert.equal(verifyShipdaySecret({ headers: {}, query: { secret: 's1' } }, 's2'), false);
});

test('detección central conserva pickup, delivery y pending', () => {
  assert.equal(detectarTipoPedidoWoo({
    shipping_lines: [{ method_id: 'local_pickup', method_title: 'Pickup' }]
  }), 'pickup');

  assert.equal(detectarTipoPedidoWoo({
    shipping: { address_1: '100 Main St' },
    shipping_lines: []
  }), 'delivery');

  assert.equal(detectarTipoPedidoWoo({ shipping_lines: [] }), 'delivery');
  assert.equal(shouldIgnoreWooOrder({ status: 'cancelled' }), true);
  assert.equal(shouldIgnoreWooOrder({ status: 'pending' }), false);

  assert.deepEqual(buildWooOrderItems({
    line_items: [{
      name: 'Taco',
      quantity: 2,
      meta_data: [{ key: 'Salsa', value: 'Verde' }]
    }]
  }), [{ nombre: 'Taco (Salsa: Verde)', cantidad: 2 }]);
});
