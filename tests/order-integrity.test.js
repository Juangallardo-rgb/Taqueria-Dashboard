const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createOrderIntegrityService } = require('../lib/order-integrity');

const root = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const stripeSource = fs.readFileSync(
  path.join(root, 'routes', 'stripeConnect.js'),
  'utf8'
);
const integritySource = fs.readFileSync(
  path.join(root, 'lib', 'order-integrity.js'),
  'utf8'
);

class MemoryOrderRepository {
  constructor() {
    this.rows = new Map();
    this.nextId = 1;
  }

  key(restauranteId, wooOrderId) {
    return `${Number(restauranteId)}:${String(wooOrderId)}`;
  }

  seed(restauranteId, wooOrderId, values) {
    const row = {
      id: this.nextId++,
      restaurante_id: Number(restauranteId),
      woo_order_id: String(wooOrderId),
      ...values
    };
    this.rows.set(this.key(restauranteId, wooOrderId), row);
    return row;
  }

  get(restauranteId, wooOrderId) {
    return this.rows.get(this.key(restauranteId, wooOrderId));
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
        delivery_postcode: incoming.deliveryPostcode
      });
      return { id: inserted.id, inserted: true };
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

    return { id: current.id, inserted: false };
  }

  async updateStripeFields(restauranteId, wooOrderId, stripeFields) {
    const row = this.get(restauranteId, wooOrderId);
    if (!row) return null;

    row.stripe_payment_intent_id = stripeFields.stripePaymentIntentId;
    row.stripe_account_id = stripeFields.stripeAccountId;
    row.denix_application_fee_cents = stripeFields.applicationFeeAmount;
    row.payment_split_status = stripeFields.paymentStatus;
    return { id: row.id };
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
    shipping_lines: [{
      method_id: 'local_pickup',
      method_title: 'Pickup'
    }],
    meta_data: [{ key: '_denix_order_type', value: 'pickup' }],
    line_items: [{
      name: 'California Burrito',
      quantity: 1,
      meta_data: []
    }],
    ...overrides
  };
}

function createHarness({ repository = new MemoryOrderRepository(), orders = new Map() } = {}) {
  const timers = [];
  const errors = [];
  let wooAvailable = true;

  const service = createOrderIntegrityService({
    repository,
    getOperationalRestaurantConfig: async restauranteId => ({
      woo_url: `https://woo-${restauranteId}.test`,
      consumer_key: `key-${restauranteId}`,
      consumer_secret: `secret-${restauranteId}`
    }),
    httpClient: {
      get: async url => {
        if (!wooAvailable) throw new Error('Woo temporalmente caido');
        const match = url.match(/woo-(\d+)\.test.*\/orders\/(\d+)/);
        const key = `${Number(match?.[1])}:${String(match?.[2])}`;
        const order = orders.get(key);
        if (!order) throw new Error(`Orden Woo ausente: ${key}`);
        return { data: order };
      }
    },
    invalidateOrderCache: () => {},
    logger: { error: (...args) => errors.push(args) },
    retryDelaysMs: [1, 2],
    setTimeoutFn: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    }
  });

  return {
    service,
    repository,
    orders,
    timers,
    errors,
    setWooAvailable(value) {
      wooAvailable = value;
    }
  };
}

const stripeFields = {
  stripePaymentIntentId: 'pi_6823_ok',
  stripeAccountId: 'acct_taqueria',
  applicationFeeAmount: 298,
  paymentStatus: 'succeeded'
};

test('caso 6823: pago exitoso sin fila hidrata items, telefono, pickup, total y Stripe', async () => {
  const harness = createHarness();
  harness.orders.set('1:6823', wooOrder(6823));

  const result = await harness.service.persistStripePayment(1, '6823', stripeFields);
  const row = harness.repository.get(1, '6823');

  assert.deepEqual(result, {
    persisted: true,
    hydrated: true,
    retryScheduled: false
  });
  assert.deepEqual(row.items, [{ nombre: 'California Burrito', cantidad: 1 }]);
  assert.equal(row.customer_phone, '+1 555 6823');
  assert.equal(row.tipo_pedido, 'pickup');
  assert.equal(row.total, '16.19');
  assert.equal(row.customer_name, 'Ana Cliente');
  assert.equal(row.delivery_address, '6823 Main St');
  assert.equal(row.delivery_city, 'Los Angeles');
  assert.equal(row.delivery_postcode, '90001');
  assert.equal(row.refund_items[0].name, 'California Burrito');
  assert.equal(row.stripe_payment_intent_id, 'pi_6823_ok');
  assert.equal(row.stripe_account_id, 'acct_taqueria');
  assert.equal(row.payment_split_status, 'succeeded');
});

