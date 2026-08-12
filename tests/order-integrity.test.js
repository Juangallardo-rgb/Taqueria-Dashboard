const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  createOrderIntegrityService,
  isOrderCommerciallyComplete,
  scheduleHydrationAfterResponse
} = require('../lib/order-integrity');
const { createOrderNotifier } = require('../lib/order-notifications');

const root = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const stripeSource = fs.readFileSync(
  path.join(root, 'routes', 'stripeConnect.js'),
  'utf8'
);
const integritySource = fs.readFileSync(
  path.join(root, 'lib', 'order-integrity.js'),
  'utf8'
);
const readmeSource = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

class MemoryOrderRepository {
  constructor() {
    this.rows = new Map();
    this.jobs = new Map();
    this.nextId = 1;
    this.listCalls = 0;
    this.stateCalls = 0;
  }

  key(restauranteId, wooOrderId) {
    return `${Number(restauranteId)}:${String(wooOrderId)}`;
  }

  seed(restauranteId, wooOrderId, values = {}) {
    const row = {
      id: this.nextId++,
      restaurante_id: Number(restauranteId),
      woo_order_id: String(wooOrderId),
      created_at: new Date().toISOString(),
      ...values
    };
    this.rows.set(this.key(restauranteId, wooOrderId), row);
    return row;
  }

  get(restauranteId, wooOrderId) {
    return this.rows.get(this.key(restauranteId, wooOrderId));
  }

  getJob(restauranteId, wooOrderId) {
    return this.jobs.get(this.key(restauranteId, wooOrderId));
  }

  seedJob(restauranteId, wooOrderId, stripeFields = stripePayment) {
    const job = {
      restaurante_id: Number(restauranteId),
      woo_order_id: String(wooOrderId),
      stripe_payment_intent_id: stripeFields.stripePaymentIntentId,
      stripe_account_id: stripeFields.stripeAccountId,
      denix_application_fee_cents: stripeFields.applicationFeeAmount,
      payment_split_status: stripeFields.paymentStatus,
      status: 'pending',
      attempts: 0
    };
    this.jobs.set(this.key(restauranteId, wooOrderId), job);
    return job;
  }

  async upsertWooOrder(restauranteId, incoming) {
    const key = this.key(restauranteId, incoming.wooOrderId);
    const current = this.rows.get(key);

    if (!current) {
      const inserted = this.seed(restauranteId, incoming.wooOrderId, {
        total: incoming.total,
        estado: incoming.estado,
        customer_name: incoming.customerName,
        customer_phone: incoming.customerPhone || null,
        items: [...incoming.items],
        refund_items: [...incoming.refundItems],
        tipo_pedido: incoming.tipoPedido,
        delivery_address: incoming.deliveryAddress,
        delivery_city: incoming.deliveryCity,
        delivery_postcode: incoming.deliveryPostcode,
        push_notified: false
      });
      return { id: inserted.id, created_at: inserted.created_at, inserted: true };
    }

    current.total = incoming.total;
    current.estado = incoming.estado;
    current.customer_name = incoming.customerName;
    if (incoming.customerPhone) current.customer_phone = incoming.customerPhone;
    if (incoming.items.length > 0) current.items = [...incoming.items];
    current.refund_items = [...incoming.refundItems];
    if (
      incoming.tipoPedidoConfiable &&
      ['pickup', 'delivery'].includes(incoming.tipoPedido)
    ) {
      current.tipo_pedido = incoming.tipoPedido;
    }
    current.delivery_address = incoming.deliveryAddress;
    current.delivery_city = incoming.deliveryCity;
    current.delivery_postcode = incoming.deliveryPostcode;

    return { id: current.id, created_at: current.created_at, inserted: false };
  }

  async recordStripePayment(restauranteId, wooOrderId, fields) {
    const row = this.get(restauranteId, wooOrderId);
    if (row) this.applyStripe(row, fields);

    const needsJob = fields.paymentStatus === 'succeeded' &&
      !isOrderCommerciallyComplete(row);
    if (needsJob) this.seedJob(restauranteId, wooOrderId, fields);

    return {
      order_exists: Boolean(row),
      hydration_queued: needsJob
    };
  }

