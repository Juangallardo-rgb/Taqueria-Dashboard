const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const migrationSource = fs.readFileSync(
  path.join(root, 'migrations', '001_multitenant_foundation.sql'),
  'utf8'
);
const rollbackSource = fs.readFileSync(
  path.join(root, 'migrations', 'rollback', '001_multitenant_foundation_rollback.sql'),
  'utf8'
);

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);

  assert.notEqual(startIndex, -1, `No se encontró: ${start}`);
  assert.notEqual(endIndex, -1, `No se encontró: ${end}`);

  return source.slice(startIndex, endIndex);
}

test('la migración es aditiva, idempotente y no modifica pedidos existentes', () => {
  assert.doesNotMatch(migrationSource, /^\s*(DROP|DELETE|TRUNCATE)\b/im);
  assert.doesNotMatch(migrationSource, /UPDATE\s+pedidos\b/i);
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS restaurante_id INTEGER/i);
  assert.match(migrationSource, /UPDATE deliveries\s+SET restaurante_id = 1\s+WHERE restaurante_id IS NULL/i);
  assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS user_sessions/i);
  assert.match(migrationSource, /idx_pedidos_restaurante_created_at/i);
  assert.match(migrationSource, /idx_deliveries_restaurante_order_number/i);
  assert.match(migrationSource, /HAVING COUNT\(\*\) > 1/i);
});

test('el rollback SQL es deliberadamente no destructivo', () => {
  assert.doesNotMatch(rollbackSource, /^\s*(DROP|DELETE|TRUNCATE|ALTER\s+TABLE)\b/im);
  assert.match(rollbackSource, /No destructive schema rollback is required/i);
});

test('los webhooks conservan hardcode y conflictos actuales de restaurante 1', () => {
  const wooWebhook = between(
    indexSource,
    "app.post('/webhook-order'",
    "app.post('/webhook-shipday'"
  );
  assert.match(wooWebhook, /const restauranteId = 1;/);
  assert.match(wooWebhook, /ON CONFLICT \(woo_order_id\)/);

  const shipdayWebhook = between(
    indexSource,
    "app.post('/webhook-shipday'",
    "app.get('/shipday-live'"
  );
  assert.match(shipdayWebhook, /const restauranteId = 1;/);
  assert.match(shipdayWebhook, /ON CONFLICT \(order_number\)/);
});

test('orders-complete, orders-latest y cachePedidos mantienen su lógica actual', () => {
  const complete = between(
    indexSource,
    "app.get('/orders-complete'",
    "app.get('/orders-latest'"
  );
  assert.match(complete, /req\.session\?\.restaurante_id \|\| 1/);
  assert.match(complete, /cachePedidos\.get\(cacheKey\)/);

  const latest = between(
    indexSource,
    "app.get('/orders-latest'",
    "app.get('/products'"
  );
  assert.match(latest, /req\.session\?\.restaurante_id \|\| 1/);
  assert.match(latest, /LIMIT 1/);
});

test('productos, acciones Woo, refunds, Stripe y push no se conectan al helper nuevo', () => {
  const excludedOperationalCalls = [
    "app.post('/webhook-product'",
    "app.post('/acciones-woo'",
    "app.post('/refund'",
    "app.post('/push-subscribe'"
  ];

  for (const route of excludedOperationalCalls) {
    assert.ok(indexSource.includes(route), `Debe conservarse ${route}`);
  }

  assert.match(indexSource, /const WOO_URL = process\.env\.WOO_URL/);
  assert.match(indexSource, /const WEBHOOK_SECRET = process\.env\.WEBHOOK_SECRET/);
});

test('el frontend valida sesión antes de iniciar dashboard y conserva polling', () => {
  const sessionCheck = appSource.indexOf("fetch('/session'");
  const startDashboard = appSource.indexOf('await mostrarInicio()');

  assert.ok(sessionCheck >= 0);
  assert.ok(startDashboard > sessionCheck);
  assert.match(appSource, /localStorage\.removeItem\('login'\)/);
  assert.match(appSource, /setInterval\(\(\) =>[\s\S]*?verPedidos\(true\);[\s\S]*?20000\);/);
  assert.match(appSource, /setInterval\(\(\) =>[\s\S]*?chequearUltimoPedido\(\);[\s\S]*?5000\);/);
});

test('el backend ya no sirve el repositorio completo como contenido estático', () => {
  assert.doesNotMatch(indexSource, /express\.static\(__dirname\)/);
  assert.match(indexSource, /registerPublicAssetRoutes\(app, __dirname\)/);
  assert.match(indexSource, /app\.use\('\/admin', requireAdmin\)/);
});

test('login regenera la sesión y no reemplaza restaurante faltante por 1', () => {
  const login = between(
    indexSource,
    "app.post('/login'",
    "app.get('/admin'"
  );

  assert.match(login, /await regenerateSession\(req\)/);
  assert.match(login, /req\.session\.user_id/);
  assert.match(login, /req\.session\.email/);
  assert.match(login, /req\.session\.rol/);
  assert.match(login, /req\.session\.restaurante_id = restauranteId/);
  assert.doesNotMatch(login, /restaurante_id \|\| 1/);
});

test('session, logout y mi-restaurante están protegidos y limitan la respuesta', () => {
  assert.match(indexSource, /app\.get\('\/session', requireSessionRestaurant/);
  assert.match(indexSource, /app\.post\('\/logout'/);
  assert.match(indexSource, /await destroySession\(req\)/);
  assert.match(indexSource, /res\.clearCookie\(SESSION_COOKIE_NAME/);
  assert.match(indexSource, /app\.get\('\/mi-restaurante', requireSessionRestaurant/);
});

test('admin no usa SELECT * y enmascara credenciales', () => {
  const admin = between(
    indexSource,
    "app.post('/admin/restaurantes'",
    "app.post('/refund'"
  );

  assert.doesNotMatch(admin, /SELECT \* FROM restaurantes/i);
  assert.match(admin, /consumer_key: maskSecret\(restaurant\.consumer_key\)/);
  assert.match(admin, /consumer_secret: maskSecret\(restaurant\.consumer_secret\)/);
  assert.match(admin, /shipday_api: maskSecret\(restaurant\.shipday_api\)/);
  assert.match(admin, /AND activo IS NOT FALSE/);
});
