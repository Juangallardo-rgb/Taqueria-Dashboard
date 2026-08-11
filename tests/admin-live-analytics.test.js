const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  normalizeDashboardRange,
  normalizeOverview,
  createAdminAnalytics
} = require('../lib/admin-analytics');
const {
  sanitizeAdminEvent,
  createAdminEventHub,
  createBestEffortAdminPublisher
} = require('../lib/admin-events');
const { createRestaurantContext } = require('../lib/restaurant-context');

const root = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const analyticsSource = fs.readFileSync(path.join(root, 'lib', 'admin-analytics.js'), 'utf8');

const fixedNow = new Date('2026-08-11T15:30:00.000Z');

function assertPostgresParametersAreContiguous(sql, params) {
  const indexes = new Set(Array.from(sql.matchAll(/\$(\d+)/g), match => Number(match[1])));
  const maxIndex = Math.max(0, ...indexes);
  assert.equal(params.length, maxIndex, 'La cantidad de valores debe coincidir con el placeholder máximo');
  for (let index = 1; index <= maxIndex; index += 1) {
    assert.ok(indexes.has(index), `El parámetro $${index} no puede quedar sin uso ni tipo`);
    if (params[index - 1] === null) {
      assert.match(sql, new RegExp(`\\$${index}\\s*::`), `El parámetro nullable $${index} requiere cast explícito`);
    }
  }
}

function restaurantParameter(sql, params) {
  return sql.includes('admin-analytics:overview') ? params[3] : params[2];
}

function createAnalyticsPool({ strictParameters = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (strictParameters) assertPostgresParametersAreContiguous(sql, params);
      const restauranteId = restaurantParameter(sql, params);
      if (sql.includes('admin-analytics:overview')) {
        return { rows: [{
          gross_sales: '300.00', refunds_amount: '20.00', orders: 3,
          pickup_orders: 1, delivery_orders: 2, refunds_count: 1,
          previous_gross_sales: '200.00', previous_refunds_amount: '0',
          total_restaurants: restauranteId ? 1 : 3,
          open_restaurants: restauranteId ? 1 : 2,
          closed_restaurants: restauranteId ? 0 : 1
        }] };
      }
      if (sql.includes('admin-analytics:restaurants')) {
        const rows = [
          { id: 1, nombre: 'Uno', abierto: true, activo: true, gross_sales: '120', refunds_amount: '20', orders: 1, refunds_count: 1, pickup_orders: 1, delivery_orders: 0, last_order_at: fixedNow, last_woo_order_id: '77' },
          { id: 4, nombre: 'Cuatro', abierto: true, activo: true, gross_sales: '110', refunds_amount: '0', orders: 1, refunds_count: 0, pickup_orders: 0, delivery_orders: 1, last_order_at: fixedNow, last_woo_order_id: '77' },
          { id: 5, nombre: 'Cinco', abierto: false, activo: true, gross_sales: '70', refunds_amount: '0', orders: 1, refunds_count: 0, pickup_orders: 0, delivery_orders: 1, last_order_at: fixedNow, last_woo_order_id: '88' }
        ];
        return { rows: restauranteId ? rows.filter(row => row.id === restauranteId) : rows };
      }
      if (sql.includes('admin-analytics:latest-orders')) {
        const rows = [
          { id: 101, restaurante_id: 1, restaurante_nombre: 'Uno', woo_order_id: '77', customer_name: 'A', total: '120', estado: 'processing', refunded: true, refund_amount: '20', created_at: fixedNow, order_type: 'pickup' },
          { id: 202, restaurante_id: 4, restaurante_nombre: 'Cuatro', woo_order_id: '77', customer_name: 'B', total: '110', estado: 'completed', refunded: false, created_at: fixedNow, order_type: 'delivery' },
          { id: 303, restaurante_id: 5, restaurante_nombre: 'Cinco', woo_order_id: '88', customer_name: 'C', total: '70', estado: 'processing', refunded: false, created_at: fixedNow, order_type: 'delivery' }
        ];
        return { rows: restauranteId ? rows.filter(row => row.restaurante_id === restauranteId) : rows };
      }
      if (sql.includes('admin-analytics:timeline')) {
        return { rows: [{ bucket: '2026-08-11 15:00:00', gross_sales: '300', refunds_amount: '20', orders: 3 }] };
      }
      throw new Error('Consulta inesperada');
    }
  };
}

