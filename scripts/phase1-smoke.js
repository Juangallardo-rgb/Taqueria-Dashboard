const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const baseUrl = String(process.env.SMOKE_BASE_URL || '').replace(/\/$/, '');
const mode = process.env.SMOKE_MODE || 'standard';
const cookieFile = path.resolve(
  process.env.SMOKE_SESSION_FILE || '.phase1-smoke-cookie'
);

if (!baseUrl) {
  throw new Error('SMOKE_BASE_URL es requerida; use únicamente un entorno local o staging');
}

function createClient(initialCookie = '') {
  let cookie = initialCookie;

  return {
    getCookie: () => cookie,
    async request(route, options = {}) {
      const headers = new Headers(options.headers || {});

      if (cookie) headers.set('Cookie', cookie);

      const response = await fetch(`${baseUrl}${route}`, {
        ...options,
        headers,
        redirect: 'manual'
      });

      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];

      const contentType = response.headers.get('content-type') || '';
      const body = contentType.includes('application/json')
        ? await response.json()
        : await response.text();

      return { response, body };
    }
  };
}

async function login(client, email, password) {
  const result = await client.request('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });

  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.success, true);
}

function assertMasked(value, field) {
  assert.ok(
    value === null || (typeof value === 'string' && value.includes('*')),
    `${field} debe estar vacío o enmascarado`
  );
}

async function verifyPersistedSession() {
  assert.equal(fs.existsSync(cookieFile), true, `No existe ${cookieFile}`);

  const client = createClient(fs.readFileSync(cookieFile, 'utf8').trim());
  const session = await client.request('/session');

  assert.equal(session.response.status, 200, JSON.stringify(session.body));
  assert.equal(session.body.authenticated, true);

  await client.request('/logout', { method: 'POST' });
  fs.rmSync(cookieFile, { force: true });

  console.log('OK: la sesión sobrevivió al reinicio del proceso');
}

async function run() {
  if (mode === 'resume') {
    await verifyPersistedSession();
    return;
  }

  const email = process.env.SMOKE_USER_EMAIL;
  const password = process.env.SMOKE_USER_PASSWORD;
  const expectedRestaurantId = Number(process.env.SMOKE_RESTAURANT_ID || 1);

  if (!email || !password) {
    throw new Error('SMOKE_USER_EMAIL y SMOKE_USER_PASSWORD son requeridas');
  }

  const anonymous = createClient();
  const anonymousSession = await anonymous.request('/session');
  assert.equal(anonymousSession.response.status, 401);
  assert.equal(anonymousSession.body.authenticated, false);

  const client = createClient();
  await login(client, email, password);

  const session = await client.request('/session');
  assert.equal(session.response.status, 200, JSON.stringify(session.body));
  assert.equal(session.body.authenticated, true);
  assert.equal(session.body.user.restaurante_id, expectedRestaurantId);

  const restaurant = await client.request('/mi-restaurante?restaurante_id=2');
  assert.equal(restaurant.response.status, 200, JSON.stringify(restaurant.body));
  assert.equal(restaurant.body.id, expectedRestaurantId);
  assert.equal('consumer_secret' in restaurant.body, false);

  const complete = await client.request('/orders-complete');
  assert.equal(complete.response.status, 200, JSON.stringify(complete.body));
  assert.equal(Array.isArray(complete.body), true);

  const latest = await client.request('/orders-latest');
  assert.equal(latest.response.status, 200, JSON.stringify(latest.body));

  for (const forbiddenPath of [
    '/index.js',
    '/database.js',
    '/.env',
    '/package.json',
    '/admin.html',
    '/node_modules/connect-pg-simple/index.js',
    '/migrations/001_multitenant_foundation.sql',
    '/routes/stripeConnect.js'
  ]) {
    const forbidden = await client.request(forbiddenPath);
    assert.equal(
      forbidden.response.status,
      404,
      `${forbiddenPath} no debe ser público`
    );
  }

  const nonAdmin = await client.request('/admin/restaurantes');
  assert.equal(nonAdmin.response.status, 403);

  if (process.env.SMOKE_ADMIN_EMAIL && process.env.SMOKE_ADMIN_PASSWORD) {
    const admin = createClient();
    await login(
      admin,
      process.env.SMOKE_ADMIN_EMAIL,
      process.env.SMOKE_ADMIN_PASSWORD
    );

    const restaurants = await admin.request('/admin/restaurantes');
    assert.equal(restaurants.response.status, 200, JSON.stringify(restaurants.body));
    assert.equal(Array.isArray(restaurants.body), true);

    for (const item of restaurants.body) {
      assertMasked(item.consumer_key, 'consumer_key');
      assertMasked(item.consumer_secret, 'consumer_secret');
      assertMasked(item.shipday_api, 'shipday_api');
      assert.deepEqual(
        Object.keys(item).sort(),
        [
          'activo',
          'consumer_key',
          'consumer_secret',
          'created_at',
          'id',
          'logo_url',
          'nombre',
          'shipday_api',
          'updated_at',
          'woo_url'
        ].sort()
      );
    }
  }

  if (mode === 'login') {
    fs.writeFileSync(cookieFile, client.getCookie(), { encoding: 'utf8', mode: 0o600 });
    console.log(`OK: sesión guardada en ${cookieFile}. Reinicie staging y ejecute SMOKE_MODE=resume.`);
    return;
  }

  const logout = await client.request('/logout', { method: 'POST' });
  assert.equal(logout.response.status, 200, JSON.stringify(logout.body));
  assert.equal(logout.body.success, true);

  const afterLogout = await client.request('/session');
  assert.equal(afterLogout.response.status, 401);

  console.log('OK: smoke test phase 1 completado');
}

run().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
