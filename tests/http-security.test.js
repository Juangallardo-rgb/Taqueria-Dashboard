const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applySecurityHeaders,
  createLoginAttemptLimiter,
  redirectAdminShellToLogin,
  requireAdminCsrf,
  requireSameOrigin
} = require('../lib/http-security');

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    redirectValue: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    redirect(code, value) { this.statusCode = code; this.redirectValue = value; return this; },
    setHeader(name, value) { this.headers[name] = value; }
  };
}

function request(overrides = {}) {
  const headers = Object.fromEntries(
    Object.entries(overrides.headers || {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    method: 'POST',
    protocol: 'https',
    path: '/',
    originalUrl: '/admin',
    ip: '127.0.0.1',
    session: {},
    ...overrides,
    get(name) { return headers[String(name).toLowerCase()]; }
  };
}

test('protección de origen acepta el mismo sitio y rechaza uno externo', () => {
  let nextCalled = false;
  requireSameOrigin(request({ headers: { origin: 'https://dashboard.denixorders.com', host: 'dashboard.denixorders.com' } }), response(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);

  const denied = response();
  requireSameOrigin(request({ headers: { origin: 'https://evil.example', host: 'dashboard.denixorders.com' } }), denied, () => {});
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.code, 'ORIGIN_NOT_ALLOWED');
});

test('CSRF administrativo exige el token de la sesión en mutaciones', () => {
  let nextCalled = false;
  requireAdminCsrf(request({ session: { csrf_token: 'token-seguro' }, headers: { 'x-csrf-token': 'token-seguro' } }), response(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);

  const denied = response();
  requireAdminCsrf(request({ session: { csrf_token: 'token-seguro' }, headers: { 'x-csrf-token': 'otro-token-x' } }), denied, () => {});
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.code, 'CSRF_TOKEN_INVALID');

  const unicodeDenied = response();
  assert.doesNotThrow(() => {
    requireAdminCsrf(request({ session: { csrf_token: 'aaaa' }, headers: { 'x-csrf-token': 'áááá' } }), unicodeDenied, () => {});
  });
  assert.equal(unicodeDenied.statusCode, 403);
});

test('CSP administrativo bloquea scripts inline sin romper el panel heredado', () => {
  const adminResponse = response();
  applySecurityHeaders(request({ method: 'GET', path: '/admin/login' }), adminResponse, () => {});
  assert.match(adminResponse.headers['Content-Security-Policy'], /script-src 'self';/);
  assert.doesNotMatch(adminResponse.headers['Content-Security-Policy'], /script-src 'self' 'unsafe-inline'/);
  assert.doesNotMatch(adminResponse.headers['Content-Security-Policy'], /cdn\.jsdelivr\.net/);

  const legacyResponse = response();
  applySecurityHeaders(request({ method: 'GET', path: '/' }), legacyResponse, () => {});
  assert.match(
    legacyResponse.headers['Content-Security-Policy'],
    /script-src 'self' 'unsafe-inline' https:\/\/cdn\.jsdelivr\.net/
  );
});

test('limitador bloquea el sexto intento y se limpia tras un acceso correcto', () => {
  let clock = 1000;
  const limiter = createLoginAttemptLimiter({ now: () => clock, maxAttempts: 5, windowMs: 60000 });
  const req = request();

  for (let index = 0; index < 5; index += 1) limiter.fail(req, 'admin@denix.test');
  assert.equal(limiter.check(req, 'admin@denix.test').allowed, false);
  limiter.clear(req, 'admin@denix.test');
  assert.equal(limiter.check(req, 'admin@denix.test').allowed, true);

  limiter.fail(req, 'admin@denix.test');
  clock += 60001;
  assert.equal(limiter.check(req, 'admin@denix.test').allowed, true);
});

test('navegación administrativa anónima redirige al login, API no', () => {
  const visual = response();
  redirectAdminShellToLogin(request({ method: 'GET', path: '/restaurants', originalUrl: '/admin/restaurants' }), visual, () => {});
  assert.equal(visual.statusCode, 302);
  assert.match(visual.redirectValue, /^\/admin\/login\?next=/);

  let apiNext = false;
  redirectAdminShellToLogin(request({ method: 'GET', path: '/api/dashboard', originalUrl: '/admin/api/dashboard' }), response(), () => { apiNext = true; });
  assert.equal(apiNext, true);
});