  applyStripe(row, fields) {
    row.stripe_payment_intent_id = fields.stripePaymentIntentId;
    row.stripe_account_id = fields.stripeAccountId;
    row.denix_application_fee_cents = fields.applicationFeeAmount;
    row.payment_split_status = fields.paymentStatus;
  }

  async getHydrationState(restauranteId, wooOrderId) {
    this.stateCalls += 1;
    const job = this.getJob(restauranteId, wooOrderId);
    if (!job || job.status !== 'pending') return null;
    const row = this.get(restauranteId, wooOrderId);
    return {
      ...job,
      job_status: job.status,
      pedido_id: row?.id || null,
      items: row?.items,
      tipo_pedido: row?.tipo_pedido
    };
  }

  async getOrderCommercialState(restauranteId, wooOrderId) {
    return this.get(restauranteId, wooOrderId) || null;
  }

  async reconcileCompleteOrder(restauranteId, wooOrderId) {
    const job = this.getJob(restauranteId, wooOrderId);
    const row = this.get(restauranteId, wooOrderId);
    if (!job || job.status !== 'pending' || !isOrderCommerciallyComplete(row)) {
      return false;
    }

    this.applyStripe(row, {
      stripePaymentIntentId: job.stripe_payment_intent_id,
      stripeAccountId: job.stripe_account_id,
      applicationFeeAmount: job.denix_application_fee_cents,
      paymentStatus: job.payment_split_status
    });
    job.status = 'completed';
    return true;
  }

  async recordHydrationFailure(restauranteId, wooOrderId, error, nextAttemptAt) {
    const job = this.getJob(restauranteId, wooOrderId);
    if (!job || job.status !== 'pending') return;
    job.attempts += 1;
    job.last_error = error.message;
    job.next_attempt_at = nextAttemptAt;
  }

  async listPendingHydrations(limit) {
    this.listCalls += 1;
    const pending = [];
    for (const job of this.jobs.values()) {
      if (job.status !== 'pending') continue;
      const row = this.get(job.restaurante_id, job.woo_order_id);
      if (isOrderCommerciallyComplete(row)) {
        await this.reconcileCompleteOrder(job.restaurante_id, job.woo_order_id);
      } else {
        pending.push({ ...job });
      }
    }
    return pending.slice(0, limit);
  }
}

function wooOrder(id, overrides = {}) {
  return {
    id,
    total: '16.19',
    status: 'processing',
    billing: {
      first_name: 'Ana',
      last_name: 'Cliente',
      phone: '+1 555 6823',
      address_1: '6823 Main St',
      city: 'Los Angeles',
      postcode: '90001'
    },
    shipping: {},
    shipping_lines: [{ method_id: 'local_pickup', method_title: 'Pickup' }],
    meta_data: [{ key: '_denix_order_type', value: 'pickup' }],
    line_items: [{ name: 'California Burrito', quantity: 1, meta_data: [] }],
    ...overrides
  };
}

