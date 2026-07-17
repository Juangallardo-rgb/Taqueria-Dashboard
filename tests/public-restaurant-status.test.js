const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createPublicRestaurantStatusHandler
} = require('../lib/public-restaurant-status');

function createResponse() {
  return {
    statusCode: 200,
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

function createHandlerForRow(row) {
  const pool = {
    async query(sql, params) {
      assert.match(sql, /SELECT abierto, activo/);
      assert.match(sql, /WHERE webhook_token = \$1/);
      assert.doesNotMatch(sql, /consumer_key|consumer_secret|shipday_api|nombre|logo_url/);
      assert.deepEqual(params, ['valid-token']);
      return { rows: row ? [row] : [] };
    }
  };

  return createPublicRestaurantStatusHandler({ pool });
}

test('token válido devuelve restaurante abierto sin requerir sesión', async () => {
  const handler = createHandlerForRow({ abierto: true, activo: true });
  const req = {
    params: { webhookToken: 'valid-token' },
    query: { restaurante_id: 2 },
    body: { restaurante_id: 2 }
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { abierto: true });
});

test('token válido devuelve restaurante cerrado', async () => {
  const handler = createHandlerForRow({ abierto: false, activo: true });
  const res = createResponse();

  await handler({ params: { webhookToken: 'valid-token' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { abierto: false });
});

test('token inválido devuelve 404 genérico', async () => {
  const handler = createHandlerForRow(null);
  const res = createResponse();

  await handler({ params: { webhookToken: 'valid-token' } }, res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, {
    success: false,
    message: 'No encontrado'
  });
});

test('restaurante inactivo se presenta como cerrado', async () => {
  const handler = createHandlerForRow({ abierto: true, activo: false });
  const res = createResponse();

  await handler({ params: { webhookToken: 'valid-token' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { abierto: false });
});

test('ruta pública no exige sesión y toggle continúa privado', () => {
  const indexSource = fs.readFileSync(
    path.resolve(__dirname, '..', 'index.js'),
    'utf8'
  );

  assert.match(
    indexSource,
    /app\.get\(\s*'\/public\/restaurants\/:webhookToken\/status',\s*publicRestaurantStatusHandler\s*\)/
  );
  assert.match(
    indexSource,
    /app\.post\('\/toggle-restaurante', requireSessionRestaurant/
  );
  assert.ok(
    indexSource.indexOf("'/public/restaurants/:webhookToken/status'") <
      indexSource.indexOf("app.get('/session'")
  );
});
