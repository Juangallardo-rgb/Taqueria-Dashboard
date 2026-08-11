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
const { sanitizeAdminEvent, createAdminEventHub } = require('../lib/admin-events');
const { createRestaurantContext } = require('../lib/restaurant-context');

const root = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const analyticsSource = fs.readFileSync(path.join(root, 'lib', 'admin-analytics.js'), 'utf8');

const fixedNow = new Date('2026-08-11T15:30:00.000Z');

function createAnalyticsPool() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('admin-analytics:overview')) {
        return { rows: [{
          gross_sales: '300.00', refunds_amount: '20.00', orders: 3,
          pickup_orders: 1, delivery_orders: 2, refunds_count: 1,
          previous_gross_sales: '200.00', previous_refunds_amount: '0',
          total_restaurants: params[3] ? 1 : 3,
          open_restaurants: params[3] ? 1 : 2,
          closed_restaurants: params[3] ? 0 : 1
        }] };
      }
      if (sql.includes('admin-analytics:restaurants')) {
        const rows = [
          { id: 1, nombre: 'Uno', abierto: true, activo: true, gross_sales: '120', refunds_amount: '20', orders: 1, refunds_count: 1, pickup_orders: 1, delivery_orders: 0, last_order_at: fixedNow, last_woo_order_id: '77' },
          { id: 4, nombre: 'Cuatro', abierto: true, activo: true, gross_sales: '110', refunds_amount: '0', orders: 1, refunds_count: 0, pickup_orders: 0, delivery_orders: 1, last_order_at: fixedNow, last_woo_order_id: '77' },
          { id: 5, nombre: 'Cinco', abierto: false, activo: true, gross_sales: '70', refunds_amount: '0', orders: 1, refunds_count: 0, pickup_orders: 0, delivery_orders: 1, last_order_at: fixedNow, last_woo_order_id: '88' }
        ];
        return { rows: params[3] ? rows.filter(row => row.id === params[3]) : rows };
      }
      if (sql.includes('admin-analytics:latest-orders')) {
        const rows = [
          { id: 101, restaurante_id: 1, restaurante_nombre: 'Uno', woo_order_id: '77', customer_name: 'A', total: '120', estado: 'processing', refunded: true, refund_amount: '20', created_at: fixedNow, order_type: 'pickup' },
          { id: 202, restaurante_id: 4, restaurante_nombre: 'Cuatro', woo_order_id: '77', customer_name: 'B', total: '110', estado: 'completed', refunded: false, created_at: fixedNow, order_type: 'delivery' },
          { id: 303, restaurante_id: 5, restaurante_nombre: 'Cinco', woo_order_id: '88', customer_name: 'C', total: '70', estado: 'processing', refunded: false, created_at: fixedNow, order_type: 'delivery' }
        ];
        return { rows: params[3] ? rows.filter(row => row.restaurante_id === params[3]) : rows };
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
  assert.ok(pool.calls.every(call => call.params[3] === 4));
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

test('fallo de analytics queda encapsulado en su servicio y rutas normales siguen presentes', async () => {
  const analytics = createAdminAnalytics({ pool: { query: async () => { throw new Error('analytics unavailable'); } }, now: () => fixedNow });
  await assert.rejects(analytics.getDashboardSnapshot({ range: 'today' }), /analytics unavailable/);
  assert.match(indexSource, /app\.get\('\/orders-complete', requireSessionRestaurant/);
  assert.match(indexSource, /app\.get\('\/orders-latest', requireSessionRestaurant/);
  assert.match(indexSource, /ADMIN_ANALYTICS_QUERY_FAILED/);
});
