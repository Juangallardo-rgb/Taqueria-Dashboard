const { toPositiveInteger } = require('./restaurant-context');

const ADMIN_ANALYTICS_CACHE_TTL_MS = 5000;
const VALID_ANALYTICS_STATUSES = Object.freeze(['processing', 'completed']);
const VALID_RANGES = new Set(['today', 'yesterday', '7d', '30d', 'custom']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

class AdminAnalyticsError extends Error {
  constructor(message, statusCode = 400, code = 'ADMIN_ANALYTICS_ERROR') {
    super(message);
    this.name = 'AdminAnalyticsError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function resolveTimezone(value) {
  const timezone = String(value || '').trim() || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return 'UTC';
  }
}

function getZonedParts(date, timezone, includeTime = false) {
  const options = {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  };
  if (includeTime) {
    options.hour = '2-digit';
    options.minute = '2-digit';
    options.second = '2-digit';
    options.hourCycle = 'h23';
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', options)
      .formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)])
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: includeTime ? parts.hour : 0,
    minute: includeTime ? parts.minute : 0,
    second: includeTime ? parts.second : 0
  };
}

function addCalendarDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

function datePartsToText(parts) {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function parseDateText(value, label) {
  const text = String(value || '').trim();
  if (!DATE_PATTERN.test(text)) {
    throw new AdminAnalyticsError(`${label} debe usar el formato YYYY-MM-DD`, 400, 'ADMIN_RANGE_INVALID');
  }
  const [year, month, day] = text.split('-').map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() + 1 !== month ||
    candidate.getUTCDate() !== day
  ) {
    throw new AdminAnalyticsError(`${label} no es una fecha válida`, 400, 'ADMIN_RANGE_INVALID');
  }
  return { year, month, day };
}

function zonedMidnight(parts, timezone) {
  const desiredUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
  let instant = desiredUtc;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const actual = getZonedParts(new Date(instant), timezone, true);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    );
    const correction = desiredUtc - actualAsUtc;
    instant += correction;
    if (correction === 0) break;
  }
  return new Date(instant);
}

function normalizeDashboardRange(query = {}, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const timezone = resolveTimezone(options.timezone);
  const requestedRange = String(query.range || '').trim().toLowerCase();
  const range = query.start || query.end
    ? 'custom'
    : (VALID_RANGES.has(requestedRange) ? requestedRange : 'today');
  const today = getZonedParts(now, timezone);
  let startParts;
  let endParts;

  if (range === 'custom') {
    if (!query.start || !query.end) {
      throw new AdminAnalyticsError('El rango personalizado requiere fecha inicial y final', 400, 'ADMIN_RANGE_INVALID');
    }
    startParts = parseDateText(query.start, 'La fecha inicial');
    const inclusiveEnd = parseDateText(query.end, 'La fecha final');
    endParts = addCalendarDays(inclusiveEnd, 1);
    const days = Math.round((Date.UTC(endParts.year, endParts.month - 1, endParts.day) - Date.UTC(startParts.year, startParts.month - 1, startParts.day)) / 86400000);
    if (days <= 0 || days > 366) {
      throw new AdminAnalyticsError('El rango debe abarcar entre 1 y 366 días', 400, 'ADMIN_RANGE_INVALID');
    }
  } else if (range === 'yesterday') {
    startParts = addCalendarDays(today, -1);
    endParts = today;
  } else if (range === '7d') {
    startParts = addCalendarDays(today, -6);
    endParts = addCalendarDays(today, 1);
  } else if (range === '30d') {
    startParts = addCalendarDays(today, -29);
    endParts = addCalendarDays(today, 1);
  } else {
    startParts = today;
    endParts = addCalendarDays(today, 1);
  }

  const startAt = zonedMidnight(startParts, timezone);
  const endAt = zonedMidnight(endParts, timezone);
  const durationMs = endAt.getTime() - startAt.getTime();
  const previousEndAt = startAt;
  const previousStartAt = new Date(startAt.getTime() - durationMs);
  const inclusiveEndParts = addCalendarDays(endParts, -1);

  return {
    key: range,
    start: datePartsToText(startParts),
    end: datePartsToText(inclusiveEndParts),
    start_at: startAt.toISOString(),
    end_at: endAt.toISOString(),
    previous_start_at: previousStartAt.toISOString(),
    previous_end_at: previousEndAt.toISOString(),
    timezone,
    granularity: durationMs <= 26 * 3600000 ? 'hour' : 'day'
  };
}

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value) {
  return Math.round((numberValue(value) + Number.EPSILON) * 100) / 100;
}

