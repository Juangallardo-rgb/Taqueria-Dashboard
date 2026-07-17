const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const stripeSource = fs.readFileSync(path.join(root, 'routes', 'stripeConnect.js'), 'utf8');
const adminSource = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const preflight = fs.readFileSync(
  path.join(root, 'migrations', '002_multitenant_operations_preflight.sql'),
  'utf8'
);
const additive = fs.readFileSync(
  path.join(root, 'migrations', '003_multitenant_operations_additive.sql'),
  'utf8'
);
const cutover = fs.readFileSync(
  path.join(root, 'migrations', '004_multitenant_operations_cutover.sql'),
  'utf8'
);

function count(source, pattern) {
  return (source.match(pattern) || []).length;
}

test('webhooks nuevos resuelven token, validan raw body y conservan legacy', () => {
  assert.match(indexSource, /express\.json\(\{[\s\S]*?req\.rawBody = Buffer\.from\(buffer\)/);
  assert.match(indexSource, /app\.post\('\/webhooks\/woo\/:webhookToken\/order'/);
  assert.match(indexSource, /app\.post\('\/webhooks\/woo\/:webhookToken\/product'/);
  assert.match(indexSource, /app\.post\('\/webhooks\/shipday\/:webhookToken'/);
  assert.match(indexSource, /verifyWooWebhookSignature\([\s\S]*?req\.rawBody/);
  assert.match(indexSource, /verifyShipdaySecret\(req, config\.shipday_webhook_secret\)/);
  assert.match(indexSource, /getLegacyRestaurantOneOperationalConfig/);
  assert.match(indexSource, /app\.post\('\/webhook-order'/);
  assert.match(indexSource, /app\.post\('\/webhook-product'/);
  assert.match(indexSource, /app\.post\('\/webhook-shipday'/);
});

test('órdenes, deliveries y productos usan claves compuestas', () => {
  assert.ok(count(indexSource, /ON CONFLICT \(restaurante_id, woo_order_id\)/g) >= 2);
  assert.match(indexSource, /ON CONFLICT \(restaurante_id, order_number\)/);
  assert.match(indexSource, /ON CONFLICT \(restaurante_id, woo_product_id\)/);
  assert.doesNotMatch(indexSource, /ON CONFLICT \(woo_order_id\)/);
  assert.doesNotMatch(indexSource, /ON CONFLICT \(order_number\)/);
});

test('joins, caché y lectura de pedidos están aislados por sesión', () => {
  assert.ok(count(indexSource, /d\.restaurante_id = p\.restaurante_id/g) >= 2);
  assert.doesNotMatch(
    indexSource,
    /LEFT JOIN deliveries d\s+ON d\.order_number::text = p\.woo_order_id::text/
  );
  assert.match(indexSource, /app\.get\('\/orders-complete', requireSessionRestaurant/);
  assert.match(indexSource, /app\.get\('\/orders-latest', requireSessionRestaurant/);
  assert.match(indexSource, /const cacheKey = String\(restaurante_id\)/);
  assert.match(indexSource, /invalidarCachePedidos\(restauranteId\)/);
  assert.doesNotMatch(indexSource, /req\.session\?\.restaurante_id \|\| 1/);
});

test('rutas operativas autenticadas no aceptan tenant del navegador', () => {
  for (const pattern of [
    /app\.get\('\/productos-db', requireSessionRestaurant/,
    /app\.get\('\/products', requireSessionRestaurant, requireWooOperationalConfig/,
    /app\.get\('\/pedidos-db', requireSessionRestaurant/,
    /app\.post\('\/acciones-woo', requireSessionRestaurant/,
    /app\.post\('\/refund', requireSessionRestaurant, requireWooOperationalConfig/,
    /app\.get\('\/refund-data\/:woo_order_id', requireSessionRestaurant/,
    /app\.get\('\/estado-restaurante', requireSessionRestaurant/,
    /app\.post\('\/toggle-restaurante', requireSessionRestaurant/,
    /app\.post\('\/push-subscribe', requireSessionRestaurant/,
    /app\.post\('\/push-unsubscribe', requireSessionRestaurant/,
    /app\.post\('\/push-test', requireSessionRestaurant/
  ]) {
    assert.match(indexSource, pattern);
  }

  assert.doesNotMatch(indexSource, /req\.query\.restaurante_id/);
  assert.doesNotMatch(indexSource, /restaurante_id \|\| 1/);
});

test('push, Bridge y refund filtran por restaurante', () => {
  assert.match(indexSource, /tag: `pedido-\$\{restauranteId\}-\$\{order\.id\}`/);
  assert.match(indexSource, /FROM push_subscriptions[\s\S]*?WHERE restaurante_id = \$1/);
  assert.match(indexSource, /WHERE endpoint = \$1[\s\S]*?AND restaurante_id = \$2/);
  assert.match(indexSource, /app\.get\('\/bridge\/:webhookToken\/actions'/);
  assert.match(indexSource, /app\.post\('\/bridge\/:webhookToken\/actions\/:actionId\/result'/);
  assert.match(indexSource, /WHERE id = \$4[\s\S]*?AND restaurante_id = \$5/);
  assert.equal(count(indexSource, /app\.post\('\/refund'/g), 1);
  assert.match(indexSource, /WHERE woo_order_id = \$1[\s\S]*?AND restaurante_id = \$2/);
});

test('credenciales globales no se usan directamente en rutas operativas', () => {
  assert.doesNotMatch(indexSource, /`\$\{WOO_URL\}\/wp-json/);
  assert.doesNotMatch(indexSource, /username: CONSUMER_KEY/);
  assert.doesNotMatch(indexSource, /password: CONSUMER_SECRET/);
  assert.doesNotMatch(indexSource, /secret !== WEBHOOK_SECRET/);
  assert.match(indexSource, /getOperationalRestaurantConfig/);
});

test('admin edita configuración, genera secretos y nunca devuelve secretos completos', () => {
  assert.match(indexSource, /app\.put\('\/admin\/restaurantes\/:id'/);
  assert.match(indexSource, /app\.post\('\/admin\/restaurantes\/:id\/generar-secretos'/);
  assert.match(indexSource, /secret\.includes\('\*'\)/);
  assert.match(indexSource, /webhook_token: maskSecret\(restaurant\.webhook_token\)/);
  assert.match(indexSource, /woo_webhook_secret: maskSecret\(restaurant\.woo_webhook_secret\)/);
  assert.match(indexSource, /shipday_webhook_secret: maskSecret\(restaurant\.shipday_webhook_secret\)/);
  assert.match(adminSource, /editarRestaurante/);
  assert.match(adminSource, /generarSecretos/);
});

test('Stripe protege administración por sesión y conserva rutas financieras', () => {
  assert.match(stripeSource, /function requireAdminRestaurantAccess/);
  assert.match(stripeSource, /req\.session\?\.rol !== "admin"/);
  assert.match(stripeSource, /sessionRestaurantId !== pathRestaurantId/);
  assert.match(stripeSource, /router\.get\("\/authorize\/:restauranteId", requireAdminRestaurantAccess/);
  assert.match(stripeSource, /router\.get\("\/status\/:restauranteId", requireAdminRestaurantAccess/);
  assert.match(stripeSource, /router\.post\("\/test-payment\/:restauranteId", requireAdminRestaurantAccess/);
  assert.match(stripeSource, /ON CONFLICT \(restaurante_id, woo_order_id\)/);
  assert.match(stripeSource, /router\.post\("\/create-payment-intent"/);
  assert.match(stripeSource, /router\.post\("\/refund"/);
});

test('migraciones 002/003/004 son separadas, conservadoras y verifican cutover', () => {
  assert.doesNotMatch(preflight, /^\s*(UPDATE|DELETE|INSERT|ALTER|DROP|CREATE)\b/im);
  assert.match(preflight, /Exact current constraint names/i);
  assert.match(preflight, /HAVING COUNT\(\*\) > 1/g);

  assert.match(additive, /UPDATE deliveries\s+SET restaurante_id = 1\s+WHERE restaurante_id IS NULL/i);
  assert.match(additive, /ux_pedidos_restaurante_woo_order_id/);
  assert.match(additive, /ux_deliveries_restaurante_order_number/);
  assert.match(additive, /ux_productos_restaurante_woo_product_id/);
  assert.doesNotMatch(additive, /DROP\s+(CONSTRAINT|INDEX)/i);

  assert.match(cutover, /RAISE EXCEPTION 'Cutover cancelado/);
  assert.match(cutover, /VALIDATE CONSTRAINT fk_pedidos_restaurante/);
  assert.match(cutover, /UNIQUE USING INDEX ux_pedidos_restaurante_woo_order_id/);
  assert.doesNotMatch(cutover, /^\s*(DELETE|TRUNCATE)\b/im);
});