test('filtros today, yesterday, 7d y personalizado producen límites exclusivos correctos', () => {
  const options = { now: fixedNow, timezone: 'UTC' };
  assert.deepEqual(
    { start: normalizeDashboardRange({ range: 'today' }, options).start, end: normalizeDashboardRange({ range: 'today' }, options).end },
    { start: '2026-08-11', end: '2026-08-11' }
  );
  assert.equal(normalizeDashboardRange({ range: 'yesterday' }, options).start, '2026-08-10');
  assert.equal(normalizeDashboardRange({ range: '7d' }, options).start, '2026-08-05');
  const custom = normalizeDashboardRange({ range: 'custom', start: '2026-07-01', end: '2026-07-09' }, options);
  assert.equal(custom.start_at, '2026-07-01T00:00:00.000Z');
  assert.equal(custom.end_at, '2026-07-10T00:00:00.000Z');
});

test('timezone corporativa America/Los_Angeles aplica PDT y PST automáticamente', async () => {
  const timezone = 'America/Los_Angeles';
  const summerOptions = { now: new Date('2026-08-11T15:30:00.000Z'), timezone };
  const today = normalizeDashboardRange({ range: 'today' }, summerOptions);
  const yesterday = normalizeDashboardRange({ range: 'yesterday' }, summerOptions);
  const sevenDays = normalizeDashboardRange({ range: '7d' }, summerOptions);
  const thirtyDays = normalizeDashboardRange({ range: '30d' }, summerOptions);

  assert.equal(today.start_at, '2026-08-11T07:00:00.000Z');
  assert.equal(today.end_at, '2026-08-12T07:00:00.000Z');
  assert.equal(yesterday.start_at, '2026-08-10T07:00:00.000Z');
  assert.equal(yesterday.end_at, '2026-08-11T07:00:00.000Z');
  assert.equal(sevenDays.start_at, '2026-08-05T07:00:00.000Z');
  assert.equal(sevenDays.end_at, '2026-08-12T07:00:00.000Z');
  assert.equal(thirtyDays.start_at, '2026-07-13T07:00:00.000Z');
  assert.equal(thirtyDays.end_at, '2026-08-12T07:00:00.000Z');

  const winter = normalizeDashboardRange(
    { range: 'today' },
    { now: new Date('2026-01-15T20:00:00.000Z'), timezone }
  );
  assert.equal(winter.start_at, '2026-01-15T08:00:00.000Z');
  assert.equal(winter.end_at, '2026-01-16T08:00:00.000Z');

  const analytics = createAdminAnalytics({
    pool: createAnalyticsPool(),
    env: { ADMIN_DASHBOARD_TIMEZONE: timezone },
    now: () => summerOptions.now
  });
  const snapshot = await analytics.getDashboardSnapshot({ range: 'today' });
  assert.equal(snapshot.timezone.name, timezone);
  assert.equal(snapshot.timezone.source, 'environment');
  assert.equal(snapshot.range.start_at, '2026-08-11T07:00:00.000Z');
});

test('ventas brutas, refunds, netas y ticket se calculan con semántica explícita', () => {
  const result = normalizeOverview({
    gross_sales: '300.00', refunds_amount: '20.00', orders: 3,
    pickup_orders: 1, delivery_orders: 2, refunds_count: 1,
    previous_gross_sales: '200.00', previous_refunds_amount: '0'
  });
  assert.equal(result.gross_sales, 300);
  assert.equal(result.refunds_amount, 20);
  assert.equal(result.net_sales, 280);
  assert.equal(result.average_ticket, 93.33);
  assert.equal(result.net_sales_change_percent, 40);
});

test('snapshot incluye restaurantes 1, 4 y 5 sin mezclar el mismo woo_order_id', async () => {
  const pool = createAnalyticsPool();
  const analytics = createAdminAnalytics({ pool, env: { ADMIN_DASHBOARD_TIMEZONE: 'UTC' }, now: () => fixedNow });
  const snapshot = await analytics.getDashboardSnapshot({ range: 'today' });
  assert.deepEqual(snapshot.restaurants.map(row => row.id), [1, 4, 5]);
  const repeated = snapshot.latest_orders.filter(order => order.woo_order_id === '77');
  assert.deepEqual(repeated.map(order => order.restaurante_id), [1, 4]);
  assert.equal(snapshot.restaurants[0].net_sales, 100);
  assert.equal(snapshot.overview.pickup_orders, 1);
  assert.equal(snapshot.overview.delivery_orders, 2);
});

