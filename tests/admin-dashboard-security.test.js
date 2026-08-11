const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const adminSource = fs.readFileSync(path.join(root, 'admin.js'), 'utf8');

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `No se encontró el inicio: ${start}`);
  assert.ok(endIndex > startIndex, `No se encontró el final: ${end}`);
  return source.slice(startIndex, endIndex);
}

const forbiddenCredentials = [
  'consumer_key',
  'consumer_secret',
  'shipday_api',
  'webhook_token',
  'woo_webhook_secret',
  'shipday_webhook_secret'
];

test('overview y resumen de restaurantes no seleccionan ni devuelven credenciales', () => {
  const overview = between(
    indexSource,
    "app.get('/admin/overview'",
    "app.post('/admin/restaurantes'"
  );
  const summary = between(
    indexSource,
    "app.get('/admin/restaurantes-resumen'",
    "app.get('/admin/restaurantes/:id'"
  );

  for (const field of forbiddenCredentials) {
    assert.doesNotMatch(overview, new RegExp(field));
    assert.doesNotMatch(summary, new RegExp(field));
  }
});

test('frontend del overview consume únicamente el endpoint analítico seguro', () => {
  const overviewRenderer = between(
    adminSource,
    'async function renderOverview(',
    'function recentOrdersTable('
  );

  assert.match(overviewRenderer, /fetchJson\(`\/admin\/api\/dashboard\?/);
  assert.doesNotMatch(overviewRenderer, /\/admin\/restaurantes(?:'|`)/);
  assert.doesNotMatch(overviewRenderer, /\/admin\/usuarios/);
  for (const field of forbiddenCredentials) {
    assert.doesNotMatch(overviewRenderer, new RegExp(field));
  }
});

test('credenciales solo se solicitan al abrir la configuración individual', () => {
  const detailRenderer = between(
    adminSource,
    'async function renderRestaurantDetail(id)',
    'async function guardarRestaurante('
  );

  assert.match(detailRenderer, /fetchJson\(`\/admin\/restaurantes\/\$\{id\}`\)/);
  for (const field of forbiddenCredentials) {
    assert.match(detailRenderer, new RegExp(field));
  }
});

test('rutas visuales comparten el shell y los contratos de escritura siguen vigentes', () => {
  assert.match(indexSource, /app\.get\('\/admin\/restaurants'/);
  assert.match(indexSource, /app\.get\('\/admin\/restaurants\/:id'/);
  assert.match(indexSource, /app\.post\('\/admin\/restaurantes'/);
  assert.match(indexSource, /app\.put\('\/admin\/restaurantes\/:id'/);
  assert.match(indexSource, /app\.post\('\/admin\/restaurantes\/:id\/generar-secretos'/);
  assert.match(indexSource, /app\.post\('\/admin\/usuarios'/);
});