function createHarness({ repository = new MemoryOrderRepository() } = {}) {
  const orders = new Map();
  const timers = [];
  const intervals = [];
  const errors = [];
  let wooCalls = 0;
  let wooHandler = null;

  const service = createOrderIntegrityService({
    repository,
    getOperationalRestaurantConfig: async restauranteId => ({
      woo_url: `https://woo-${restauranteId}.test`,
      consumer_key: `key-${restauranteId}`,
      consumer_secret: `secret-${restauranteId}`
    }),
    httpClient: {
      get: async url => {
        wooCalls += 1;
        if (wooHandler) return wooHandler(url);
        const match = url.match(/woo-(\d+)\.test.*\/orders\/(\d+)/);
        const key = `${Number(match?.[1])}:${String(match?.[2])}`;
        const order = orders.get(key);
        if (!order) throw new Error(`Orden Woo ausente: ${key}`);
        return { data: order };
      }
    },
    invalidateOrderCache: () => {},
    logger: { error: (...args) => errors.push(args) },
    retryDelaysMs: [5000, 30000, 120000, 300000],
    recoveryIntervalMs: 300000,
    setTimeoutFn: (callback, delay) => {
      const timer = { callback, delay, active: true, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: timer => { timer.active = false; },
    setIntervalFn: (callback, delay) => {
      const timer = { callback, delay, active: true, unref() {} };
      intervals.push(timer);
      return timer;
    },
    clearIntervalFn: timer => { timer.active = false; }
  });

  return {
    service,
    repository,
    orders,
    timers,
    intervals,
    errors,
    get wooCalls() { return wooCalls; },
    setWooHandler(handler) { wooHandler = handler; },
    async runTimer(timer) {
      assert.equal(timer.active, true, 'el timer debe seguir activo');
      timer.active = false;
      return timer.callback();
    },
    activeTimers() {
      return timers.filter(timer => timer.active);
    }
  };
}

const stripePayment = {
  stripePaymentIntentId: 'pi_6823_ok',
  stripeAccountId: 'acct_taqueria',
  applicationFeeAmount: 298,
  paymentStatus: 'succeeded'
};

test('Stripe succeeded persiste localmente y no consulta Woo antes de responder', async () => {
  const harness = createHarness();
  const response = new EventEmitter();
  const result = await harness.service.persistStripePayment(1, 6823, stripePayment);

  assert.deepEqual(result, { order_exists: false, hydration_queued: true });
  assert.equal(harness.repository.get(1, 6823), undefined);
  assert.equal(harness.wooCalls, 0);

  scheduleHydrationAfterResponse(response, harness.service, 1, 6823);
  assert.equal(harness.timers.length, 0);
  response.emit('finish');
  assert.equal(harness.timers.length, 1);
  assert.equal(harness.wooCalls, 0);
});

test('Woo lento queda bloqueado despues del finish sin bloquear checkout', async () => {
  const harness = createHarness();
  const response = new EventEmitter();
  let releaseWoo;
  const slowWoo = new Promise(resolve => { releaseWoo = resolve; });
  harness.setWooHandler(async () => slowWoo);

  await harness.service.persistStripePayment(1, 6823, stripePayment);
  scheduleHydrationAfterResponse(response, harness.service, 1, 6823);
  let checkoutResponded = false;
  checkoutResponded = true;
  response.emit('finish');
  const hydration = harness.runTimer(harness.timers[0]);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(checkoutResponded, true);
  assert.equal(harness.wooCalls, 1);
  assert.equal(harness.repository.get(1, 6823), undefined);

  releaseWoo({ data: wooOrder(6823) });
  await hydration;
  assert.equal(harness.repository.get(1, 6823).items.length, 1);
});

test('fallo Woo no altera el resultado Stripe exitoso y deja retry durable', async () => {
  const harness = createHarness();
  harness.setWooHandler(async () => { throw new Error('Woo caido'); });

  const paymentResult = await harness.service.persistStripePayment(1, 6823, stripePayment);
  harness.service.scheduleOrderHydration(1, 6823);
  await harness.runTimer(harness.timers[0]);

  assert.equal(paymentResult.hydration_queued, true);
  assert.equal(harness.repository.get(1, 6823), undefined);
  assert.equal(harness.repository.getJob(1, 6823).status, 'pending');
  assert.equal(harness.activeTimers()[0].delay, 5000);
});

test('hidratacion solo ocurre despues del evento finish HTTP', async () => {
  const harness = createHarness();
  const response = new EventEmitter();
  harness.orders.set('1:6823', wooOrder(6823));
  await harness.service.persistStripePayment(1, 6823, stripePayment);
  scheduleHydrationAfterResponse(response, harness.service, 1, 6823);

  assert.equal(harness.repository.get(1, 6823), undefined);
  response.emit('finish');
  await harness.runTimer(harness.timers[0]);
  assert.equal(harness.repository.get(1, 6823).tipo_pedido, 'pickup');
});

test('solo existe una cadena retry por restaurante y orden', async () => {
  const harness = createHarness();
  harness.setWooHandler(async () => { throw new Error('Woo caido'); });
  await harness.service.persistStripePayment(1, 6823, stripePayment);

  assert.equal(harness.service.scheduleOrderHydration(1, 6823), true);
  assert.equal(harness.service.scheduleOrderHydration(1, 6823), false);
  assert.equal(harness.activeTimers().length, 1);
  await harness.runTimer(harness.activeTimers()[0]);
  assert.equal(harness.activeTimers()[0].delay, 5000);
  assert.equal(harness.service.scheduleOrderHydration(1, 6823), false);
});

test('webhook Woo completo cancela un retry pendiente sin otra consulta Woo', async () => {
  const harness = createHarness();
  await harness.service.persistStripePayment(1, 6823, stripePayment);
  harness.service.scheduleOrderHydration(1, 6823, { delayMs: 5000 });

  const webhook = await harness.service.upsertWooOrder(1, wooOrder(6823));
  assert.equal(webhook.storedOrder.inserted, true);
  assert.equal(await harness.service.markOrderHydratedByExternalFlow(1, 6823), true);

  assert.equal(harness.activeTimers().length, 0);
  assert.equal(harness.wooCalls, 0);
  assert.equal(harness.repository.get(1, 6823).stripe_payment_intent_id, 'pi_6823_ok');
});

test('retry exitoso termina la cadena y no deja timers futuros', async () => {
  const harness = createHarness();
  let available = false;
  harness.setWooHandler(async () => {
    if (!available) throw new Error('Woo temporal');
    return { data: wooOrder(6823) };
  });
  await harness.service.persistStripePayment(1, 6823, stripePayment);
  harness.service.scheduleOrderHydration(1, 6823);

  await harness.runTimer(harness.activeTimers()[0]);
  assert.equal(harness.activeTimers()[0].delay, 5000);
  available = true;
  await harness.runTimer(harness.activeTimers()[0]);

  assert.equal(harness.activeTimers().length, 0);
  assert.equal(harness.service.activeChains.size, 0);
  assert.equal(harness.repository.getJob(1, 6823).status, 'completed');
});

test('retries mantienen exactamente 5s, 30s, 2min y 5min', async () => {
  const harness = createHarness();
  harness.setWooHandler(async () => { throw new Error('Woo caido'); });
  await harness.service.persistStripePayment(1, 6823, stripePayment);
  harness.service.scheduleOrderHydration(1, 6823);

  const observed = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await harness.runTimer(harness.activeTimers()[0]);
    observed.push(harness.activeTimers()[0].delay);
  }
  assert.deepEqual(observed, [5000, 30000, 120000, 300000]);

  await harness.runTimer(harness.activeTimers()[0]);
  assert.equal(harness.activeTimers().length, 0);
  assert.equal(harness.repository.getJob(1, 6823).status, 'pending');
});

test('Stripe hydration crea push una vez y SSE created; Woo posterior solo updated', async () => {
  const row = { id: 1, push_notified: false };
  const events = [];
  let pushes = 0;
  const pool = {
    async query(sql) {
      if (sql.includes('COALESCE(push_notified, FALSE)')) {
        if (row.push_notified) return { rows: [] };
        row.push_notified = true;
        return { rows: [{ id: row.id }] };
      }
      return { rows: [] };
    }
  };
  const notifier = createOrderNotifier({
    pool,
    publishAdminEvent: type => events.push(type),
    sendNewOrderPush: async () => {
      pushes += 1;
      return { enviados: 1, desactivados: 0, sinDispositivos: false };
    },
    logger: { log() {}, error() {} }
  });
  const normalized = {
    wooOrderId: '6823',
    total: '16.19',
    estado: 'processing',
    customerName: 'Ana Cliente',
    tipoPedido: 'pickup'
  };

  await notifier.notifyStoredOrder(1, wooOrder(6823), { inserted: true }, normalized);
  await notifier.notifyStoredOrder(1, wooOrder(6823), { inserted: false }, normalized);

  assert.equal(pushes, 1);
  assert.deepEqual(events, ['order_created', 'order_updated']);
});

test('carrera Woo primero produce una fila completa, conserva Stripe y cancela worker', async () => {
  const harness = createHarness();
  await harness.service.persistStripePayment(1, 6823, stripePayment);
  harness.service.scheduleOrderHydration(1, 6823, { delayMs: 5000 });

  await Promise.all([
    harness.service.upsertWooOrder(1, wooOrder(6823)),
    Promise.resolve()
  ]);
  await harness.service.markOrderHydratedByExternalFlow(1, 6823);

  assert.equal(harness.repository.rows.size, 1);
  const row = harness.repository.get(1, 6823);
  assert.equal(row.items.length, 1);
  assert.equal(row.customer_phone, '+1 555 6823');
  assert.equal(row.tipo_pedido, 'pickup');
  assert.equal(row.stripe_payment_intent_id, 'pi_6823_ok');
  assert.equal(harness.activeTimers().length, 0);
});

test('Woo posterior a Stripe hydration no destruye datos comerciales ni Stripe', async () => {
  const harness = createHarness();
  harness.orders.set('1:6823', wooOrder(6823));
  await harness.service.persistStripePayment(1, 6823, stripePayment);
  harness.service.scheduleOrderHydration(1, 6823);
  await harness.runTimer(harness.activeTimers()[0]);

  await harness.service.upsertWooOrder(1, wooOrder(6823, {
    billing: { first_name: 'Ana', last_name: 'Parcial', phone: '' },
    line_items: [],
    meta_data: [],
    shipping_lines: []
  }));

  const row = harness.repository.get(1, 6823);
  assert.equal(harness.repository.rows.size, 1);
  assert.equal(row.items.length, 1);
  assert.equal(row.customer_phone, '+1 555 6823');
  assert.equal(row.tipo_pedido, 'pickup');
  assert.equal(row.stripe_payment_intent_id, 'pi_6823_ok');
});

test('respuesta Woo incompleta no se considera hidratacion exitosa permanente', async () => {
  const harness = createHarness();
  harness.orders.set('1:6823', wooOrder(6823, {
    line_items: [],
    meta_data: [],
    shipping_lines: []
  }));
  await harness.service.persistStripePayment(1, 6823, stripePayment);
  harness.service.scheduleOrderHydration(1, 6823);
  await harness.runTimer(harness.activeTimers()[0]);

  assert.equal(harness.repository.getJob(1, 6823).status, 'pending');
  assert.equal(harness.activeTimers()[0].delay, 5000);
  assert.equal(isOrderCommerciallyComplete(harness.repository.get(1, 6823)), false);
});

test('order.created temprano en pending no inserta pedidos y se reintenta', async () => {
  const harness = createHarness();
  harness.orders.set('1:6823', wooOrder(6823, { status: 'pending' }));
  await harness.service.persistStripePayment(1, 6823, stripePayment);
  harness.service.scheduleOrderHydration(1, 6823);
  await harness.runTimer(harness.activeTimers()[0]);

  assert.equal(harness.repository.get(1, 6823), undefined);
  assert.equal(harness.repository.getJob(1, 6823).status, 'pending');
  assert.equal(harness.activeTimers()[0].delay, 5000);
});

test('incorrect_cvc no persiste; segundo intento exitoso hidrata una sola orden', async () => {
  const harness = createHarness();
  harness.orders.set('1:6823', wooOrder(6823));

  assert.ok(
    stripeSource.indexOf('stripe.paymentIntents.create') <
    stripeSource.indexOf('orderIntegrity.persistStripePayment')
  );
  assert.equal(harness.repository.rows.size, 0);
  assert.equal(harness.repository.jobs.size, 0);

  await harness.service.persistStripePayment(1, 6823, stripePayment);
  harness.service.scheduleOrderHydration(1, 6823);
  await harness.runTimer(harness.activeTimers()[0]);

  assert.equal(harness.repository.rows.size, 1);
  assert.equal(harness.repository.get(1, 6823).items.length, 1);
  assert.equal(harness.repository.get(1, 6823).payment_split_status, 'succeeded');
});

test('mismo woo_order_id permanece aislado entre restaurante 1 y 4', async () => {
  const harness = createHarness();
  harness.orders.set('1:500', wooOrder(500, {
    billing: { first_name: 'Uno', last_name: '', phone: '111' }
  }));
  harness.orders.set('4:500', wooOrder(500, {
    billing: { first_name: 'Cuatro', last_name: '', phone: '444' },
    meta_data: [{ key: '_denix_order_type', value: 'delivery' }],
    shipping_lines: []
  }));

  await harness.service.persistStripePayment(1, 500, stripePayment);
  await harness.service.persistStripePayment(4, 500, {
    ...stripePayment,
    stripePaymentIntentId: 'pi_restaurant_4'
  });
  harness.service.scheduleOrderHydration(1, 500);
  harness.service.scheduleOrderHydration(4, 500);
  await Promise.all(harness.activeTimers().map(timer => harness.runTimer(timer)));

  assert.equal(harness.repository.rows.size, 2);
  assert.equal(harness.repository.get(1, 500).customer_phone, '111');
  assert.equal(harness.repository.get(4, 500).customer_phone, '444');
  assert.equal(harness.repository.get(1, 500).stripe_payment_intent_id, 'pi_6823_ok');
  assert.equal(harness.repository.get(4, 500).stripe_payment_intent_id, 'pi_restaurant_4');
});

test('recovery en una consulta omite completas y agenda solo incompletas', async () => {
  const harness = createHarness();
  harness.repository.seed(1, 100, {
    items: [{ nombre: 'Taco', cantidad: 1 }],
    tipo_pedido: 'pickup'
  });
  harness.repository.seedJob(1, 100);
  harness.repository.seedJob(1, 101);

  const recovered = await harness.service.recoverPendingHydrations();

  assert.equal(recovered, 1);
  assert.equal(harness.repository.listCalls, 1);
  assert.equal(harness.repository.stateCalls, 0);
  assert.equal(harness.repository.getJob(1, 100).status, 'completed');
  assert.equal(harness.activeTimers().length, 1);
  assert.equal(harness.service.activeChains.has('1:101'), true);
});

test('recovery loop usa intervalo de cinco minutos y no se duplica', async () => {
  const harness = createHarness();
  const first = harness.service.startRecoveryLoop();
  const second = harness.service.startRecoveryLoop();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(first, second);
  assert.equal(harness.intervals.length, 1);
  assert.equal(harness.intervals[0].delay, 300000);
  assert.equal(harness.repository.listCalls, 1);
});

test('force-order reutiliza criterio central de orden completa', () => {
  const forceSource = indexSource.slice(
    indexSource.indexOf("app.get('/force-order/:id'"),
    indexSource.indexOf("app.post('/complete-order/:id'")
  );
  assert.match(forceSource, /orderIntegrity\.orderNeedsHydration/);
  assert.match(forceSource, /orderIntegrity\.hydrateOrderFromWoo/);
  assert.match(forceSource, /publishAndNotifyStoredOrder/);
});

test('Stripe no inserta esqueletos y conserva fee, cuenta e idempotencia', () => {
  const createPaymentSource = stripeSource.slice(
    stripeSource.indexOf('router.post("/create-payment-intent"'),
    stripeSource.indexOf('/**', stripeSource.indexOf('router.post("/create-payment-intent"') + 1)
  );

  assert.doesNotMatch(createPaymentSource, /INSERT INTO pedidos/);
  assert.match(createPaymentSource, /application_fee_amount: applicationFeeAmount/);
  assert.match(createPaymentSource, /stripeAccount: restaurante\.stripe_account_id/);
  assert.match(createPaymentSource, /idempotencyKey:/);
  assert.match(createPaymentSource, /scheduleHydrationAfterResponse/);
  assert.doesNotMatch(createPaymentSource, /hydrateOrderFromWoo/);
  assert.match(integritySource, /ON CONFLICT \(restaurante_id, woo_order_id\)/);
});

test('rutas Woo tokenizada y legacy comparten handler order.created/order.updated', () => {
  assert.match(
    indexSource,
    /app\.post\('\/webhooks\/woo\/:webhookToken\/order'[\s\S]*?processWooOrderWebhook\(req, res, config\.id\)/
  );
  assert.match(
    indexSource,
    /app\.post\('\/webhook-order'[\s\S]*?processWooOrderWebhook\(req, res, 1\)/
  );
  assert.match(readmeSource, /`order\.created` y `order\.updated`/);
  assert.match(readmeSource, /mismo secreto HMAC/);
});
