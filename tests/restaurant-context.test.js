const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getSessionRestaurantId,
  getLegacyRestaurantOneConfig,
  createRestaurantContext
} = require('../lib/restaurant-context');
const {
  getSessionSettings,
  SESSION_MAX_AGE_MS,
  ADMIN_SESSION_MAX_AGE_MS
} = require('../lib/session');
const { maskSecret } = require('../lib/mask-secret');
const { PUBLIC_ASSETS } = require('../lib/public-assets');

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

test('getSessionRestaurantId usa exclusivamente la sesión', () => {
  const req = {
    session: { restaurante_id: 1 },
    query: { restaurante_id: 2 },
    body: { restaurante_id: 2 }
  };

  assert.equal(getSessionRestaurantId(req), 1);
});

test('getSessionRestaurantId rechaza sesión sin restaurante y valores inválidos', () => {
  assert.throws(
    () => getSessionRestaurantId({ session: {} }),
    error => error.code === 'SESSION_RESTAURANT_MISSING' && error.statusCode === 401
  );

  assert.throws(
    () => getSessionRestaurantId({ session: { restaurante_id: 'abc' } }),
    error => error.code === 'SESSION_RESTAURANT_INVALID' && error.statusCode === 400
  );
});

test('compatibilidad legacy solo existe para restaurante 1 y flag explícito', () => {
  const env = {
    ENABLE_LEGACY_RESTAURANT_1: 'true',
    WOO_URL: 'https://restaurant-one.example',
    CONSUMER_KEY: 'key-one',
    CONSUMER_SECRET: 'secret-one',
    WEBHOOK_SECRET: 'webhook-one'
  };

  assert.equal(getLegacyRestaurantOneConfig(2, env), null);
  assert.equal(
    getLegacyRestaurantOneConfig(1, { ...env, ENABLE_LEGACY_RESTAURANT_1: 'false' }),
    null
  );

  const config = getLegacyRestaurantOneConfig(1, env);
  assert.equal(config.woo_url, env.WOO_URL);
  assert.equal(config.consumer_secret, env.CONSUMER_SECRET);
  assert.equal(config.legacy, true);
});

test('getRestaurantIntegrationConfig combina DB con legacy solo para restaurante 1', async () => {
  const pool = {
    async query(sql, params) {
      assert.match(sql, /FROM restaurantes/);
      assert.deepEqual(params, [1]);
      return {
        rows: [{
          id: 1,
          nombre: 'Restaurante 1',
          logo_url: null,
          woo_url: null,
          consumer_key: null,
          consumer_secret: null,
          shipday_api: 'shipday-db',
          webhook_token: null,
          woo_webhook_secret: null,
          shipday_webhook_secret: null,
          activo: true
        }]
      };
    }
  };

  const context = createRestaurantContext({
    pool,
    env: {
      ENABLE_LEGACY_RESTAURANT_1: 'true',
      WOO_URL: 'https://legacy.example',
      CONSUMER_KEY: 'legacy-key',
      CONSUMER_SECRET: 'legacy-secret',
      WEBHOOK_SECRET: 'legacy-webhook'
    }
  });

  const config = await context.getRestaurantIntegrationConfig(1);
  assert.equal(config.woo_url, 'https://legacy.example');
  assert.equal(config.shipday_api, 'shipday-db');
  assert.equal(config.legacy, true);
});

test('requireSessionRestaurant valida existencia/activo y expone solo datos públicos', async () => {
  const pool = {
    async query(sql, params) {
      assert.match(sql, /SELECT id, nombre, logo_url, abierto, activo/);
      assert.deepEqual(params, [1]);
      return {
        rows: [{
          id: 1,
          nombre: 'Restaurante 1',
          logo_url: '/logo.png',
          abierto: true,
          activo: true,
          consumer_secret: 'no-debe-salir'
        }]
      };
    }
  };

  const { requireSessionRestaurant } = createRestaurantContext({ pool, env: {} });
  const req = { session: { user_id: 7, restaurante_id: 1 } };
  const res = createResponse();
  let nextCalled = false;

  await requireSessionRestaurant(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.deepEqual(req.restaurant, {
    id: 1,
    nombre: 'Restaurante 1',
    logo_url: '/logo.png',
    abierto: true,
    activo: true
  });
  assert.equal('consumer_secret' in req.restaurant, false);
});

test('requireSessionRestaurant rechaza restaurante inactivo', async () => {
  const pool = {
    async query() {
      return {
        rows: [{ id: 1, nombre: 'R1', logo_url: null, abierto: false, activo: false }]
      };
    }
  };

  const { requireSessionRestaurant } = createRestaurantContext({ pool, env: {} });
  const req = { session: { user_id: 7, restaurante_id: 1 } };
  const res = createResponse();

  await requireSessionRestaurant(req, res, () => {
    throw new Error('next no debe ejecutarse');
  });

  assert.equal(res.statusCode, 403);
});

test('requireAdmin diferencia falta de sesión y rol no administrativo', () => {
  const pool = { query: async () => ({ rows: [] }) };
  const { requireAdmin } = createRestaurantContext({ pool, env: {} });

  const noSession = createResponse();
  requireAdmin({ session: {} }, noSession, () => {});
  assert.equal(noSession.statusCode, 401);

  const nonAdmin = createResponse();
  requireAdmin({ session: { user_id: 1, rol: 'cliente' } }, nonAdmin, () => {});
  assert.equal(nonAdmin.statusCode, 403);

  let nextCalled = false;
  requireAdmin({ session: { user_id: 1, rol: 'admin' } }, createResponse(), () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});

test('configuración de sesión exige secreto y endurece la cookie', () => {
  assert.throws(() => getSessionSettings({}), /SESSION_SECRET/);

  const development = getSessionSettings({
    SESSION_SECRET: 'test-secret-from-env',
    NODE_ENV: 'development'
  });
  assert.equal(development.cookie.httpOnly, true);
  assert.equal(development.cookie.sameSite, 'lax');
  assert.equal(development.cookie.secure, false);
  assert.equal(development.cookie.maxAge, SESSION_MAX_AGE_MS);
  assert.equal(ADMIN_SESSION_MAX_AGE_MS, 12 * 60 * 60 * 1000);
  assert.equal(development.cookie.priority, 'high');

  const production = getSessionSettings({
    SESSION_SECRET: 'test-secret-from-env',
    NODE_ENV: 'production'
  });
  assert.equal(production.cookie.secure, true);
});

test('maskSecret nunca devuelve el secreto completo', () => {
  assert.equal(maskSecret(null), null);
  assert.equal(maskSecret('12345678'), '********');

  const masked = maskSecret('ck_1234567890_secret');
  assert.notEqual(masked, 'ck_1234567890_secret');
  assert.match(masked, /\*/);
});

test('allowlist pública excluye backend, entorno, dependencias y migraciones', () => {
  const publicRoutes = Object.keys(PUBLIC_ASSETS);

  assert.ok(publicRoutes.includes('/app.js'));
  assert.ok(publicRoutes.includes('/styles.css'));

  for (const forbidden of [
    '/index.js',
    '/database.js',
    '/.env',
    '/package.json',
    '/admin.html',
    '/node_modules/example.js',
    '/migrations/001_multitenant_foundation.sql',
    '/routes/stripeConnect.js'
  ]) {
    assert.equal(publicRoutes.includes(forbidden), false);
  }
});