test('filtro de restaurante viaja como parámetro y limita latest orders', async () => {
  const pool = createAnalyticsPool();
  const analytics = createAdminAnalytics({ pool, env: { ADMIN_DASHBOARD_TIMEZONE: 'UTC' }, now: () => fixedNow });
  const snapshot = await analytics.getDashboardSnapshot({ range: 'today', restaurant_id: '4' });
  assert.deepEqual(snapshot.restaurants.map(row => row.id), [4]);
  assert.deepEqual(snapshot.latest_orders.map(row => row.restaurante_id), [4]);
  assert.ok(pool.calls.every(call => restaurantParameter(call.sql, call.params) === 4));
});

test('GET /admin/api/dashboard usa parámetros PostgreSQL contiguos para todos los rangos y el detalle', async () => {
  const pool = createAnalyticsPool({ strictParameters: true });
  const analytics = createAdminAnalytics({
    pool,
    env: { ADMIN_DASHBOARD_TIMEZONE: 'America/Los_Angeles' },
    now: () => fixedNow
  });

  for (const range of ['today', 'yesterday', '7d', '30d']) {
    const snapshot = await analytics.getDashboardSnapshot({ range });
    assert.equal(snapshot.range.key, range);
  }

  const detail = await analytics.getDashboardSnapshot({ range: 'today', restaurant_id: '4' });
  assert.deepEqual(detail.restaurants.map(row => row.id), [4]);
  assert.equal(pool.calls.length, 20);
  assert.match(indexSource, /app\.get\('\/admin\/api\/dashboard'/);
});

test('cache deduplica snapshots y una nueva orden la invalida', async () => {
  const pool = createAnalyticsPool();
  const analytics = createAdminAnalytics({ pool, env: { ADMIN_DASHBOARD_TIMEZONE: 'UTC' }, now: () => fixedNow });
  await analytics.getDashboardSnapshot({ range: 'today' });
  await analytics.getDashboardSnapshot({ range: 'today' });
  assert.equal(pool.calls.length, 4);
  analytics.invalidate();
  await analytics.getDashboardSnapshot({ range: 'today' });
  assert.equal(pool.calls.length, 8);
});

test('SQL excluye failed/cancelled y agrupa y une siempre con restaurante_id', () => {
  assert.match(analyticsSource, /IN \('processing', 'completed'\)/);
  assert.doesNotMatch(analyticsSource, /IN \([^)]*'failed'/);
  assert.doesNotMatch(analyticsSource, /IN \([^)]*'cancelled'/);
  assert.match(analyticsSource, /GROUP BY p\.restaurante_id/);
  assert.match(analyticsSource, /d\.restaurante_id = p\.restaurante_id/);
  assert.match(analyticsSource, /d\.order_number::text = p\.woo_order_id::text/);
});

test('usuario restaurante recibe 403 y admin supera requireAdmin', () => {
  const context = createRestaurantContext({ pool: { query: async () => ({ rows: [] }) } });
  const response = () => ({
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  });
  const denied = response();
  context.requireAdmin({ session: { user_id: 2, rol: 'cliente' } }, denied, () => assert.fail('No debe autorizar'));
  assert.equal(denied.statusCode, 403);
  let authorized = false;
  context.requireAdmin({ session: { user_id: 1, rol: 'admin' } }, response(), () => { authorized = true; });
  assert.equal(authorized, true);
  assert.match(indexSource, /app\.use\('\/admin', requireAdmin\)/);
  assert.match(indexSource, /app\.get\('\/admin\/api\/dashboard'/);
  assert.match(indexSource, /app\.get\('\/admin\/events'/);
});

test('SSE publica order_created al admin sin ningún secreto', () => {
  const event = sanitizeAdminEvent('order_created', {
    restaurante_id: 5,
    consumer_key: 'forbidden',
    webhook_token: 'forbidden',
    order: { woo_order_id: 91, total: 28.4, estado: 'processing', order_type: 'pickup', consumer_secret: 'forbidden' }
  });
  const serialized = JSON.stringify(event);
  assert.equal(event.type, 'order_created');
  for (const forbidden of ['consumer_key', 'consumer_secret', 'webhook_token', 'shipday', 'stripe', 'vapid']) {
    assert.doesNotMatch(serialized.toLowerCase(), new RegExp(forbidden));
  }

  const request = new EventEmitter();
  const response = new EventEmitter();
  response.output = '';
  response.status = () => response;
  response.set = () => response;
  response.write = chunk => { response.output += chunk; };
  response.end = () => { response.writableEnded = true; };
  const hub = createAdminEventHub({ heartbeatMs: 60000 });
  hub.subscribe(request, response);
  hub.publish('order_created', { restaurante_id: 5, order: { woo_order_id: 91, total: 28.4, estado: 'processing', order_type: 'pickup' } });
  assert.match(response.output, /event: order_created/);
  assert.match(response.output, /"restaurante_id":5/);
  request.emit('close');
  assert.equal(hub.getClientCount(), 0);
});

function subscribeTestClient(hub) {
  const request = new EventEmitter();
  const response = new EventEmitter();
  response.output = '';
  response.failWrites = false;
  response.status = () => response;
  response.set = () => response;
  response.write = chunk => {
    if (response.failWrites) throw new Error('socket roto');
    response.output += chunk;
  };
  response.end = () => { response.writableEnded = true; };
  hub.subscribe(request, response);
  return { request, response };
}

const bestEffortOperationalCases = [
  ['webhook Woo', 'order_created', { restaurante_id: 1, order: { woo_order_id: 10, total: 20, estado: 'processing', order_type: 'pickup' } }],
  ['refund', 'refund_updated', { restaurante_id: 1, woo_order_id: 10, refund_amount: 5 }],
  ['complete-order', 'order_updated', { restaurante_id: 1, order: { woo_order_id: 10, total: 20, estado: 'completed', order_type: 'pickup' } }],
  ['toggle-restaurante', 'restaurant_status_changed', { restaurante_id: 1, abierto: true }],
  ['Shipday', 'delivery_updated', { restaurante_id: 1, order_number: 10, status: 'assigned', driver_name: 'Driver' }]
];

for (const [flow, type, payload] of bestEffortOperationalCases) {
  test(`fallo response.write no rompe ${flow}`, () => {
    const hub = createAdminEventHub({ heartbeatMs: 60000 });
    const broken = subscribeTestClient(hub);
    broken.response.failWrites = true;
    let invalidations = 0;
    const publishAdminEvent = createBestEffortAdminPublisher({
      analytics: { invalidate() { invalidations += 1; } },
      events: hub,
      logger: { warn() {} }
    });

    assert.doesNotThrow(() => publishAdminEvent(type, payload));
    assert.equal(invalidations, 1);
    assert.equal(hub.getClientCount(), 0);
  });
}

test('cliente SSE roto se elimina y los demás clientes siguen recibiendo eventos', () => {
  const hub = createAdminEventHub({ heartbeatMs: 60000 });
  const broken = subscribeTestClient(hub);
  const healthy = subscribeTestClient(hub);
  broken.response.failWrites = true;

  assert.doesNotThrow(() => hub.publish('order_created', {
    restaurante_id: 4,
    order: { woo_order_id: 22, total: 30, estado: 'processing', order_type: 'delivery' }
  }));
  assert.equal(hub.getClientCount(), 1);
  assert.match(healthy.response.output, /event: order_created/);
  assert.match(healthy.response.output, /"restaurante_id":4/);

  healthy.request.emit('close');
  assert.equal(hub.getClientCount(), 0);
});

test('publisher best-effort tampoco propaga fallos de invalidación o logging', () => {
  const publishAdminEvent = createBestEffortAdminPublisher({
    analytics: { invalidate() { throw new Error('cache unavailable'); } },
    events: { publish() { throw new Error('no debe alcanzarse'); } },
    logger: { warn() { throw new Error('logger unavailable'); } }
  });
  assert.doesNotThrow(() => publishAdminEvent('order_created', { restaurante_id: 1 }));
  assert.equal(publishAdminEvent('order_created', { restaurante_id: 1 }), null);
  assert.match(indexSource, /const publishAdminEvent = createBestEffortAdminPublisher/);
});

test('fallo de analytics queda encapsulado en su servicio y rutas normales siguen presentes', async () => {
  const analytics = createAdminAnalytics({ pool: { query: async () => { throw new Error('analytics unavailable'); } }, now: () => fixedNow });
  await assert.rejects(analytics.getDashboardSnapshot({ range: 'today' }), /analytics unavailable/);
  assert.match(indexSource, /app\.get\('\/orders-complete', requireSessionRestaurant/);
  assert.match(indexSource, /app\.get\('\/orders-latest', requireSessionRestaurant/);
  assert.match(indexSource, /ADMIN_ANALYTICS_QUERY_FAILED/);
});
