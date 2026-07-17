const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  isWooWebhookPing,
  sendWooWebhookPingAccepted,
  verifyWooWebhookSignature
} = require('../lib/webhook-security');
const { createOperationalConfig } = require('../lib/operational-config');

const indexSource = fs.readFileSync(
  path.resolve(__dirname, '..', 'index.js'),
  'utf8'
);

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);

  assert.notEqual(startIndex, -1, `No se encontró: ${start}`);
  assert.notEqual(endIndex, -1, `No se encontró: ${end}`);

  return source.slice(startIndex, endIndex);
}

const tokenProductRoute = between(
  indexSource,
  "app.post('/webhooks/woo/:webhookToken/product'",
  "app.post('/webhook-product'"
);
const legacyProductRoute = between(
  indexSource,
  "app.post('/webhook-product'",
  "app.get('/productos-db'"
);
const tokenOrderRoute = between(
  indexSource,
  "app.post('/webhooks/woo/:webhookToken/order'",
  "app.post('/webhook-order'"
);
const legacyOrderRoute = between(
  indexSource,
  "app.post('/webhook-order'",
  'async function processShipdayWebhook'
);

function validPing(overrides = {}) {
  return {
    method: 'POST',
    headers: {
      'user-agent': 'WooCommerce/9.9 Hookshot (WordPress/6.8)',
      ...(overrides.headers || {})
    },
    body: overrides.body || { webhook_id: '123' },
    ...overrides,
    headers: {
      'user-agent': 'WooCommerce/9.9 Hookshot (WordPress/6.8)',
      ...(overrides.headers || {})
    }
  };
}

function createResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function assertPingWiredBeforeProcessing(routeSource, processorName) {
  const resolveIndex = Math.max(
    routeSource.indexOf('resolveOperationalRestaurantByToken'),
    routeSource.indexOf('getLegacyRestaurantOneOperationalConfig')
  );
  const pingIndex = routeSource.indexOf('isWooWebhookPing(req)');
  const acceptedIndex = routeSource.indexOf('sendWooWebhookPingAccepted(res)');
  const signatureIndex = routeSource.indexOf('verifyWooWebhookSignature');
  const processIndex = routeSource.indexOf(processorName);

  assert.ok(resolveIndex >= 0);
  assert.ok(pingIndex > resolveIndex);
  assert.ok(acceptedIndex > pingIndex);
  assert.ok(signatureIndex > acceptedIndex);
  assert.ok(processIndex > signatureIndex);
}

test('ping Woo válido en ruta order devuelve 200', () => {
  assertPingWiredBeforeProcessing(tokenOrderRoute, 'processWooOrderWebhook');
  const req = validPing();
  const res = createResponse();
  const messages = [];

  assert.equal(isWooWebhookPing(req), true);
  sendWooWebhookPingAccepted(res, { log: message => messages.push(message) });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, ping: true });
  assert.deepEqual(messages, ['Woo webhook ping accepted']);
});

test('ping Woo válido en ruta product devuelve 200', () => {
  assertPingWiredBeforeProcessing(tokenProductRoute, 'processWooProductWebhook');
  const res = createResponse();

  assert.equal(isWooWebhookPing(validPing()), true);
  sendWooWebhookPingAccepted(res, { log() {} });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, ping: true });
});

test('ping no crea pedidos', () => {
  assert.ok(
    tokenOrderRoute.indexOf('sendWooWebhookPingAccepted(res)') <
      tokenOrderRoute.indexOf('processWooOrderWebhook')
  );
  assert.doesNotMatch(tokenOrderRoute, /INSERT INTO pedidos|UPDATE pedidos/);
});

test('ping no crea productos', () => {
  assert.ok(
    tokenProductRoute.indexOf('sendWooWebhookPingAccepted(res)') <
      tokenProductRoute.indexOf('processWooProductWebhook')
  );
  assert.doesNotMatch(tokenProductRoute, /INSERT INTO productos|UPDATE productos/);
});

test('ping no envía push', () => {
  assert.doesNotMatch(tokenOrderRoute, /enviarPushNuevoPedido|webpush/);
  assert.doesNotMatch(tokenProductRoute, /enviarPushNuevoPedido|webpush/);
});

test('evento order real con firma válida continúa funcionando', () => {
  const rawBody = Buffer.from(JSON.stringify({ id: 100, status: 'processing' }));
  const signature = crypto
    .createHmac('sha256', 'woo-secret')
    .update(rawBody)
    .digest('base64');
  const req = validPing({
    headers: {
      'x-wc-webhook-signature': signature,
      'x-wc-webhook-topic': 'order.updated'
    },
    body: { id: 100, status: 'processing' }
  });

  assert.equal(isWooWebhookPing(req), false);
  assert.equal(verifyWooWebhookSignature(rawBody, 'woo-secret', signature), true);
  assert.match(tokenOrderRoute, /return processWooOrderWebhook\(req, res, config\.id\)/);
});

