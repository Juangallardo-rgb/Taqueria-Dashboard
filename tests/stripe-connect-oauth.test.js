const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const routePath = path.resolve(__dirname, '..', 'routes', 'stripeConnect.js');
const originalLoad = Module._load;
const originalEnv = {
  STRIPE_CONNECT_CLIENT_ID: process.env.STRIPE_CONNECT_CLIENT_ID,
  STRIPE_CONNECT_REDIRECT_URI: process.env.STRIPE_CONNECT_REDIRECT_URI,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY
};

process.env.STRIPE_CONNECT_CLIENT_ID = 'ca_test_denix';
process.env.STRIPE_CONNECT_REDIRECT_URI = 'https://denix.test/api/stripe/connect/callback';
process.env.STRIPE_SECRET_KEY = 'sk_test_denix';

const harness = {
  authorizeQueries: [],
  callback: null,
  stripeRetrieveCalls: []
};

const restaurants = new Map([
  [1, {
    id: 1,
    nombre: 'Restaurante Uno',
    stripe_account_id: 'acct_restaurante_1',
    stripe_connect_status: 'active',
    stripe_livemode: false
  }],
  [5, {
    id: 5,
    nombre: 'Taquería La Doña',
    stripe_account_id: null,
    stripe_connect_status: null,
    stripe_livemode: false
  }]
]);

function compactSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function createCallbackScenario(overrides = {}) {
  return {
    oauthState: {
      id: 91,
      restaurante_id: 5,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      used: false
    },
    stripeAccountId: 'acct_target_5',
    accountOwners: [],
    restaurantUpdateRowCount: 1,
    queries: [],
    restaurantUpdates: [],
    stateUpdates: [],
    fetchCalls: 0,
    ...overrides
  };
}

function createCallbackClient(scenario) {
  return {
    async query(sql, params = []) {
      const normalized = compactSql(sql);
      scenario.queries.push({ sql: normalized, params });

      if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
        return { rowCount: null, rows: [] };
      }

      if (normalized.includes('FROM stripe_oauth_states')) {
        return scenario.oauthState
          ? { rowCount: 1, rows: [scenario.oauthState] }
          : { rowCount: 0, rows: [] };
      }

      if (normalized.includes('pg_advisory_xact_lock')) {
        return { rowCount: 1, rows: [{}] };
      }

      if (normalized.includes('WHERE stripe_account_id = $1')) {
        const [stripeAccountId, targetRestaurantId] = params;
        const conflicts = scenario.accountOwners.filter(owner => (
          owner.stripe_account_id === stripeAccountId &&
          owner.id !== targetRestaurantId
        ));
        return { rowCount: conflicts.length, rows: conflicts };
      }

      if (normalized.startsWith('UPDATE restaurantes')) {
        scenario.restaurantUpdates.push(params);
        return { rowCount: scenario.restaurantUpdateRowCount, rows: [] };
      }

      if (normalized.startsWith('UPDATE stripe_oauth_states')) {
        scenario.stateUpdates.push(params);
        return { rowCount: 1, rows: [] };
      }

      throw new Error(`Consulta inesperada en callback: ${normalized}`);
    },
    release() {}
  };
}

const pool = {
  async query(sql, params = []) {
    const normalized = compactSql(sql);
    harness.authorizeQueries.push({ sql: normalized, params });

    if (normalized.includes('FROM restaurantes') && normalized.includes('WHERE id = $1')) {
      const restaurant = restaurants.get(Number(params[0]));
      return {
        rowCount: restaurant ? 1 : 0,
        rows: restaurant ? [restaurant] : []
      };
    }

    if (normalized.startsWith('INSERT INTO stripe_oauth_states')) {
      return { rowCount: 1, rows: [] };
    }

    throw new Error(`Consulta inesperada en authorize: ${normalized}`);
  },
  async connect() {
    if (!harness.callback) {
      throw new Error('Falta configurar el escenario del callback');
    }
    return createCallbackClient(harness.callback);
  }
};

