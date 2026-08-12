const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);

  assert.ok(startIndex >= 0, `No se encontró el inicio: ${start}`);
  assert.ok(endIndex > startIndex, `No se encontró el final: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('webhook Woo valida el estado antes de caché, persistencia y push', () => {
  const webhookSource = sourceBetween(
    indexSource,
    'async function processWooOrderWebhook',
    "app.post('/webhooks/woo/:webhookToken/order'"
  );

  const gateIndex = webhookSource.indexOf('if (!shouldAcceptWooOrder(order))');

  assert.ok(gateIndex >= 0);
  assert.ok(gateIndex < webhookSource.indexOf('invalidarCachePedidos(restauranteId)'));
  assert.ok(gateIndex < webhookSource.indexOf('orderIntegrity.upsertWooOrder'));
  assert.ok(gateIndex < webhookSource.indexOf('publishAndNotifyStoredOrder'));
  assert.match(webhookSource, /ignored:\s*true/);
});

test('endpoints de pedidos filtran processing y completed en SQL', () => {
  const completeSource = sourceBetween(
    indexSource,
    "app.get('/orders-complete'",
    "app.get('/orders-latest'"
  );
  const latestSource = sourceBetween(
    indexSource,
    "app.get('/orders-latest'",
    "app.get('/products'"
  );

  for (const routeSource of [completeSource, latestSource]) {
    assert.match(
      routeSource,
      /LOWER\(TRIM\(COALESCE\([^,]+, ''\)\)\) IN \('processing', 'completed'\)/
    );
  }
});

test('frontend no trata pending como pedido en proceso', () => {
  const recentFilterSource = sourceBetween(
    appSource,
    "if (tabActual === 'recientes')",
    "if (tabActual === 'hoy')"
  );

  assert.match(recentFilterSource, /=== 'processing'/);
  assert.doesNotMatch(recentFilterSource, /pending/);
});
