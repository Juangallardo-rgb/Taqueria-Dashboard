const { normalizeWooOrder, shouldAcceptWooOrder } = require('./order-utils');

const DEFAULT_RETRY_DELAYS_MS = [5000, 30000, 120000, 300000];
const DEFAULT_RECOVERY_INTERVAL_MS = 300000;
const DEFAULT_RECOVERY_LIMIT = 50;
const VALID_ORDER_TYPES = new Set(['pickup', 'delivery']);

function parseItems(items) {
  if (Array.isArray(items)) return items;
  if (typeof items !== 'string' || !items.trim()) return [];

  try {
    const parsed = JSON.parse(items);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function isOrderCommerciallyComplete(order) {
  return Boolean(
    order &&
    Number.isInteger(Number(order.restaurante_id)) &&
    Number(order.restaurante_id) > 0 &&
    String(order.woo_order_id || '').trim() &&
    parseItems(order.items).length > 0 &&
    VALID_ORDER_TYPES.has(String(order.tipo_pedido || '').trim().toLowerCase())
  );
}

function scheduleHydrationAfterResponse(
  response,
  orderIntegrity,
  restauranteId,
  wooOrderId,
  options = {}
) {
  response.once('finish', () => {
    orderIntegrity.scheduleOrderHydration(
      Number(restauranteId),
      String(wooOrderId),
      options
    );
  });
}

function createOrderRepository({ pool }) {
  return {
    async upsertWooOrder(restauranteId, normalizedOrder) {
      const result = await pool.query(
        `INSERT INTO pedidos
         (
           restaurante_id,
           total,
           estado,
           woo_order_id,
           customer_name,
           customer_phone,
           items,
           refund_items,
           tipo_pedido,
           delivery_address,
           delivery_city,
           delivery_postcode
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (restaurante_id, woo_order_id)
         DO UPDATE SET
           estado = EXCLUDED.estado,
           total = EXCLUDED.total,
           customer_name = EXCLUDED.customer_name,
           customer_phone = COALESCE(
             NULLIF(EXCLUDED.customer_phone, ''),
             pedidos.customer_phone
           ),
           items = CASE
             WHEN EXCLUDED.items IS NOT NULL
              AND jsonb_typeof(EXCLUDED.items::jsonb) = 'array'
              AND jsonb_array_length(EXCLUDED.items::jsonb) > 0
             THEN EXCLUDED.items
             ELSE pedidos.items
           END,
           refund_items = EXCLUDED.refund_items,
           tipo_pedido = CASE
             WHEN $13::boolean
              AND EXCLUDED.tipo_pedido IN ('pickup', 'delivery')
             THEN EXCLUDED.tipo_pedido
             ELSE pedidos.tipo_pedido
           END,
           delivery_address = EXCLUDED.delivery_address,
           delivery_city = EXCLUDED.delivery_city,
           delivery_postcode = EXCLUDED.delivery_postcode
         RETURNING id, created_at, (xmax = 0) AS inserted`,
        [
          restauranteId,
          normalizedOrder.total,
          normalizedOrder.estado,
          normalizedOrder.wooOrderId,
          normalizedOrder.customerName,
          normalizedOrder.customerPhone,
          JSON.stringify(normalizedOrder.items),
          JSON.stringify(normalizedOrder.refundItems),
          normalizedOrder.tipoPedido,
          normalizedOrder.deliveryAddress,
          normalizedOrder.deliveryCity,
          normalizedOrder.deliveryPostcode,
          normalizedOrder.tipoPedidoConfiable
        ]
      );

      return result.rows[0] || null;
    },

    async recordStripePayment(restauranteId, wooOrderId, stripeFields) {
      const result = await pool.query(
        `WITH updated_order AS (
           UPDATE pedidos
           SET stripe_payment_intent_id = $1,
               stripe_account_id = $2,
               denix_application_fee_cents = $3,
               payment_split_status = $4
           WHERE restaurante_id = $5
             AND woo_order_id = $6
           RETURNING
             id,
             items IS NOT NULL
               AND jsonb_typeof(items::jsonb) = 'array'
               AND jsonb_array_length(items::jsonb) > 0
               AND tipo_pedido IN ('pickup', 'delivery')
               AS commercially_complete
         ), queued_job AS (
           INSERT INTO order_hydration_jobs
           (
             restaurante_id,
             woo_order_id,
             stripe_payment_intent_id,
             stripe_account_id,
             denix_application_fee_cents,
             payment_split_status,
             status,
             attempts,
             next_attempt_at,
             last_error,
             updated_at
           )
           SELECT $5, $6, $1, $2, $3, $4, 'pending', 0, NOW(), NULL, NOW()
           WHERE $4 = 'succeeded'
             AND NOT EXISTS (
               SELECT 1
               FROM updated_order
               WHERE commercially_complete
             )
           ON CONFLICT (restaurante_id, woo_order_id)
           DO UPDATE SET
             stripe_payment_intent_id = EXCLUDED.stripe_payment_intent_id,
             stripe_account_id = EXCLUDED.stripe_account_id,
             denix_application_fee_cents = EXCLUDED.denix_application_fee_cents,
             payment_split_status = EXCLUDED.payment_split_status,
             status = 'pending',
             attempts = 0,
             next_attempt_at = NOW(),
             last_error = NULL,
             completed_at = NULL,
             updated_at = NOW()
           RETURNING id
         )
         SELECT
           EXISTS(SELECT 1 FROM updated_order) AS order_exists,
           EXISTS(SELECT 1 FROM queued_job) AS hydration_queued`,
        [
          stripeFields.stripePaymentIntentId,
          stripeFields.stripeAccountId,
          stripeFields.applicationFeeAmount,
          stripeFields.paymentStatus,
          Number(restauranteId),
          String(wooOrderId)
        ]
      );

      return result.rows[0] || { order_exists: false, hydration_queued: false };
    },

    async getHydrationState(restauranteId, wooOrderId) {
      const result = await pool.query(
        `SELECT
           j.id AS job_id,
           j.restaurante_id,
           j.woo_order_id,
           j.stripe_payment_intent_id,
           j.stripe_account_id,
           j.denix_application_fee_cents,
           j.payment_split_status,
           j.status AS job_status,
           j.attempts,
           p.id AS pedido_id,
           p.items,
           p.tipo_pedido
         FROM order_hydration_jobs j
         LEFT JOIN pedidos p
           ON p.restaurante_id = j.restaurante_id
          AND p.woo_order_id = j.woo_order_id
         WHERE j.restaurante_id = $1
           AND j.woo_order_id = $2
           AND j.status = 'pending'
         LIMIT 1`,
        [Number(restauranteId), String(wooOrderId)]
      );

      return result.rows[0] || null;
    },

    async getOrderCommercialState(restauranteId, wooOrderId) {
      const result = await pool.query(
        `SELECT restaurante_id, woo_order_id, items, tipo_pedido
         FROM pedidos
         WHERE restaurante_id = $1
           AND woo_order_id = $2
         LIMIT 1`,
        [Number(restauranteId), String(wooOrderId)]
      );

      return result.rows[0] || null;
    },

    async reconcileCompleteOrder(restauranteId, wooOrderId) {
      const result = await pool.query(
        `WITH applied AS (
           UPDATE pedidos p
           SET stripe_payment_intent_id = j.stripe_payment_intent_id,
               stripe_account_id = j.stripe_account_id,
               denix_application_fee_cents = j.denix_application_fee_cents,
               payment_split_status = j.payment_split_status
           FROM order_hydration_jobs j
           WHERE j.restaurante_id = $1
             AND j.woo_order_id = $2
             AND j.status = 'pending'
             AND p.restaurante_id = j.restaurante_id
             AND p.woo_order_id = j.woo_order_id
             AND p.items IS NOT NULL
             AND jsonb_typeof(p.items::jsonb) = 'array'
             AND jsonb_array_length(p.items::jsonb) > 0
             AND p.tipo_pedido IN ('pickup', 'delivery')
           RETURNING p.id
         )
         UPDATE order_hydration_jobs j
         SET status = 'completed',
             completed_at = NOW(),
             last_error = NULL,
             updated_at = NOW()
         WHERE j.restaurante_id = $1
           AND j.woo_order_id = $2
           AND EXISTS (SELECT 1 FROM applied)
         RETURNING j.id`,
        [Number(restauranteId), String(wooOrderId)]
      );

      return result.rows.length > 0;
    },

    async recordHydrationFailure(restauranteId, wooOrderId, error, nextAttemptAt) {
      await pool.query(
        `UPDATE order_hydration_jobs
         SET attempts = attempts + 1,
             next_attempt_at = $3,
             last_error = $4,
             updated_at = NOW()
         WHERE restaurante_id = $1
           AND woo_order_id = $2
           AND status = 'pending'`,
        [
          Number(restauranteId),
          String(wooOrderId),
          nextAttemptAt,
          String(error?.message || error || 'Error de hidratacion').slice(0, 1000)
        ]
      );
    },

    async listPendingHydrations(limit) {
      const result = await pool.query(
        `WITH complete_orders AS (
           SELECT j.restaurante_id, j.woo_order_id
           FROM order_hydration_jobs j
           JOIN pedidos p
             ON p.restaurante_id = j.restaurante_id
            AND p.woo_order_id = j.woo_order_id
           WHERE j.status = 'pending'
             AND p.items IS NOT NULL
             AND jsonb_typeof(p.items::jsonb) = 'array'
             AND jsonb_array_length(p.items::jsonb) > 0
             AND p.tipo_pedido IN ('pickup', 'delivery')
         ), applied AS (
           UPDATE pedidos p
           SET stripe_payment_intent_id = j.stripe_payment_intent_id,
               stripe_account_id = j.stripe_account_id,
               denix_application_fee_cents = j.denix_application_fee_cents,
               payment_split_status = j.payment_split_status
           FROM order_hydration_jobs j
           JOIN complete_orders c
             ON c.restaurante_id = j.restaurante_id
            AND c.woo_order_id = j.woo_order_id
           WHERE p.restaurante_id = j.restaurante_id
             AND p.woo_order_id = j.woo_order_id
           RETURNING p.restaurante_id, p.woo_order_id
         ), marked AS (
           UPDATE order_hydration_jobs j
           SET status = 'completed',
               completed_at = NOW(),
               last_error = NULL,
               updated_at = NOW()
           FROM applied a
           WHERE j.restaurante_id = a.restaurante_id
             AND j.woo_order_id = a.woo_order_id
           RETURNING j.restaurante_id, j.woo_order_id
         )
         SELECT
           j.restaurante_id,
           j.woo_order_id,
           j.stripe_payment_intent_id,
           j.stripe_account_id,
           j.denix_application_fee_cents,
           j.payment_split_status,
           j.attempts
         FROM order_hydration_jobs j
         WHERE j.status = 'pending'
           AND j.next_attempt_at <= NOW()
           AND NOT EXISTS (
             SELECT 1 FROM marked m
             WHERE m.restaurante_id = j.restaurante_id
               AND m.woo_order_id = j.woo_order_id
           )
         ORDER BY j.next_attempt_at ASC
         LIMIT $1`,
        [Number(limit)]
      );

      return result.rows;
    }
  };
}

function createOrderIntegrityService({
  pool,
  getOperationalRestaurantConfig,
  httpClient,
  invalidateOrderCache = () => {},
  logger = console,
  repository = createOrderRepository({ pool }),
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  recoveryIntervalMs = DEFAULT_RECOVERY_INTERVAL_MS,
  recoveryLimit = DEFAULT_RECOVERY_LIMIT,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
}) {
  const activeChains = new Map();
  let recoveryTimer = null;
  let recoveryRunning = false;
  let onOrderHydrated = async () => {};

  function hydrationKey(restauranteId, wooOrderId) {
    return `${Number(restauranteId)}:${String(wooOrderId)}`;
  }

  async function upsertWooOrder(restauranteId, order) {
    const normalizedOrder = normalizeWooOrder(order);
    if (!normalizedOrder.wooOrderId) {
      throw new Error('WooCommerce no devolvio un id de orden valido');
    }

    const storedOrder = await repository.upsertWooOrder(
      Number(restauranteId),
      normalizedOrder
    );
    invalidateOrderCache(restauranteId);

    return { storedOrder, normalizedOrder };
  }

  async function hydrateOrderFromWoo(restauranteId, wooOrderId, options = {}) {
    const config = options.config || await getOperationalRestaurantConfig(
      Number(restauranteId),
      { required: ['woo_url', 'consumer_key', 'consumer_secret'] }
    );
    const response = await httpClient.get(
      `${config.woo_url}/wp-json/wc/v3/orders/${encodeURIComponent(String(wooOrderId))}`,
      {
        auth: {
          username: config.consumer_key,
          password: config.consumer_secret
        },
        timeout: options.timeoutMs || 5000
      }
    );
    const order = response.data;

    if (!order || String(order.id) !== String(wooOrderId)) {
      throw new Error(`WooCommerce no devolvio la orden ${wooOrderId}`);
    }

    if (!shouldAcceptWooOrder(order)) {
      throw new Error(
        `WooCommerce aun no tiene la orden ${wooOrderId} lista para operar`
      );
    }

    const hydration = await upsertWooOrder(restauranteId, order);
    return { ...hydration, order };
  }

  async function persistStripePayment(restauranteId, wooOrderId, stripeFields) {
    return repository.recordStripePayment(restauranteId, wooOrderId, stripeFields);
  }

  function finishChain(chain) {
    if (chain.timer) clearTimeoutFn(chain.timer);
    chain.timer = null;
    const current = activeChains.get(chain.key);
    if (current === chain) activeChains.delete(chain.key);
  }

  function armChain(chain, delayMs) {
    chain.timer = setTimeoutFn(() => runHydrationChain(chain), delayMs);
    if (typeof chain.timer?.unref === 'function') chain.timer.unref();
  }

  async function runHydrationChain(chain) {
    if (chain.cancelled) {
      finishChain(chain);
      return;
    }

    chain.timer = null;
    chain.running = true;

    try {
      const state = chain.preloadedState || await repository.getHydrationState(
        chain.restauranteId,
        chain.wooOrderId
      );
      chain.preloadedState = null;

      if (!state) {
        finishChain(chain);
        return;
      }

      if (isOrderCommerciallyComplete(state)) {
        await repository.reconcileCompleteOrder(chain.restauranteId, chain.wooOrderId);
        finishChain(chain);
        return;
      }

      const hydration = await hydrateOrderFromWoo(
        chain.restauranteId,
        chain.wooOrderId
      );
      const reconciled = await repository.reconcileCompleteOrder(
        chain.restauranteId,
        chain.wooOrderId
      );
      if (!reconciled) {
        throw new Error('WooCommerce devolvio una orden comercial incompleta');
      }

      if (!chain.cancelled) {
        await onOrderHydrated({
          restauranteId: chain.restauranteId,
          wooOrderId: chain.wooOrderId,
          ...hydration
        });
      }

      finishChain(chain);
    } catch (error) {
      chain.attempt += 1;
      const hasRetry = chain.attempt <= retryDelaysMs.length;
      const delayMs = hasRetry
        ? retryDelaysMs[chain.attempt - 1]
        : recoveryIntervalMs;
      const nextAttemptAt = new Date(Date.now() + delayMs);

      logger.error('ORDER_HYDRATION_ATTEMPT_FAILED', {
        restauranteId: chain.restauranteId,
        wooOrderId: chain.wooOrderId,
        attempt: chain.attempt,
        message: error.message
      });
      await repository.recordHydrationFailure(
        chain.restauranteId,
        chain.wooOrderId,
        error,
        nextAttemptAt
      );

      if (!chain.cancelled && hasRetry) {
        armChain(chain, delayMs);
      } else {
        finishChain(chain);
      }
    } finally {
      chain.running = false;
    }
  }

  function scheduleOrderHydration(restauranteId, wooOrderId, options = {}) {
    const key = hydrationKey(restauranteId, wooOrderId);
    if (activeChains.has(key)) return false;

    const chain = {
      key,
      restauranteId: Number(restauranteId),
      wooOrderId: String(wooOrderId),
      attempt: 0,
      timer: null,
      running: false,
      cancelled: false,
      preloadedState: options.preloadedState || null
    };
    activeChains.set(key, chain);
    armChain(chain, options.delayMs || 0);
    return true;
  }

  function cancelScheduledHydration(restauranteId, wooOrderId) {
    const key = hydrationKey(restauranteId, wooOrderId);
    const chain = activeChains.get(key);
    if (!chain) return false;

    chain.cancelled = true;
    if (!chain.running) finishChain(chain);
    return true;
  }

  async function markOrderHydratedByExternalFlow(restauranteId, wooOrderId) {
    const reconciled = await repository.reconcileCompleteOrder(
      restauranteId,
      wooOrderId
    );
    if (reconciled) cancelScheduledHydration(restauranteId, wooOrderId);
    return reconciled;
  }

  async function orderNeedsHydration(restauranteId, wooOrderId) {
    const state = await repository.getOrderCommercialState(
      restauranteId,
      wooOrderId
    );
    return !isOrderCommerciallyComplete(state);
  }

  async function recoverPendingHydrations() {
    if (recoveryRunning) return 0;
    recoveryRunning = true;

    try {
      const pendingJobs = await repository.listPendingHydrations(recoveryLimit);
      for (const job of pendingJobs) {
        scheduleOrderHydration(job.restaurante_id, job.woo_order_id, {
          preloadedState: job
        });
      }
      return pendingJobs.length;
    } catch (error) {
      logger.error('ORDER_HYDRATION_RECOVERY_FAILED', { message: error.message });
      return 0;
    } finally {
      recoveryRunning = false;
    }
  }

  function startRecoveryLoop() {
    if (recoveryTimer) return recoveryTimer;
    void recoverPendingHydrations();
    recoveryTimer = setIntervalFn(
      () => void recoverPendingHydrations(),
      recoveryIntervalMs
    );
    if (typeof recoveryTimer?.unref === 'function') recoveryTimer.unref();
    return recoveryTimer;
  }

  function stopRecoveryLoop() {
    if (!recoveryTimer) return;
    clearIntervalFn(recoveryTimer);
    recoveryTimer = null;
  }

  function setOrderHydratedHandler(handler) {
    onOrderHydrated = typeof handler === 'function' ? handler : async () => {};
  }

  return {
    upsertWooOrder,
    hydrateOrderFromWoo,
    persistStripePayment,
    scheduleOrderHydration,
    cancelScheduledHydration,
    markOrderHydratedByExternalFlow,
    orderNeedsHydration,
    recoverPendingHydrations,
    startRecoveryLoop,
    stopRecoveryLoop,
    setOrderHydratedHandler,
    activeChains
  };
}

module.exports = {
  DEFAULT_RETRY_DELAYS_MS,
  DEFAULT_RECOVERY_INTERVAL_MS,
  DEFAULT_RECOVERY_LIMIT,
  isOrderCommerciallyComplete,
  scheduleHydrationAfterResponse,
  createOrderRepository,
  createOrderIntegrityService
};