const stripeClient = {
  accounts: {
    async retrieve(stripeAccountId) {
      harness.stripeRetrieveCalls.push(stripeAccountId);
      return {
        id: stripeAccountId,
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true
      };
    }
  }
};

class StripeMock {
  constructor() {
    return stripeClient;
  }
}

Module._load = function loadWithStripeConnectMocks(request, parent, isMain) {
  if (request === '../database') return pool;
  if (request === 'stripe') return StripeMock;
  if (request === '../lib/default-order-integrity') {
    return { persistStripePayment: async () => ({}) };
  }
  if (request === '../lib/order-integrity') {
    return { scheduleHydrationAfterResponse() {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

delete require.cache[routePath];
const router = require(routePath);
Module._load = originalLoad;

function routeHandlers(route, method) {
  const layer = router.stack.find(candidate => (
    candidate.route?.path === route && candidate.route?.methods?.[method]
  ));
  assert.ok(layer, `No se encontró ${method.toUpperCase()} ${route}`);
  return layer.route.stack.map(candidate => candidate.handle);
}

const [authorizeMiddleware, authorizeHandler] = routeHandlers(
  '/authorize/:restauranteId',
  'get'
);
const [callbackHandler] = routeHandlers('/callback', 'get');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    redirectUrl: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    redirect(url) {
      this.statusCode = 302;
      this.redirectUrl = url;
      return this;
    }
  };
}

function resetAuthorizeHarness() {
  harness.authorizeQueries = [];
}

async function runAuthorize(session, restauranteId) {
  const req = {
    session,
    params: { restauranteId: String(restauranteId) }
  };
  const res = createResponse();
  let authorized = false;

  authorizeMiddleware(req, res, () => {
    authorized = true;
  });

  if (authorized) {
    await authorizeHandler(req, res);
  }

  return { res, authorized };
}

async function runCallback(scenario) {
  harness.callback = scenario;
  harness.stripeRetrieveCalls = [];
  const originalFetch = global.fetch;
  global.fetch = async () => {
    scenario.fetchCalls += 1;
    return {
      ok: true,
      async json() {
        return { stripe_user_id: scenario.stripeAccountId };
      }
    };
  };

  try {
    const req = { query: { code: 'oauth_code', state: 'oauth_state' } };
    const res = createResponse();
    await callbackHandler(req, res);
    return res;
  } finally {
    global.fetch = originalFetch;
  }
}

test.after(() => {
  delete require.cache[routePath];
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('admin del restaurante 1 puede iniciar authorize para restaurante 5', async () => {
  resetAuthorizeHarness();
  const result = await runAuthorize({ user_id: 10, rol: 'admin', restaurante_id: 1 }, 5);

  assert.equal(result.authorized, true);
  assert.equal(result.res.statusCode, 302);
  assert.match(result.res.redirectUrl, /^https:\/\/connect\.stripe\.com\/oauth\/authorize\?/);
});

test('admin puede iniciar authorize para su propio restaurante 1', async () => {
  resetAuthorizeHarness();
  const result = await runAuthorize({ user_id: 10, rol: 'admin', restaurante_id: 1 }, 1);

  assert.equal(result.authorized, true);
  assert.equal(result.res.statusCode, 302);
});

test('usuario normal del restaurante 5 recibe 403', async () => {
  resetAuthorizeHarness();
  const result = await runAuthorize({ user_id: 20, rol: 'cliente', restaurante_id: 5 }, 5);

  assert.equal(result.authorized, false);
  assert.equal(result.res.statusCode, 403);
  assert.equal(harness.authorizeQueries.length, 0);
});

test('usuario sin sesión recibe 403 según el comportamiento existente', async () => {
  resetAuthorizeHarness();
  const result = await runAuthorize(undefined, 5);

  assert.equal(result.authorized, false);
  assert.equal(result.res.statusCode, 403);
  assert.equal(harness.authorizeQueries.length, 0);
});

test('authorize para restaurante 5 guarda el state exactamente con restaurante_id 5', async () => {
  resetAuthorizeHarness();
  const result = await runAuthorize({ user_id: 10, rol: 'admin', restaurante_id: 1 }, 5);
  const stateInsert = harness.authorizeQueries.find(query => (
    query.sql.startsWith('INSERT INTO stripe_oauth_states')
  ));

  assert.equal(result.res.statusCode, 302);
  assert.ok(stateInsert);
  assert.match(stateInsert.params[0], /^[a-f0-9]{64}$/);
  assert.equal(stateInsert.params[1], 5);
});

test('callback del state de restaurante 5 actualiza únicamente restaurante 5', async () => {
  const scenario = createCallbackScenario();
  const res = await runCallback(scenario);

  assert.equal(res.statusCode, 200);
  assert.equal(scenario.restaurantUpdates.length, 1);
  assert.equal(scenario.restaurantUpdates[0][0], 'acct_target_5');
  assert.equal(scenario.restaurantUpdates[0][3], 5);
  assert.deepEqual(scenario.stateUpdates, [[91]]);
  assert.ok(scenario.queries.some(query => query.sql === 'COMMIT'));
});

test('acct asociado al restaurante 4 no puede conectarse al restaurante 5', async () => {
  const scenario = createCallbackScenario({
    stripeAccountId: 'acct_restaurante_4',
    accountOwners: [{ id: 4, stripe_account_id: 'acct_restaurante_4' }]
  });
  const res = await runCallback(scenario);

  assert.equal(res.statusCode, 409);
  assert.match(res.body, /otro restaurante/);
  assert.equal(scenario.restaurantUpdates.length, 0);
  assert.equal(scenario.stateUpdates.length, 0);
  assert.ok(scenario.queries.some(query => query.sql.includes('pg_advisory_xact_lock')));
  assert.ok(scenario.queries.some(query => query.sql === 'ROLLBACK'));
  assert.equal(scenario.queries.some(query => query.sql === 'COMMIT'), false);
});

test('reintento del mismo acct en el mismo restaurante es seguro e idempotente', async () => {
  const scenario = createCallbackScenario({
    stripeAccountId: 'acct_target_5',
    accountOwners: [{ id: 5, stripe_account_id: 'acct_target_5' }]
  });
  const res = await runCallback(scenario);

  assert.equal(res.statusCode, 200);
  assert.equal(scenario.restaurantUpdates.length, 1);
  assert.equal(scenario.restaurantUpdates[0][3], 5);
  assert.deepEqual(scenario.stateUpdates, [[91]]);
  assert.ok(scenario.queries.some(query => query.sql === 'COMMIT'));
});

test('state vencido sigue siendo rechazado', async () => {
  const scenario = createCallbackScenario({
    oauthState: {
      id: 92,
      restaurante_id: 5,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      used: false
    }
  });
  const res = await runCallback(scenario);

  assert.equal(res.statusCode, 400);
  assert.match(res.body, /expirado/);
  assert.equal(scenario.fetchCalls, 0);
  assert.equal(scenario.restaurantUpdates.length, 0);
  assert.ok(scenario.queries.some(query => query.sql === 'ROLLBACK'));
});

test('state usado sigue siendo rechazado', async () => {
  const scenario = createCallbackScenario({
    oauthState: {
      id: 93,
      restaurante_id: 5,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      used: true
    }
  });
  const res = await runCallback(scenario);

  assert.equal(res.statusCode, 400);
  assert.match(res.body, /ya fue utilizado/);
  assert.equal(scenario.fetchCalls, 0);
  assert.equal(scenario.restaurantUpdates.length, 0);
  assert.ok(scenario.queries.some(query => query.sql === 'ROLLBACK'));
});

test('callback revierte si UPDATE restaurantes no afecta exactamente una fila', async () => {
  for (const rowCount of [0, 2]) {
    const scenario = createCallbackScenario({ restaurantUpdateRowCount: rowCount });
    const originalConsoleError = console.error;
    console.error = () => {};
    let res;

    try {
      res = await runCallback(scenario);
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(res.statusCode, 500);
    assert.equal(scenario.stateUpdates.length, 0);
    assert.ok(scenario.queries.some(query => query.sql === 'ROLLBACK'));
    assert.equal(scenario.queries.some(query => query.sql === 'COMMIT'), false);
  }
});