function normalizeOverview(row = {}) {
  const grossSales = roundMoney(row.gross_sales);
  const refundsAmount = roundMoney(row.refunds_amount);
  const netSales = roundMoney(grossSales - refundsAmount);
  const orders = Number(row.orders || 0);
  const previousNet = roundMoney(numberValue(row.previous_gross_sales) - numberValue(row.previous_refunds_amount));
  const comparison = previousNet > 0
    ? Math.round(((netSales - previousNet) / previousNet) * 1000) / 10
    : null;
  return {
    gross_sales: grossSales,
    refunds_amount: refundsAmount,
    net_sales: netSales,
    orders,
    average_ticket: orders > 0 ? roundMoney(netSales / orders) : 0,
    pickup_orders: Number(row.pickup_orders || 0),
    delivery_orders: Number(row.delivery_orders || 0),
    refunds_count: Number(row.refunds_count || 0),
    total_restaurants: Number(row.total_restaurants || 0),
    open_restaurants: Number(row.open_restaurants || 0),
    closed_restaurants: Number(row.closed_restaurants || 0),
    previous_net_sales: previousNet,
    net_sales_change_percent: comparison
  };
}

function normalizeRestaurant(row = {}) {
  const grossSales = roundMoney(row.gross_sales);
  const refundsAmount = roundMoney(row.refunds_amount);
  const netSales = roundMoney(grossSales - refundsAmount);
  const orders = Number(row.orders || 0);
  return {
    id: Number(row.id),
    nombre: row.nombre || '',
    logo_url: row.logo_url || null,
    abierto: Boolean(row.abierto),
    activo: row.activo !== false,
    gross_sales: grossSales,
    refunds_amount: refundsAmount,
    net_sales: netSales,
    orders,
    average_ticket: orders > 0 ? roundMoney(netSales / orders) : 0,
    pickup_orders: Number(row.pickup_orders || 0),
    delivery_orders: Number(row.delivery_orders || 0),
    refunds_count: Number(row.refunds_count || 0),
    last_order_at: row.last_order_at || null,
    last_woo_order_id: row.last_woo_order_id || null
  };
}

function fillTimeline(rows, range) {
  const byBucket = new Map(rows.map(row => [String(row.bucket || '').slice(0, range.granularity === 'hour' ? 13 : 10), row]));
  const filled = [];
  if (range.granularity === 'hour') {
    for (let hour = 0; hour < 24; hour += 1) {
      const key = `${range.start} ${String(hour).padStart(2, '0')}`;
      filled.push(byBucket.get(key) || {
        bucket: `${key}:00:00`,
        gross_sales: 0,
        refunds_amount: 0,
        net_sales: 0,
        orders: 0
      });
    }
    return filled;
  }

  const start = parseDateText(range.start, 'La fecha inicial');
  const end = parseDateText(range.end, 'La fecha final');
  const totalDays = Math.round((Date.UTC(end.year, end.month - 1, end.day) - Date.UTC(start.year, start.month - 1, start.day)) / 86400000) + 1;
  for (let offset = 0; offset < totalDays; offset += 1) {
    const key = datePartsToText(addCalendarDays(start, offset));
    filled.push(byBucket.get(key) || {
      bucket: `${key} 00:00:00`,
      gross_sales: 0,
      refunds_amount: 0,
      net_sales: 0,
      orders: 0
    });
  }
  return filled;
}