test('pago exitoso con fila existente actualiza solo campos Stripe', async () => {
  const harness = createHarness();
  const row = harness.repository.seed(1, 6823, {
    total: '16.19',
    estado: 'processing',
    customer_name: 'Ana Cliente',
    customer_phone: '+1 555 real',
    items: [{ nombre: 'California Burrito', cantidad: 1 }],
    tipo_pedido: 'pickup'
  });
  const commercialBefore = JSON.parse(JSON.stringify(row));

  const result = await harness.service.persistStripePayment(1, 6823, stripeFields);

  assert.equal(result.hydrated, false);
  assert.equal(harness.timers.length, 0);
  for (const field of [
    'total', 'estado', 'customer_name', 'customer_phone', 'items', 'tipo_pedido'
  ]) {
    assert.deepEqual(row[field], commercialBefore[field]);
  }
  assert.equal(row.stripe_payment_intent_id, 'pi_6823_ok');
});

test('Woo caido no convierte pago exitoso en fallo y el retry recupera la orden', async () => {
  const harness = createHarness();
  harness.orders.set('1:6823', wooOrder(6823));
  harness.setWooAvailable(false);

  const result = await harness.service.persistStripePayment(1, 6823, stripeFields);

  assert.equal(result.persisted, false);
  assert.equal(result.retryScheduled, true);
  assert.equal(harness.repository.get(1, 6823), undefined);
  assert.equal(harness.timers.length, 1);

  harness.setWooAvailable(true);
  await harness.timers[0].callback();

  const recovered = harness.repository.get(1, 6823);
  assert.equal(recovered.tipo_pedido, 'pickup');
  assert.equal(recovered.customer_phone, '+1 555 6823');
  assert.equal(recovered.stripe_payment_intent_id, 'pi_6823_ok');
});

test('upsert parcial no destruye items, telefono ni pickup existentes', async () => {
  const harness = createHarness();
  const row = harness.repository.seed(1, 77, {
    total: '20.00',
    estado: 'processing',
    customer_name: 'Cliente real',
    customer_phone: '555-0077',
    items: [{ nombre: 'Taco', cantidad: 2 }],
    refund_items: [],
    tipo_pedido: 'pickup'
  });

  await harness.service.upsertWooOrder(1, wooOrder(77, {
    billing: { first_name: 'Cliente', last_name: 'Parcial', phone: '' },
    line_items: [],
    meta_data: [],
    shipping_lines: [],
    shipping: {}
  }));

  assert.deepEqual(row.items, [{ nombre: 'Taco', cantidad: 2 }]);
  assert.equal(row.customer_phone, '555-0077');
  assert.equal(row.tipo_pedido, 'pickup');
});

test('tipo delivery explicito si actualiza un pickup existente', async () => {
  const harness = createHarness();
  const row = harness.repository.seed(1, 88, {
    customer_phone: '555',
    items: [{ nombre: 'Taco', cantidad: 1 }],
    refund_items: [],
    tipo_pedido: 'pickup'
  });

  await harness.service.upsertWooOrder(1, wooOrder(88, {
    meta_data: [{ key: '_denix_order_type', value: 'delivery' }],
    shipping_lines: [],
    shipping: {}
  }));

  assert.equal(row.tipo_pedido, 'delivery');
});

test('hidratacion mantiene aislado el mismo woo_order_id entre restaurantes', async () => {
  const harness = createHarness();
  harness.orders.set('1:500', wooOrder(500, {
    billing: { first_name: 'Restaurante', last_name: 'Uno', phone: '111' }
  }));
  harness.orders.set('4:500', wooOrder(500, {
    billing: { first_name: 'Restaurante', last_name: 'Cuatro', phone: '444' },
    meta_data: [{ key: '_denix_order_type', value: 'delivery' }]
  }));

  await harness.service.hydrateOrderFromWoo(1, 500);
  await harness.service.hydrateOrderFromWoo(4, 500);

  assert.equal(harness.repository.rows.size, 2);
  assert.equal(harness.repository.get(1, 500).customer_phone, '111');
  assert.equal(harness.repository.get(4, 500).customer_phone, '444');
  assert.equal(harness.repository.get(1, 500).tipo_pedido, 'pickup');
  assert.equal(harness.repository.get(4, 500).tipo_pedido, 'delivery');
});

