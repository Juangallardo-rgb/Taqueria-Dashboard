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

test('la migración de Fase 1 sigue siendo aditiva y el rollback no destructivo', () => {
  assert.doesNotMatch(migrationSource, /^\s*(DROP|DELETE|TRUNCATE)\b/im);
  assert.doesNotMatch(migrationSource, /UPDATE\s+pedidos\b/i);
  assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS user_sessions/i);
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS webhook_token TEXT/i);
  assert.doesNotMatch(rollbackSource, /^\s*(DROP|DELETE|TRUNCATE|ALTER\s+TABLE)\b/im);
});

test('login y contexto público conservan la sesión persistente de Fase 1', () => {
  const login = between(
    indexSource,
    'async function authenticateCredentials',
    '// LOGIN GENERAL'
  );

  assert.match(login, /await regenerateSession\(req\)/);
  assert.match(login, /req\.session\.restaurante_id = restauranteId/);
  assert.doesNotMatch(login, /restaurante_id \|\| 1/);
  assert.match(indexSource, /app\.post\('\/login', requireSameOrigin/);
  assert.match(indexSource, /app\.get\('\/session', requireSessionRestaurant/);
  assert.match(indexSource, /app\.get\('\/mi-restaurante', requireSessionRestaurant/);
  assert.match(indexSource, /await destroySession\(req\)/);
});

test('el repositorio no se publica completo y admin permanece protegido', () => {
  assert.doesNotMatch(indexSource, /express\.static\(__dirname\)/);
  assert.match(indexSource, /registerPublicAssetRoutes\(app, __dirname\)/);
  assert.match(indexSource, /app\.use\('\/admin', requireAdmin\)/);
});

test('el frontend valida sesión, conserva polling y aplica identidad dinámica', () => {
  const sessionCheck = appSource.indexOf("fetch('/session'");
  const startDashboard = appSource.indexOf('await mostrarInicio()');

  assert.ok(sessionCheck >= 0);
  assert.ok(startDashboard > sessionCheck);
  assert.match(appSource, /setInterval\(\(\) =>[\s\S]*?verPedidos\(true\);[\s\S]*?20000\);/);
  assert.match(appSource, /setInterval\(\(\) =>[\s\S]*?chequearUltimoPedido\(\);[\s\S]*?5000\);/);
  assert.match(appSource, /name\.textContent = restaurant\.nombre/);
  assert.match(appSource, /document\.title = restaurant\.nombre/);
});