function createAdminAnalytics({ pool, env = process.env, now = () => new Date(), cacheTtlMs = ADMIN_ANALYTICS_CACHE_TTL_MS }) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('Se requiere un pool PostgreSQL válido para analytics');
  }

  const timezone = resolveTimezone(env.ADMIN_DASHBOARD_TIMEZONE);
  const timezoneSource = String(env.ADMIN_DASHBOARD_TIMEZONE || '').trim() ? 'environment' : 'default_utc';
  const cache = new Map();
  let revision = 0;

  function invalidate() {
    revision += 1;
    cache.clear();
  }

  function cacheKey(range, restaurantId) {
    return [range.start_at, range.end_at, range.timezone, restaurantId || 'all'].join('|');
  }

  async function querySnapshot(range, restaurantId) {
    const params = [
      range.start_at,
      range.end_at,
      range.previous_start_at,
      restaurantId || null,
      range.timezone
    ];

    const overviewSql = `
      /* admin-analytics:overview */
      WITH scoped_orders AS (
        SELECT
          p.restaurante_id,
          COALESCE(p.total::numeric, 0) AS total,
          COALESCE(p.refunded, false) AS refunded,
          COALESCE(p.refund_amount::numeric, 0) AS refund_amount,
          p.created_at,
          CASE
            WHEN EXISTS (
              SELECT 1 FROM deliveries d
              WHERE d.restaurante_id = p.restaurante_id
                AND d.order_number::text = p.woo_order_id::text
            ) OR LOWER(TRIM(COALESCE(p.tipo_pedido, ''))) = 'delivery'
            THEN 'delivery'
            ELSE 'pickup'
          END AS order_type
        FROM pedidos p
        WHERE p.created_at >= $3::timestamptz
          AND p.created_at < $2::timestamptz
          AND LOWER(TRIM(COALESCE(p.estado, ''))) IN ('processing', 'completed')
          AND ($4::integer IS NULL OR p.restaurante_id = $4::integer)
      )
      SELECT
        COALESCE(SUM(total) FILTER (WHERE created_at >= $1::timestamptz), 0) AS gross_sales,
        COALESCE(SUM(refund_amount) FILTER (WHERE created_at >= $1::timestamptz AND refunded), 0) AS refunds_amount,
        COUNT(*) FILTER (WHERE created_at >= $1::timestamptz)::integer AS orders,
        COUNT(*) FILTER (WHERE created_at >= $1::timestamptz AND order_type = 'pickup')::integer AS pickup_orders,
        COUNT(*) FILTER (WHERE created_at >= $1::timestamptz AND order_type = 'delivery')::integer AS delivery_orders,
        COUNT(*) FILTER (WHERE created_at >= $1::timestamptz AND refunded)::integer AS refunds_count,
        COALESCE(SUM(total) FILTER (WHERE created_at < $1::timestamptz), 0) AS previous_gross_sales,
        COALESCE(SUM(refund_amount) FILTER (WHERE created_at < $1::timestamptz AND refunded), 0) AS previous_refunds_amount,
        (SELECT COUNT(*)::integer FROM restaurantes r WHERE r.activo IS NOT FALSE AND ($4::integer IS NULL OR r.id = $4::integer)) AS total_restaurants,
        (SELECT COUNT(*)::integer FROM restaurantes r WHERE r.activo IS NOT FALSE AND r.abierto IS TRUE AND ($4::integer IS NULL OR r.id = $4::integer)) AS open_restaurants,
        (SELECT COUNT(*)::integer FROM restaurantes r WHERE r.activo IS NOT FALSE AND r.abierto IS NOT TRUE AND ($4::integer IS NULL OR r.id = $4::integer)) AS closed_restaurants
      FROM scoped_orders`;

    const restaurantsSql = `
      /* admin-analytics:restaurants */
      WITH order_metrics AS (
        SELECT
          p.restaurante_id,
          COALESCE(SUM(p.total::numeric), 0) AS gross_sales,
          COALESCE(SUM(CASE WHEN COALESCE(p.refunded, false) THEN COALESCE(p.refund_amount::numeric, 0) ELSE 0 END), 0) AS refunds_amount,
          COUNT(*)::integer AS orders,
          COUNT(*) FILTER (WHERE COALESCE(p.refunded, false))::integer AS refunds_count,
          COUNT(*) FILTER (WHERE
            NOT EXISTS (
              SELECT 1 FROM deliveries d
              WHERE d.restaurante_id = p.restaurante_id
                AND d.order_number::text = p.woo_order_id::text
            ) AND LOWER(TRIM(COALESCE(p.tipo_pedido, ''))) <> 'delivery'
          )::integer AS pickup_orders,
          COUNT(*) FILTER (WHERE
            EXISTS (
              SELECT 1 FROM deliveries d
              WHERE d.restaurante_id = p.restaurante_id
                AND d.order_number::text = p.woo_order_id::text
            ) OR LOWER(TRIM(COALESCE(p.tipo_pedido, ''))) = 'delivery'
          )::integer AS delivery_orders,
          MAX(p.created_at) AS last_order_at
        FROM pedidos p
        WHERE p.created_at >= $1::timestamptz
          AND p.created_at < $2::timestamptz
          AND LOWER(TRIM(COALESCE(p.estado, ''))) IN ('processing', 'completed')
          AND ($4::integer IS NULL OR p.restaurante_id = $4::integer)
        GROUP BY p.restaurante_id
      ), latest_ids AS (
        SELECT DISTINCT ON (p.restaurante_id)
          p.restaurante_id,
          p.woo_order_id
        FROM pedidos p
        WHERE p.created_at >= $1::timestamptz
          AND p.created_at < $2::timestamptz
          AND LOWER(TRIM(COALESCE(p.estado, ''))) IN ('processing', 'completed')
          AND ($4::integer IS NULL OR p.restaurante_id = $4::integer)
        ORDER BY p.restaurante_id, p.created_at DESC, p.id DESC
      )
      SELECT
        r.id,
        r.nombre,
        r.logo_url,
        r.abierto,
        r.activo,
        COALESCE(m.gross_sales, 0) AS gross_sales,
        COALESCE(m.refunds_amount, 0) AS refunds_amount,
        COALESCE(m.orders, 0)::integer AS orders,
        COALESCE(m.refunds_count, 0)::integer AS refunds_count,
        COALESCE(m.pickup_orders, 0)::integer AS pickup_orders,
        COALESCE(m.delivery_orders, 0)::integer AS delivery_orders,
        m.last_order_at,
        l.woo_order_id AS last_woo_order_id
      FROM restaurantes r
      LEFT JOIN order_metrics m ON m.restaurante_id = r.id
      LEFT JOIN latest_ids l ON l.restaurante_id = r.id
      WHERE ($4::integer IS NULL OR r.id = $4::integer)
      ORDER BY (COALESCE(m.gross_sales, 0) - COALESCE(m.refunds_amount, 0)) DESC, r.nombre ASC`;

    const latestOrdersSql = `
      /* admin-analytics:latest-orders */
      SELECT
        p.id,
        p.restaurante_id,
        r.nombre AS restaurante_nombre,
        r.logo_url AS restaurante_logo_url,
        p.woo_order_id,
        p.customer_name,
        p.total,
        p.estado,
        p.refunded,
        p.refund_amount,
        p.created_at,
        CASE
          WHEN d.order_number IS NOT NULL OR LOWER(TRIM(COALESCE(p.tipo_pedido, ''))) = 'delivery' THEN 'delivery'
          ELSE 'pickup'
        END AS order_type,
        d.driver_name,
        d.status AS delivery_status,
        d.tracking_url
      FROM pedidos p
      JOIN restaurantes r ON r.id = p.restaurante_id
      LEFT JOIN LATERAL (
        SELECT driver_name, status, tracking_url, order_number
        FROM deliveries d0
        WHERE d0.restaurante_id = p.restaurante_id
          AND d0.order_number::text = p.woo_order_id::text
        ORDER BY d0.updated_at DESC NULLS LAST, d0.created_at DESC NULLS LAST
        LIMIT 1
      ) d ON TRUE
      WHERE p.created_at >= $1::timestamptz
        AND p.created_at < $2::timestamptz
        AND LOWER(TRIM(COALESCE(p.estado, ''))) IN ('processing', 'completed')
        AND ($4::integer IS NULL OR p.restaurante_id = $4::integer)
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT 25`;

    const granularity = range.granularity === 'hour' ? 'hour' : 'day';
    const timelineSql = `
      /* admin-analytics:timeline */
      SELECT
        date_trunc('${granularity}', p.created_at AT TIME ZONE $5) ::text AS bucket,
        COALESCE(SUM(p.total::numeric), 0) AS gross_sales,
        COALESCE(SUM(CASE WHEN COALESCE(p.refunded, false) THEN COALESCE(p.refund_amount::numeric, 0) ELSE 0 END), 0) AS refunds_amount,
        COUNT(*)::integer AS orders
      FROM pedidos p
      WHERE p.created_at >= $1::timestamptz
        AND p.created_at < $2::timestamptz
        AND LOWER(TRIM(COALESCE(p.estado, ''))) IN ('processing', 'completed')
        AND ($4::integer IS NULL OR p.restaurante_id = $4::integer)
      GROUP BY date_trunc('${granularity}', p.created_at AT TIME ZONE $5)
      ORDER BY date_trunc('${granularity}', p.created_at AT TIME ZONE $5)`;

    const [overviewResult, restaurantsResult, latestOrdersResult, timelineResult] = await Promise.all([
      pool.query(overviewSql, params.slice(0, 4)),
      pool.query(restaurantsSql, params.slice(0, 4)),
      pool.query(latestOrdersSql, params.slice(0, 4)),
      pool.query(timelineSql, params)
    ]);

    const restaurants = restaurantsResult.rows.map(normalizeRestaurant);
    const latestOrders = latestOrdersResult.rows.map(order => ({
      id: Number(order.id),
      restaurante_id: Number(order.restaurante_id),
      restaurante_nombre: order.restaurante_nombre || '',
      restaurante_logo_url: order.restaurante_logo_url || null,
      woo_order_id: order.woo_order_id,
      customer_name: order.customer_name || 'Cliente',
      total: roundMoney(order.total),
      estado: String(order.estado || '').trim().toLowerCase(),
      refunded: Boolean(order.refunded),
      refund_amount: roundMoney(order.refund_amount),
      created_at: order.created_at,
      order_type: order.order_type === 'pickup' ? 'pickup' : 'delivery',
      driver_name: order.driver_name || null,
      delivery_status: order.delivery_status || null,
      tracking_url: order.tracking_url || null
    }));
    const timeline = fillTimeline(timelineResult.rows.map(bucket => ({
      bucket: bucket.bucket,
      gross_sales: roundMoney(bucket.gross_sales),
      refunds_amount: roundMoney(bucket.refunds_amount),
      net_sales: roundMoney(numberValue(bucket.gross_sales) - numberValue(bucket.refunds_amount)),
      orders: Number(bucket.orders || 0)
    })), range);

    return {
      generated_at: now().toISOString(),
      range,
      timezone: {
        name: timezone,
        source: timezoneSource,
        restaurant_timezones_available: false
      },
      overview: normalizeOverview(overviewResult.rows[0]),
      restaurants,
      latest_orders: latestOrders,
      charts: {
        granularity,
        timeline,
        restaurant_sales: restaurants.slice(0, 8).map(restaurant => ({
          restaurante_id: restaurant.id,
          nombre: restaurant.nombre,
          net_sales: restaurant.net_sales
        })),
        order_types: {
          pickup: Number(overviewResult.rows[0]?.pickup_orders || 0),
          delivery: Number(overviewResult.rows[0]?.delivery_orders || 0)
        }
      }
    };
  }

  async function getDashboardSnapshot(query = {}) {
    const restaurantId = query.restaurant_id === undefined || query.restaurant_id === ''
      ? null
      : toPositiveInteger(query.restaurant_id);
    if ((query.restaurant_id !== undefined && query.restaurant_id !== '') && !restaurantId) {
      throw new AdminAnalyticsError('Restaurante inválido', 400, 'ADMIN_RESTAURANT_INVALID');
    }
    const range = normalizeDashboardRange(query, { now: now(), timezone });
    const key = cacheKey(range, restaurantId);
    const current = cache.get(key);
    const timestamp = Date.now();
    if (current?.data && timestamp - current.created_at < cacheTtlMs) {
      return current.data;
    }
    if (current?.promise) return current.promise;

    const queryRevision = revision;
    const promise = querySnapshot(range, restaurantId);
    cache.set(key, { data: current?.data || null, created_at: current?.created_at || 0, promise });
    try {
      const data = await promise;
      if (queryRevision === revision) {
        cache.set(key, { data, created_at: Date.now(), promise: null });
      }
      return data;
    } catch (error) {
      cache.delete(key);
      throw error;
    }
  }

  return {
    getDashboardSnapshot,
    invalidate,
    getCacheSize: () => cache.size,
    timezone,
    timezoneSource
  };
}

module.exports = {
  ADMIN_ANALYTICS_CACHE_TTL_MS,
  VALID_ANALYTICS_STATUSES,
  AdminAnalyticsError,
  resolveTimezone,
  normalizeDashboardRange,
  normalizeOverview,
  normalizeRestaurant,
  fillTimeline,
  createAdminAnalytics
};