test('evento product real con firma válida continúa funcionando', () => {
  const rawBody = Buffer.from(JSON.stringify({ id: 50, name: 'Taco' }));
  const signature = crypto
    .createHmac('sha256', 'woo-secret')
    .update(rawBody)
    .digest('base64');
  const req = validPing({
    headers: {
      'x-wc-webhook-signature': signature,
      'x-wc-webhook-topic': 'product.updated'
    },
    body: { id: 50, name: 'Taco' }
  });

  assert.equal(isWooWebhookPing(req), false);
  assert.equal(verifyWooWebhookSignature(rawBody, 'woo-secret', signature), true);
  assert.match(tokenProductRoute, /return processWooProductWebhook\(req, res, config\.id\)/);
});

test('evento real sin firma devuelve 401', () => {
  const req = validPing({
    headers: { 'x-wc-webhook-topic': 'order.created' },
    body: { id: 100, status: 'processing' }
  });

  assert.equal(isWooWebhookPing(req), false);
  assert.equal(verifyWooWebhookSignature(Buffer.from('{}'), 'woo-secret', undefined), false);
  assert.match(tokenOrderRoute, /res\.status\(401\)/);
  assert.match(tokenProductRoute, /res\.status\(401\)/);
});

test('firma incorrecta devuelve 401', () => {
  const rawBody = Buffer.from(JSON.stringify({ id: 100 }));

  assert.equal(
    verifyWooWebhookSignature(rawBody, 'woo-secret', 'incorrect-signature'),
    false
  );
  assert.match(tokenOrderRoute, /res\.status\(401\)/);
});

test('User-Agent falso con webhook_id no se acepta como ping', () => {
  assert.equal(isWooWebhookPing(validPing({
    headers: { 'user-agent': 'curl/8.0' }
  })), false);
  assert.equal(isWooWebhookPing(validPing({
    headers: { 'user-agent': 'WooCommerce/9.9' }
  })), false);
});

test('body con webhook_id y campos adicionales no se acepta como ping', () => {
  assert.equal(isWooWebhookPing(validPing({
    body: { webhook_id: '123', id: 100 }
  })), false);
});

test('webhook_id inválido o headers de evento no se aceptan como ping', () => {
  for (const webhookId of ['', '0', '-1', 'abc', '1.5', null, {}, []]) {
    assert.equal(isWooWebhookPing(validPing({
      body: { webhook_id: webhookId }
    })), false);
  }

  for (const headerName of [
    'x-wc-webhook-topic',
    'x-wc-webhook-resource',
    'x-wc-webhook-event'
  ]) {
    assert.equal(isWooWebhookPing(validPing({
      headers: { [headerName]: '' }
    })), false);
  }
});

test('token inexistente no acepta el ping', async () => {
  const operational = createOperationalConfig({
    pool: { async query() { return { rows: [] }; } },
    getRestaurantIntegrationConfig: async () => null,
    env: {}
  });

  await assert.rejects(
    operational.resolveOperationalRestaurantByToken('missing-token'),
    error => error.statusCode === 404 && error.code === 'WEBHOOK_TOKEN_NOT_FOUND'
  );
  assert.ok(
    tokenOrderRoute.indexOf('resolveOperationalRestaurantByToken') <
      tokenOrderRoute.indexOf('isWooWebhookPing(req)')
  );
});

test('restaurante inactivo no acepta el ping', async () => {
  const operational = createOperationalConfig({
    pool: { async query() { return { rows: [{ id: 2 }] }; } },
    getRestaurantIntegrationConfig: async () => ({
      id: 2,
      activo: false,
      legacy: false,
      woo_webhook_secret: 'woo-secret'
    }),
    env: {}
  });

  await assert.rejects(
    operational.resolveOperationalRestaurantByToken('inactive-token'),
    error => error.statusCode === 403 && error.code === 'OPERATIONAL_RESTAURANT_INACTIVE'
  );
});

test('restaurante 1 legacy conserva compatibilidad y valida antes del ping', () => {
  assertPingWiredBeforeProcessing(legacyOrderRoute, 'processWooOrderWebhook');
  assertPingWiredBeforeProcessing(legacyProductRoute, 'processWooProductWebhook');
  assert.match(legacyOrderRoute, /getLegacyRestaurantOneOperationalConfig/);
  assert.match(legacyProductRoute, /validLegacyQuerySecret/);
});
