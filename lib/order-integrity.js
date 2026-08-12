const { normalizeWooOrder, shouldAcceptWooOrder } = require('./order-utils');

const DEFAULT_RETRY_DELAYS_MS = [5000, 30000, 120000, 300000];

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

    async updateStripeFields(restauranteId, wooOrderId, stripeFields) {
      const result = await pool.query(
        `UPDATE pedidos
         SET stripe_payment_intent_id = $1,
             stripe_account_id = $2,
             denix_application_fee_cents = $3,
             payment_split_status = $4
         WHERE restaurante_id = $5
           AND woo_order_id = $6
         RETURNING id`,
        [
          stripeFields.stripePaymentIntentId,
          stripeFields.stripeAccountId,
          stripeFields.applicationFeeAmount,
          stripeFields.paymentStatus,
          restauranteId,
          String(wooOrderId)
        ]
      );

      return result.rows[0] || null;
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
  setTimeoutFn = setTimeout
}) {
  const retryJobs = new Map();

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

    return upsertWooOrder(restauranteId, order);
  }

  function retryKey(restauranteId, wooOrderId) {
    return `${Number(restauranteId)}:${String(wooOrderId)}`;
  }

  function scheduleHydrationRetry(restauranteId, wooOrderId, stripeFields, attempt = 0) {
    const key = retryKey(restauranteId, wooOrderId);
    if (retryJobs.has(key) || attempt >= retryDelaysMs.length) return false;

    const timer = setTimeoutFn(async () => {
      retryJobs.delete(key);
      try {
        await hydrateOrderFromWoo(restauranteId, wooOrderId);
        const hydratedOrder = await repository.updateStripeFields(
          restauranteId,
          wooOrderId,
          stripeFields
        );
        if (!hydratedOrder) {
          throw new Error('La orden rehidratada no pudo recibir los campos Stripe');
        }
        invalidateOrderCache(restauranteId);
      } catch (error) {
        logger.error('ORDER_HYDRATION_RETRY_FAILED', {
          restauranteId: Number(restauranteId),
          wooOrderId: String(wooOrderId),
          attempt: attempt + 1,
          message: error.message
        });
        scheduleHydrationRetry(restauranteId, wooOrderId, stripeFields, attempt + 1);
      }
    }, retryDelaysMs[attempt]);

    if (typeof timer?.unref === 'function') timer.unref();
    retryJobs.set(key, timer);
    return true;
  }

  async function persistStripePayment(restauranteId, wooOrderId, stripeFields) {
    const existingOrder = await repository.updateStripeFields(
      restauranteId,
      wooOrderId,
      stripeFields
    );

    if (existingOrder) {
      invalidateOrderCache(restauranteId);
      return { persisted: true, hydrated: false, retryScheduled: false };
    }

    if (stripeFields.paymentStatus !== 'succeeded') {
      return { persisted: false, hydrated: false, retryScheduled: false };
    }

    try {
      const hydration = await hydrateOrderFromWoo(restauranteId, wooOrderId);
      const hydratedOrder = await repository.updateStripeFields(
        restauranteId,
        wooOrderId,
        stripeFields
      );

      if (!hydratedOrder) {
        throw new Error('La orden hidratada no pudo recibir los campos Stripe');
      }

      invalidateOrderCache(restauranteId);

      if (!shouldAcceptWooOrder({ status: hydration.normalizedOrder.estado })) {
        scheduleHydrationRetry(restauranteId, wooOrderId, stripeFields);
      }

      return {
        persisted: true,
        hydrated: true,
        retryScheduled: !shouldAcceptWooOrder({ status: hydration.normalizedOrder.estado })
      };
    } catch (error) {
      logger.error('ORDER_HYDRATION_AFTER_PAYMENT_FAILED', {
        restauranteId: Number(restauranteId),
        wooOrderId: String(wooOrderId),
        message: error.message
      });
      const retryScheduled = scheduleHydrationRetry(
        restauranteId,
        wooOrderId,
        stripeFields
      );

      return { persisted: false, hydrated: false, retryScheduled, error };
    }
  }

  return {
    upsertWooOrder,
    hydrateOrderFromWoo,
    persistStripePayment,
    scheduleHydrationRetry,
    retryJobs
  };
}

module.exports = {
  DEFAULT_RETRY_DELAYS_MS,
  createOrderRepository,
  createOrderIntegrityService
};