test('force-order detecta [] array, "[]" string y reutiliza hidratacion central', () => {
  const functionSource = appSource.match(
    /function pedidoTieneItemsVacios\(items\) \{[\s\S]*?\n\}/
  )?.[0];
  assert.ok(functionSource);

  const context = {};
  vm.runInNewContext(`${functionSource}; result = [
    pedidoTieneItemsVacios([]),
    pedidoTieneItemsVacios('[]'),
    pedidoTieneItemsVacios(null),
    pedidoTieneItemsVacios([{ nombre: 'Taco' }])
  ];`, context);
  assert.deepEqual(Array.from(context.result), [true, true, true, false]);

  const forceSource = indexSource.slice(
    indexSource.indexOf("app.get('/force-order/:id'"),
    indexSource.indexOf("app.post('/complete-order/:id'")
  );
  assert.match(forceSource, /orderIntegrity\.hydrateOrderFromWoo/);
  assert.match(forceSource, /tipo_pedido: hydration\.normalizedOrder\.tipoPedido/);
});

test('Shipday reutiliza el upsert no destructivo y no mantiene otro parser', () => {
  const shipdaySource = indexSource.slice(
    indexSource.indexOf('async function processShipdayWebhook'),
    indexSource.indexOf("app.post('/webhooks/shipday/:webhookToken'")
  );
  assert.match(shipdaySource, /orderIntegrity\.upsertWooOrder\(restauranteId, order\)/);
  assert.doesNotMatch(shipdaySource, /items = EXCLUDED\.items/);
  assert.match(integritySource, /NULLIF\(EXCLUDED\.customer_phone, ''\)/);
  assert.match(integritySource, /jsonb_array_length\(EXCLUDED\.items::jsonb\) > 0/);
});

test('incorrect_cvc previo no persiste y el intento exitoso termina completo', async () => {
  const harness = createHarness();
  harness.orders.set('1:6823', wooOrder(6823));

  // El primer paymentIntents.create lanza antes de persistStripePayment.
  assert.ok(
    stripeSource.indexOf('stripe.paymentIntents.create') <
    stripeSource.indexOf('orderIntegrity.persistStripePayment')
  );
  assert.equal(harness.repository.get(1, 6823), undefined);

  await harness.service.persistStripePayment(1, 6823, stripeFields);
  const row = harness.repository.get(1, 6823);
  assert.equal(row.items[0].nombre, 'California Burrito');
  assert.equal(row.tipo_pedido, 'pickup');
  assert.equal(row.payment_split_status, 'succeeded');
});

test('Stripe ya no inserta esqueletos y fees/cargo conectado permanecen intactos', () => {
  const createPaymentSource = stripeSource.slice(
    stripeSource.indexOf('router.post("/create-payment-intent"'),
    stripeSource.indexOf('/**', stripeSource.indexOf('router.post("/create-payment-intent"') + 1)
  );

  assert.doesNotMatch(createPaymentSource, /INSERT INTO pedidos/);
  assert.doesNotMatch(createPaymentSource, /'\[\]'::json/);
  assert.match(createPaymentSource, /application_fee_amount: applicationFeeAmount/);
  assert.match(createPaymentSource, /stripeAccount: restaurante\.stripe_account_id/);
  assert.match(createPaymentSource, /orderIntegrity\.persistStripePayment/);
});

test('rutas tokenizada y legacy comparten handler y aceptan order.updated', () => {
  assert.match(
    indexSource,
    /app\.post\('\/webhooks\/woo\/:webhookToken\/order'[\s\S]*?processWooOrderWebhook\(req, res, config\.id\)/
  );
  assert.match(
    indexSource,
    /app\.post\('\/webhook-order'[\s\S]*?processWooOrderWebhook\(req, res, 1\)/
  );
  assert.doesNotMatch(
    indexSource.slice(
      indexSource.indexOf('async function processWooOrderWebhook'),
      indexSource.indexOf('async function processShipdayWebhook')
    ),
    /x-wc-webhook-topic.*order\.created/
  );
});
