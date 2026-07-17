function convertirFecha(timestamp) {
  if (!timestamp) return null;
  const numericTimestamp = Number(timestamp);
  const dateValue = Number.isFinite(numericTimestamp)
    ? (numericTimestamp < 1e12 ? numericTimestamp * 1000 : numericTimestamp)
    : timestamp;
  const date = new Date(dateValue);
  return Number.isNaN(date.getTime()) ? null : date;
}
require('dotenv').config();
const pool = require('./database');

const axios = require('axios');
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');

const stripeConnectRoutes = require('./routes/stripeConnect');
const {
  SESSION_COOKIE_NAME,
  getSessionSettings,
  createPersistentSessionMiddleware,
  regenerateSession,
  saveSession,
  destroySession
} = require('./lib/session');
const { createRestaurantContext } = require('./lib/restaurant-context');
const { maskSecret } = require('./lib/mask-secret');
const { registerPublicAssetRoutes } = require('./lib/public-assets');
const { createOperationalConfig } = require('./lib/operational-config');
const {
  verifyWooWebhookSignature,
  safeEqualText,
  verifyShipdaySecret
} = require('./lib/webhook-security');
const {
  detectarTipoPedidoWoo,
  buildWooOrderItems,
  getWooDeliveryAddress,
  shouldIgnoreWooOrder
} = require('./lib/order-utils');


const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({
  verify: (req, res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  }
}));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 4000;
const LEGACY_RESTAURANT_ONE_ENABLED =
  String(process.env.ENABLE_LEGACY_RESTAURANT_1 || '').toLowerCase() === 'true';

// 🔔 PUSH NOTIFICATIONS
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT) {
  webpush.setVapidDetails(
    VAPID_SUBJECT,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );

  console.log("🔔 Web Push configurado correctamente");
} else {
  console.warn("⚠️ Faltan variables VAPID para notificaciones push");
}

if (LEGACY_RESTAURANT_ONE_ENABLED) {
  if (!process.env.WEBHOOK_SECRET) {
    console.warn("⚠️ Falta WEBHOOK_SECRET para compatibilidad de restaurante 1");
  }

  console.log("🔐 LEGACY RESTAURANTE 1:", {
    enabled: true,
    WOO_URL: process.env.WOO_URL ? "CONFIGURADO" : "NO CONFIGURADO",
    CONSUMER_KEY: process.env.CONSUMER_KEY ? "CONFIGURADO" : "NO CONFIGURADO",
    CONSUMER_SECRET: process.env.CONSUMER_SECRET ? "CONFIGURADO" : "NO CONFIGURADO",
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET ? "CONFIGURADO" : "NO CONFIGURADO"
  });
}


// 🧠 MEMORIA
let wooOrders = [];
let shipdayOrders = [];

app.use(createPersistentSessionMiddleware({ pool }));

const {
  getSessionRestaurantId,
  requireSessionRestaurant,
  requireAdmin,
  getRestaurantIntegrationConfig
} = createRestaurantContext({ pool });

const {
  getOperationalRestaurantConfig,
  resolveOperationalRestaurantByToken,
  getLegacyRestaurantOneOperationalConfig
} = createOperationalConfig({
  pool,
  getRestaurantIntegrationConfig
});

function sendOperationalError(res, error) {
  return res.status(error.statusCode || 500).json({
    success: false,
    message: error.message || 'Error de configuración operativa',
    code: error.code || 'OPERATIONAL_ERROR'
  });
}

async function requireWooOperationalConfig(req, res, next) {
  try {
    req.operationalConfig = await getOperationalRestaurantConfig(
      req.restaurant.id,
      { required: ['woo_url', 'consumer_key', 'consumer_secret'] }
    );
    next();
  } catch (error) {
    return sendOperationalError(res, error);
  }
}

function getWooAxiosAuth(config) {
  return {
    username: config.consumer_key,
    password: config.consumer_secret
  };
}

// Stripe conserva su comportamiento actual durante esta fase.
app.use('/api/stripe/connect', stripeConnectRoutes);

// Toda ruta /admin, incluida la página HTML, exige una sesión administrativa.
app.use('/admin', requireAdmin);

// Solo estos recursos frontend son públicos.
registerPublicAssetRoutes(app, __dirname);

app.get('/session', requireSessionRestaurant, (req, res) => {
  res.json({
    authenticated: true,
    user: {
      id: Number(req.session.user_id),
      email: req.session.email,
      rol: req.session.rol,
      restaurante_id: getSessionRestaurantId(req)
    }
  });
});

app.post('/logout', async (req, res) => {
  try {
    await destroySession(req);

    const { cookie } = getSessionSettings(process.env);

    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      secure: cookie.secure,
      path: cookie.path
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error destruyendo la sesión:', error.message);
    res.status(500).json({
      success: false,
      message: 'No se pudo cerrar la sesión'
    });
  }
});

app.get('/mi-restaurante', requireSessionRestaurant, (req, res) => {
  res.json({
    id: req.restaurant.id,
    nombre: req.restaurant.nombre,
    logo_url: req.restaurant.logo_url,
    abierto: req.restaurant.abierto,
    activo: req.restaurant.activo
  });
});

// 🏠 HOME
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 🖥️ DASHBOARD
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

async function processWooProductWebhook(req, res, restauranteId) {
  try {
    const product = req.body;
    const topic = req.headers['x-wc-webhook-topic'] || '';

    console.log("📦 WEBHOOK PRODUCTO RECIBIDO:", {
      topic,
      id: product?.id,
      name: product?.name,
      bodyKeys: product ? Object.keys(product) : []
    });

    // ✅ WooCommerce a veces manda una prueba/ping sin producto completo.
    // No lo tratamos como error para que el webhook se pueda guardar.
    if (!product || !product.id) {
      console.log("⚠️ Webhook recibido sin producto completo. Se ignora sin error.");
      return res.status(200).json({
        success: true,
        ignored: true,
        message: "Webhook recibido, pero sin producto completo"
      });
    }

    const wooProductId = String(product.id);

    const imagen = product.images && product.images.length
      ? product.images[0].src
      : null;

    const categorias = product.categories || [];

    const isDeleted =
      topic.includes('deleted') ||
      product.status === 'trash';

    await pool.query(
      `INSERT INTO productos
        (
          restaurante_id,
          woo_product_id,
          nombre,
          precio,
          regular_price,
          sale_price,
          estado,
          stock_status,
          imagen,
          categorias,
          raw,
          deleted,
          updated_at
        )
       VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
       ON CONFLICT (restaurante_id, woo_product_id)
       DO UPDATE SET
          nombre = EXCLUDED.nombre,
          precio = EXCLUDED.precio,
          regular_price = EXCLUDED.regular_price,
          sale_price = EXCLUDED.sale_price,
          estado = EXCLUDED.estado,
          stock_status = EXCLUDED.stock_status,
          imagen = EXCLUDED.imagen,
          categorias = EXCLUDED.categorias,
          raw = EXCLUDED.raw,
          deleted = EXCLUDED.deleted,
          updated_at = NOW()`,
      [
        restauranteId,
        wooProductId,
        product.name || '',
        Number(product.price || 0),
        Number(product.regular_price || 0),
        Number(product.sale_price || 0),
        product.status || '',
        product.stock_status || '',
        imagen,
        JSON.stringify(categorias),
        JSON.stringify(product),
        isDeleted
      ]
    );

    console.log("✅ PRODUCTO GUARDADO EN SUPABASE:", wooProductId);

    res.json({
      success: true,
      message: "Producto guardado",
      product_id: wooProductId
    });

  } catch (error) {
    console.error("❌ ERROR WEBHOOK PRODUCTO:", error.message);

    res.status(500).json({
      success: false,
      message: "Error guardando producto",
      error: error.message
    });
  }
}

app.post('/webhooks/woo/:webhookToken/product', async (req, res) => {
  try {
    const config = await resolveOperationalRestaurantByToken(
      req.params.webhookToken,
      { required: ['woo_webhook_secret'] }
    );

    const validSignature = verifyWooWebhookSignature(
      req.rawBody,
      config.woo_webhook_secret,
      req.headers['x-wc-webhook-signature']
    );

    if (!validSignature) {
      return res.status(401).json({ success: false, message: 'Firma inválida' });
    }

    return processWooProductWebhook(req, res, config.id);
  } catch (error) {
    return sendOperationalError(res, error);
  }
});

app.post('/webhook-product', async (req, res) => {
  try {
    const config = await getLegacyRestaurantOneOperationalConfig({
      required: ['woo_webhook_secret']
    });

    const validSignature = verifyWooWebhookSignature(
      req.rawBody,
      config.woo_webhook_secret,
      req.headers['x-wc-webhook-signature']
    );
    const validLegacyQuerySecret =
      safeEqualText(req.query.secret, config.woo_webhook_secret) ||
      safeEqualText(req.query.secret, config.webhook_token);

    if (!validSignature && !validLegacyQuerySecret) {
      return res.status(401).json({ success: false, message: 'No autorizado' });
    }

    return processWooProductWebhook(req, res, 1);
  } catch (error) {
    return sendOperationalError(res, error);
  }
});

app.get('/productos-db', requireSessionRestaurant, async (req, res) => {
  try {
    const restaurante_id = req.restaurant.id;

    const result = await pool.query(
      `SELECT 
        id,
        woo_product_id,
        nombre,
        precio,
        regular_price,
        sale_price,
        estado,
        stock_status,
        imagen,
        categorias,
        raw,
        updated_at
       FROM productos
       WHERE restaurante_id = $1
       AND deleted = false
       ORDER BY nombre ASC`,
      [restaurante_id]
    );

    res.json(result.rows);

  } catch (error) {
    console.error("❌ ERROR PRODUCTOS DB:", error.message);

    res.status(500).json({
      success: false,
      message: "Error cargando productos desde DB"
    });
  }
});

// ===============================
// 📦 WOO ORDERS
// ===============================
// ===============================
// 🔥 GET WOO ORDERS (OPTIMIZADO)
// ===============================
app.get('/woo-orders', requireSessionRestaurant, async (req, res) => {
  try {
    const config = await getOperationalRestaurantConfig(req.restaurant.id, {
      required: ['woo_url', 'consumer_key', 'consumer_secret']
    });
    const response = await axios.get(
      `${config.woo_url}/wp-json/wc/v3/orders?per_page=20`,
      { 
        auth: { 
          username: config.consumer_key,
          password: config.consumer_secret
        },
        timeout: 30000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Denix-Dashboard/1.0'
        }
      } 
    );

    const wooOrders = response.data.map(order => { 
      const tipoPedido = detectarTipoPedidoWoo(order);
      
      return { 
        id: order.id, 
        total: order.total, 
        estado: order.status, 
        customer_name: `${(order.billing?.first_name || '')} ${(order.billing?.last_name || '')}`.trim() || 'Cliente', 
        direccion: order.shipping?.address_1 || '', 
        ciudad: order.shipping?.city || '', 
        estado_envio: tipoPedido,
        created_at: order.date_created, 
        items: (order.line_items || []).map(item => { 
          const extras = (item.meta_data || []) 
            .filter(m => m.value && m.value !== '') 
            .map(m => `${m.key}: ${m.value}`) 
            .join(', '); 
          
          return { 
            nombre: `${item.name}${extras ? ` (${extras})` : ''}`, 
            cantidad: item.quantity 
          }; 
        }) 
      }; 
    }); 

    res.json(wooOrders); 

  } catch (error) { 
    if (error.statusCode) return sendOperationalError(res, error);
    console.error("❌ ERROR WOO MESSAGE:", error.message);
    console.error("❌ ERROR WOO CODE:", error.code);
    console.error("❌ ERROR WOO STATUS:", error.response?.status);
    console.error("❌ ERROR WOO HEADERS:", error.response?.headers);
    console.error("❌ ERROR WOO DATA:", 
      typeof error.response?.data === 'string'
        ? error.response.data.substring(0, 1000)
        : error.response?.data || ''
    );

    res.status(500).send('Error WooCommerce'); 
  }
});

// ======================================================
// 🔔 ENVIAR PUSH DE NUEVO PEDIDO AL RESTAURANTE
// ======================================================
async function enviarPushNuevoPedido(restauranteId, order) {

  const result = await pool.query(
    `SELECT id, endpoint, p256dh, auth
     FROM push_subscriptions
     WHERE restaurante_id = $1
     AND activo = true`,
    [restauranteId]
  );

  if (!result.rows.length) {
    console.log("🔕 No hay dispositivos push activos para restaurante:", restauranteId);

    return {
      enviados: 0,
      desactivados: 0,
      sinDispositivos: true
    };
  }

  let tipoPedido = detectarTipoPedidoWoo(order) === 'pickup'
    ? 'Pickup'
    : 'Delivery';

  try {
    const tipoRes = await pool.query(
      `SELECT
         p.tipo_pedido,
         d.order_number
       FROM pedidos p
       LEFT JOIN deliveries d
         ON d.restaurante_id = p.restaurante_id
        AND d.order_number::text = p.woo_order_id::text
       WHERE p.restaurante_id = $1
         AND p.woo_order_id::text = $2
       LIMIT 1`,
      [restauranteId, String(order.id)]
    );

    const infoPedido = tipoRes.rows[0];

    if (
      infoPedido?.order_number ||
      String(infoPedido?.tipo_pedido || '').toLowerCase() === 'delivery'
    ) {
      tipoPedido = 'Delivery';
    } else if (String(infoPedido?.tipo_pedido || '').toLowerCase() === 'pickup') {
      tipoPedido = 'Pickup';
    }
  } catch (tipoError) {
    console.error("⚠️ ERROR DETECTANDO TIPO DE PEDIDO PARA PUSH:", tipoError.message);
  }

  const payload = JSON.stringify({
    title: '🔔 Nuevo pedido recibido',
    body: `Pedido #${order.id} • ${tipoPedido} • Total $${Number(order.total || 0).toFixed(2)}`,
    url: '/',
    orderId: order.id,
    tag: `pedido-${restauranteId}-${order.id}`
  });

  let enviados = 0;
  let desactivados = 0;
  let erroresTemporales = 0;

  for (const dispositivo of result.rows) {

    const subscription = {
      endpoint: dispositivo.endpoint,
      keys: {
        p256dh: dispositivo.p256dh,
        auth: dispositivo.auth
      }
    };

    try {

      await webpush.sendNotification(subscription, payload);

      enviados++;

    } catch (error) {

      const statusCode = error.statusCode || null;

      console.error("❌ ERROR PUSH DISPOSITIVO:", {
        subscription_id: dispositivo.id,
        statusCode,
        message: error.message
      });

      // Suscripción vencida, eliminada o revocada por el dispositivo
      if (statusCode === 404 || statusCode === 410) {

        await pool.query(
          `UPDATE push_subscriptions
           SET activo = false,
               updated_at = NOW()
           WHERE id = $1
             AND restaurante_id = $2`,
          [dispositivo.id, restauranteId]
        );

        desactivados++;

      } else {

        erroresTemporales++;
      }
    }
  }

  if (enviados === 0 && erroresTemporales > 0) {
    throw new Error('No se pudo enviar la notificación push por un error temporal');
  }

  return {
    enviados,
    desactivados,
    sinDispositivos: false
  };
}

// ===============================
// 🔥 WEBHOOK WOO (CORREGIDO)
// ===============================
async function processWooOrderWebhook(req, res, restauranteId) {

  const order = req.body;

  if (!order || !order.id) {
    console.log("⚠️ WOO WEBHOOK recibido sin order.id");
    return res.status(400).json({
      success: false,
      message: "Orden inválida"
    });
  }

  if (shouldIgnoreWooOrder(order)) {
    return res.status(200).json({
      success: true,
      ignored: true,
      status: order.status
    });
  }

  // `pending` se conserva: Stripe/Woo puede publicar la orden antes de completar
  // el pago y las actualizaciones posteriores mantienen el mismo registro.

  console.log("🔥 WOO WEBHOOK:", order.id);
  invalidarCachePedidos(restauranteId);

  try {

    const items = buildWooOrderItems(order);
    const tipoPedido = detectarTipoPedidoWoo(order);
    const {
      deliveryAddress,
      deliveryCity,
      deliveryPostcode
    } = getWooDeliveryAddress(order);
    // ======================================================
    // ✅ GUARDAR ORDEN COMO YA FUNCIONA ACTUALMENTE
    // No se toca items ni refund_items
    // ======================================================
    await pool.query(
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
     customer_phone = EXCLUDED.customer_phone,
     items = EXCLUDED.items,
     refund_items = EXCLUDED.refund_items,
     tipo_pedido = EXCLUDED.tipo_pedido,
     delivery_address = EXCLUDED.delivery_address,
     delivery_city = EXCLUDED.delivery_city,
     delivery_postcode = EXCLUDED.delivery_postcode`,
  [
    restauranteId,
    order.total,
    order.status,
    order.id,
    `${order.billing?.first_name || ''} ${order.billing?.last_name || ''}`.trim() || 'Cliente',
    order.billing?.phone || '',
    JSON.stringify(items),
    JSON.stringify(order.line_items || []),
    tipoPedido,
    deliveryAddress,
    deliveryCity,
    deliveryPostcode
  ]
);

    console.log("✅ WOO GUARDADO CON ITEMS:", order.id);

    // ======================================================
    // 🔔 RESERVAR NOTIFICACIÓN SOLO UNA VEZ POR ORDEN
    // Si la orden ya notificó, este UPDATE no devuelve filas.
    // ======================================================
    const pushClaim = await pool.query(
      `UPDATE pedidos
       SET push_notified = TRUE,
           push_notified_at = NOW(),
           push_notification_error = NULL
       WHERE woo_order_id = $1
       AND restaurante_id = $2
       AND COALESCE(push_notified, FALSE) = FALSE
       RETURNING id`,
      [
        String(order.id),
        restauranteId
      ]
    );

    if (!pushClaim.rows.length) {
      console.log("🔕 PUSH OMITIDO: orden ya notificada:", order.id);
      return res.sendStatus(200);
    }

    // ======================================================
    // 🔔 ENVIAR NOTIFICACIÓN PUSH
    // Si falla, la orden sigue guardada correctamente.
    // ======================================================
    try {

      const resultadoPush = await enviarPushNuevoPedido(restauranteId, order);

      console.log("✅ PUSH NUEVO PEDIDO:", {
        order_id: order.id,
        enviados: resultadoPush.enviados,
        desactivados: resultadoPush.desactivados,
        sinDispositivos: resultadoPush.sinDispositivos
      });

      if (resultadoPush.sinDispositivos) {
        await pool.query(
          `UPDATE pedidos
           SET push_notification_error = $1
           WHERE woo_order_id = $2
           AND restaurante_id = $3`,
          [
            'No había dispositivos activos suscritos',
            String(order.id),
            restauranteId
          ]
        );
      }

    } catch (pushError) {

      console.error("❌ ERROR PUSH NUEVO PEDIDO:", pushError.message);

      // Dejamos la orden disponible para reintento si Woo vuelve a enviar actualización.
      await pool.query(
        `UPDATE pedidos
         SET push_notified = FALSE,
             push_notified_at = NULL,
             push_notification_error = $1
         WHERE woo_order_id = $2
         AND restaurante_id = $3`,
        [
          pushError.message,
          String(order.id),
          restauranteId
        ]
      );
    }

    res.sendStatus(200);

  } catch (error) {

    console.error("❌ ERROR WOO GUARDANDO ORDEN:", error);

    res.sendStatus(500);
  }
}

app.post('/webhooks/woo/:webhookToken/order', async (req, res) => {
  try {
    const config = await resolveOperationalRestaurantByToken(
      req.params.webhookToken,
      { required: ['woo_webhook_secret'] }
    );

    if (!verifyWooWebhookSignature(
      req.rawBody,
      config.woo_webhook_secret,
      req.headers['x-wc-webhook-signature']
    )) {
      return res.status(401).json({ success: false, message: 'Firma inválida' });
    }

    return processWooOrderWebhook(req, res, config.id);
  } catch (error) {
    return sendOperationalError(res, error);
  }
});

app.post('/webhook-order', async (req, res) => {
  try {
    const config = await getLegacyRestaurantOneOperationalConfig({
      required: ['woo_webhook_secret']
    });

    if (!verifyWooWebhookSignature(
      req.rawBody,
      config.woo_webhook_secret,
      req.headers['x-wc-webhook-signature']
    )) {
      return res.status(401).json({ success: false, message: 'Firma inválida' });
    }

    return processWooOrderWebhook(req, res, 1);
  } catch (error) {
    return sendOperationalError(res, error);
  }
});
// ===============================
// 🚚 WEBHOOK SHIPDAY
// ===============================
async function processShipdayWebhook(req, res, restauranteId, config) {

  const data = req.body || {};

  const driverName = data.carrier?.name || null;
  const orderNumber = data.order?.order_number || null;

  if (orderNumber === null || orderNumber === undefined || orderNumber === '') {
    return res.status(400).json({
      success: false,
      message: 'Shipday no incluyó orderNumber'
    });
  }

  const normalizedOrderNumber = String(orderNumber);

  try {

    // 🔥 1. GUARDAR DELIVERY
    await pool.query(
      `INSERT INTO deliveries 
      (restaurante_id, order_number, driver_name, status, delivery_cost, tracking_url, picked_up_at, delivered_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (restaurante_id, order_number)
      DO UPDATE SET
        driver_name = COALESCE(EXCLUDED.driver_name, deliveries.driver_name),
        status = EXCLUDED.status,
        delivery_cost = EXCLUDED.delivery_cost,
        tracking_url = EXCLUDED.tracking_url,
        picked_up_at = EXCLUDED.picked_up_at,
        delivered_at = EXCLUDED.delivered_at`,
      [
        restauranteId,
        normalizedOrderNumber,
        driverName,
        data.order_status || data.status || null,
        data.order?.delivery_fee ?? null,
        data.trackingUrl || data.tracking_url || data.order?.tracking_url || null,
        convertirFecha(data.order?.pickedup_time),
        convertirFecha(data.order?.delivery_time)
      ]
    );

    invalidarCachePedidos(restauranteId);

    console.log("🚚 SHIPDAY OK (delivery actualizado)");

    // 🔥 2. TRAER PEDIDO COMPLETO DESDE WOO
    if (normalizedOrderNumber) {

      setTimeout(async () => {

        try {

          const wooRes = await axios.get(
            `${config.woo_url}/wp-json/wc/v3/orders/${normalizedOrderNumber}`,
            {
              auth: {
                username: config.consumer_key,
                password: config.consumer_secret
              }
            }
          );

          const order = wooRes.data;

          if (!order || !order.line_items) {
            console.log("⏳ Woo aún no tiene items");
            return;
          }

          const items = buildWooOrderItems(order);
          const {
            deliveryAddress,
            deliveryCity,
            deliveryPostcode
          } = getWooDeliveryAddress(order);
          const tipoPedidoWoo = detectarTipoPedidoWoo(order);
          const tipoPedido = tipoPedidoWoo === 'delivery'
            ? tipoPedidoWoo
            : 'delivery';

          // 🔥 3. INSERTAR / ACTUALIZAR PEDIDO COMO DELIVERY
          await pool.query(
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
              delivery_postcode,
              created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
            ON CONFLICT (restaurante_id, woo_order_id)
            DO UPDATE SET
              estado = EXCLUDED.estado,
              total = EXCLUDED.total,
              customer_name = EXCLUDED.customer_name,
              customer_phone = EXCLUDED.customer_phone,
              items = EXCLUDED.items,
              refund_items = EXCLUDED.refund_items,
              tipo_pedido = EXCLUDED.tipo_pedido,
              delivery_address = EXCLUDED.delivery_address,
              delivery_city = EXCLUDED.delivery_city,
              delivery_postcode = EXCLUDED.delivery_postcode`,
            [
              restauranteId,
              order.total,
              order.status,
              String(order.id),
              `${order.billing?.first_name || ''} ${order.billing?.last_name || ''}`.trim() || 'Cliente',
              order.billing?.phone || '',
              JSON.stringify(items),
              JSON.stringify(order.line_items || []),
              tipoPedido,
              deliveryAddress,
              deliveryCity,
              deliveryPostcode
            ]
          );

          invalidarCachePedidos(restauranteId);

          console.log("🔥 PEDIDO COMPLETO GUARDADO DESDE SHIPDAY:", order.id);

          // ======================================================
          // 🔔 PUSH SI EL PEDIDO FUE CREADO DESDE SHIPDAY
          // Si Woo ya notificó, este UPDATE no devuelve filas.
          // ======================================================
          const pushClaim = await pool.query(
            `UPDATE pedidos
             SET push_notified = TRUE,
                 push_notified_at = NOW(),
                 push_notification_error = NULL
             WHERE woo_order_id = $1
             AND restaurante_id = $2
             AND COALESCE(push_notified, FALSE) = FALSE
             RETURNING id`,
            [
              String(order.id),
              restauranteId
            ]
          );

          if (!pushClaim.rows.length) {
            console.log("🔕 PUSH SHIPDAY OMITIDO: orden ya notificada:", order.id);
            return;
          }

          try {

            const resultadoPush = await enviarPushNuevoPedido(restauranteId, order);

            console.log("✅ PUSH NUEVO PEDIDO DESDE SHIPDAY:", {
              order_id: order.id,
              enviados: resultadoPush.enviados,
              desactivados: resultadoPush.desactivados,
              sinDispositivos: resultadoPush.sinDispositivos
            });

            if (resultadoPush.sinDispositivos) {
              await pool.query(
                `UPDATE pedidos
                 SET push_notification_error = $1
                 WHERE woo_order_id = $2
                 AND restaurante_id = $3`,
                [
                  'No había dispositivos activos suscritos',
                  String(order.id),
                  restauranteId
                ]
              );
            }

          } catch (pushError) {

            console.error("❌ ERROR PUSH DESDE SHIPDAY:", pushError.message);

            await pool.query(
              `UPDATE pedidos
               SET push_notified = FALSE,
                   push_notified_at = NULL,
                   push_notification_error = $1
               WHERE woo_order_id = $2
               AND restaurante_id = $3`,
              [
                pushError.message,
                String(order.id),
                restauranteId
              ]
            );
          }

        } catch (err) {
          console.log("❌ ERROR WOO DESDE SHIPDAY:", err.message);
        }

      }, 2000);
    }

    res.sendStatus(200);

  } catch (error) {
    console.error("❌ ERROR SHIPDAY:", error);
    res.sendStatus(500);
  }

}

app.post('/webhooks/shipday/:webhookToken', async (req, res) => {
  try {
    const config = await resolveOperationalRestaurantByToken(
      req.params.webhookToken,
      {
        required: [
          'shipday_webhook_secret',
          'woo_url',
          'consumer_key',
          'consumer_secret'
        ]
      }
    );

    if (!verifyShipdaySecret(req, config.shipday_webhook_secret)) {
      return res.status(401).json({ success: false, message: 'Secreto inválido' });
    }

    return processShipdayWebhook(req, res, config.id, config);
  } catch (error) {
    return sendOperationalError(res, error);
  }
});

app.post('/webhook-shipday', async (req, res) => {
  try {
    const config = await getLegacyRestaurantOneOperationalConfig({
      required: [
        'shipday_webhook_secret',
        'woo_url',
        'consumer_key',
        'consumer_secret'
      ]
    });

    if (!verifyShipdaySecret(req, config.shipday_webhook_secret)) {
      return res.status(401).json({ success: false, message: 'Secreto inválido' });
    }

    return processShipdayWebhook(req, res, 1, config);
  } catch (error) {
    return sendOperationalError(res, error);
  }
});


// ===============================
// 📡 VER SHIPDAY
// ===============================
app.get('/shipday-live', requireSessionRestaurant, (req, res) => {
  res.json(shipdayOrders.filter(order => (
    Number(order.restaurante_id) === req.restaurant.id
  )));
});

// ======================================================
// CACHE CORTO DE PEDIDOS
// Protege Supabase aunque existan apps antiguas abiertas.
// ======================================================
const cachePedidos = new Map();
const CACHE_PEDIDOS_MS = 5000;

function invalidarCachePedidos(restauranteId) {
  cachePedidos.delete(String(restauranteId));
}

// ===============================
// 🧩 UNIÓN FINAL CON CACHE
// ===============================
app.get('/orders-complete', requireSessionRestaurant, async (req, res) => {
  const restaurante_id = req.restaurant.id;
  const cacheKey = String(restaurante_id);
  const ahora = Date.now();

  // Nunca dejar que el navegador guarde una versión vieja.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');

  try {
    const cacheActual = cachePedidos.get(cacheKey);

    // Si ya hay datos recientes, Render responde sin consultar Supabase.
    if (
      cacheActual?.data &&
      ahora - cacheActual.createdAt < CACHE_PEDIDOS_MS
    ) {
      return res.json(cacheActual.data);
    }

    // Si varias tablets consultan exactamente al mismo tiempo,
    // todas esperan la misma consulta, no crean varias consultas SQL.
    if (cacheActual?.promesa) {
      const data = await cacheActual.promesa;
      return res.json(data);
    }

    const promesaConsulta = pool.query(`
      SELECT 
        p.id,
        p.woo_order_id,
        p.total,
        p.estado,
        p.customer_name,
        p.customer_phone,
        p.items,
        p.created_at,

        p.refunded,
        p.refund_amount,
        d.driver_name,

        CASE 
        WHEN d.order_number IS NOT NULL THEN 'delivery'
        WHEN p.tipo_pedido = 'delivery' THEN 'delivery'
        ELSE 'pickup'
      END AS estado_envio,

        d.delivery_cost,
        d.tracking_url,
        d.picked_up_at,
        d.delivered_at

      FROM pedidos p
      LEFT JOIN deliveries d
        ON d.restaurante_id = p.restaurante_id
       AND d.order_number::text = p.woo_order_id::text

      WHERE p.restaurante_id = $1

      ORDER BY p.created_at DESC
    `, [restaurante_id]).then(result => result.rows);

    cachePedidos.set(cacheKey, {
      data: cacheActual?.data || null,
      createdAt: cacheActual?.createdAt || 0,
      promesa: promesaConsulta
    });

    const data = await promesaConsulta;

    cachePedidos.set(cacheKey, {
      data,
      createdAt: Date.now(),
      promesa: null
    });

    return res.json(data);

  } catch (error) {
    cachePedidos.delete(cacheKey);
    console.error("❌ ERROR ORDERS-COMPLETE:", error);
    return res.status(500).send('Error join');
  }
});


app.get('/orders-latest', requireSessionRestaurant, async (req, res) => {
  try {
    const restauranteId = req.restaurant.id;

    const result = await pool.query(
      `SELECT id, woo_order_id, created_at
       FROM pedidos
       WHERE restaurante_id = $1
       ORDER BY id DESC
       LIMIT 1`,
      [restauranteId]
    );

    res.json(result.rows[0] || null);

  } catch (error) {
    console.error("❌ ERROR ÚLTIMO PEDIDO:", error);
    res.status(500).json({
      success: false,
      message: "Error consultando último pedido"
    });
  }
});

// ===============================
// 🛒 PRODUCTOS (CRUD)
// ===============================

// 📦 OBTENER PRODUCTOS
app.get('/products', requireSessionRestaurant, requireWooOperationalConfig, async (req, res) => {
  try {
    const config = req.operationalConfig;
    const response = await axios.get(
      `${config.woo_url}/wp-json/wc/v3/products?per_page=100&_=${Date.now()}`,
      {
        auth: getWooAxiosAuth(config)
      }
    );

    res.json(response.data);

  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).send('Error productos');
  }
});


// ➕ CREAR PRODUCTO
app.post('/products', requireSessionRestaurant, requireWooOperationalConfig, async (req, res) => {
  try {
    const config = req.operationalConfig;
    const response = await axios.post(
      `${config.woo_url}/wp-json/wc/v3/products`,
      req.body,
      {
        auth: getWooAxiosAuth(config)
      }
    );

    res.json(response.data);

  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).send('Error crear producto');
  }
});

// ✏️ EDITAR PRODUCTO
app.put('/products/:id', requireSessionRestaurant, requireWooOperationalConfig, async (req, res) => {
  try {
    const config = req.operationalConfig;
    const response = await axios.put(
      `${config.woo_url}/wp-json/wc/v3/products/${req.params.id}`,
      req.body,
      {
        auth: getWooAxiosAuth(config)
      }
    );

    res.json(response.data);

  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).send('Error actualizar producto');
  }
});


// ❌ ELIMINAR PRODUCTO
app.delete('/products/:id', requireSessionRestaurant, requireWooOperationalConfig, async (req, res) => {
  try {
    const config = req.operationalConfig;
    const response = await axios.delete(
      `${config.woo_url}/wp-json/wc/v3/products/${req.params.id}?force=true`,
      {
        auth: getWooAxiosAuth(config)
      }
    );

    res.json(response.data);

  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).send('Error eliminar producto');
  }
});
// ===============================
// 📂 CATEGORÍAS
// ===============================
app.get('/categories', requireSessionRestaurant, requireWooOperationalConfig, async (req, res) => {
  try {
    const config = req.operationalConfig;
    const response = await axios.get(
      `${config.woo_url}/wp-json/wc/v3/products/categories`,
      {
        auth: getWooAxiosAuth(config)
      }
    );

    res.json(response.data);

  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).send('Error categorias');
  }
});
app.get('/pedidos-db', requireSessionRestaurant, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT *
       FROM pedidos
       WHERE restaurante_id = $1
       ORDER BY created_at DESC`,
      [req.restaurant.id]
    );

    res.json(result.rows);

  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).send(error.message); // 👈 IMPORTANTE
  }
});
//LOGIN
app.post('/login', async (req, res) => {
  const email = String(req.body?.email || '').trim();
  const password = typeof req.body?.password === 'string'
    ? req.body.password
    : '';

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      message: 'Correo/usuario y contraseña son requeridos'
    });
  }

  try {
    const result = await pool.query(
      `SELECT
         u.id,
         u.email,
         u.rol,
         u.restaurante_id,
         r.id AS restaurante_existente,
         r.activo AS restaurante_activo
       FROM usuarios u
       LEFT JOIN restaurantes r ON r.id = u.restaurante_id
       WHERE u.email = $1
         AND u.password = $2
       LIMIT 1`,
      [email, password]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        success: false,
        message: 'Correo o contraseña incorrectos'
      });
    }

    const user = result.rows[0];
    const restauranteId = Number(user.restaurante_id);

    if (
      !Number.isInteger(restauranteId) ||
      restauranteId <= 0 ||
      !user.restaurante_existente
    ) {
      return res.status(403).json({
        success: false,
        message: 'El usuario no tiene un restaurante válido asignado'
      });
    }

    if (user.restaurante_activo === false) {
      return res.status(403).json({
        success: false,
        message: 'El restaurante asignado está inactivo'
      });
    }

    await regenerateSession(req);

    req.session.user_id = Number(user.id);
    req.session.email = user.email;
    req.session.rol = user.rol || 'cliente';
    req.session.restaurante_id = restauranteId;

    await saveSession(req);

    console.log('LOGIN:', user.email, 'ROL:', req.session.rol);

    return res.json({
      success: true,
      rol: req.session.rol,
      restaurante_id: restauranteId
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: 'Error iniciando sesión'
    });
  }
});

app.get('/admin', (req, res) => {
  res.sendFile(__dirname + '/admin.html');
});

app.get('/estado-restaurante', requireSessionRestaurant, async (req, res) => {

  const result = await pool.query(
    'SELECT abierto FROM restaurantes WHERE id = $1',
    [req.restaurant.id]
  );

  res.json(result.rows[0]);

});
app.post('/toggle-restaurante', requireSessionRestaurant, async (req, res) => {

  const result = await pool.query(`
    UPDATE restaurantes
    SET abierto = NOT abierto
    WHERE id = $1
    RETURNING abierto
  `, [req.restaurant.id]);

  res.json(result.rows[0]);

});

app.get('/force-order/:id', requireSessionRestaurant, requireWooOperationalConfig, async (req, res) => {
  const orderId = req.params.id;
  const restauranteId = req.restaurant.id;
  const config = req.operationalConfig;

  try {

    // 🔥 1. TRAER PEDIDO ACTUAL
    const existing = await pool.query(
      `SELECT items
       FROM pedidos
       WHERE woo_order_id = $1
         AND restaurante_id = $2`,
      [orderId, restauranteId]
    );

    if (existing.rows.length) {
      const itemsActual = existing.rows[0].items;
    }

    // 🔥 2. TRAER DESDE WOO
    const wooRes = await axios.get(
      `${config.woo_url}/wp-json/wc/v3/orders?search=${orderId}`,
      {
        auth: getWooAxiosAuth(config)
      }
    );

    const order = wooRes.data?.[0];

    if (!order) {
      return res.json({ skipped: true });
    }

    // 🔥 3. PROCESAR ITEMS
    const items = buildWooOrderItems(order);

    // 🔥 4. GUARDAR SOLO UNA VEZ
    await pool.query(
  `UPDATE pedidos 
   SET 
     customer_phone = $1,
     items = $2,
     refund_items = $3
   WHERE woo_order_id = $4
     AND restaurante_id = $5`,
  [
    // ✅ teléfono del cliente desde Woo
    order.billing?.phone || '',

    // ✅ visual actual
    JSON.stringify(items),

    // ✅ datos completos para refund parcial
    JSON.stringify(order.line_items || []),

    order.id,
    restauranteId
  ]
);

    invalidarCachePedidos(restauranteId);

console.log("⚡ FORCE ORDER:", orderId);

    res.json({ success: true });

  } catch (err) {
    console.error("❌ ERROR FORCE ORDER:", err.message);
    res.status(500).send("Error");
  }
});

app.post('/complete-order/:id', requireSessionRestaurant, requireWooOperationalConfig, async (req, res) => {
  const id = req.params.id;
  const restauranteId = req.restaurant.id;
  const config = req.operationalConfig;

  try {

    // 🔥 1. TRAER EL woo_order_id REAL
    const result = await pool.query(
      `SELECT woo_order_id
       FROM pedidos
       WHERE id = $1
         AND restaurante_id = $2`,
      [id, restauranteId]
    );

    const wooId = result.rows[0]?.woo_order_id;

    // 🔥 2. ACTUALIZAR TU BD
    await pool.query(
      `UPDATE pedidos
       SET estado = 'completed'
       WHERE id = $1
         AND restaurante_id = $2`,
      [id, restauranteId]
    );

    // 🔥 3. ACTUALIZAR WOO (CLAVE)
    if (wooId) {
      await axios.put(
        `${config.woo_url}/wp-json/wc/v3/orders/${wooId}`,
        {
          status: 'completed'
        },
        {
          auth: getWooAxiosAuth(config)
        }
      );
    }

    console.log("✅ COMPLETADO LOCAL + WOO:", id);

    invalidarCachePedidos(restauranteId);

    res.json({ success: true });

  } catch (error) {
    console.error("❌ ERROR COMPLETAR:", error);
    res.status(500).send("Error");
  }
});
app.post('/admin/restaurantes', async (req, res) => {

  const { nombre, logo_url, woo_url, consumer_key, consumer_secret, shipday_api } = req.body;

  if (!String(nombre || '').trim()) {
    return res.status(400).json({
      success: false,
      message: 'El nombre del restaurante es requerido'
    });
  }

  try {

    await pool.query(
      `INSERT INTO restaurantes 
      (nombre, logo_url, woo_url, consumer_key, consumer_secret, shipday_api)
      VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        String(nombre).trim(),
        logo_url || null,
        woo_url || null,
        consumer_key || null,
        consumer_secret || null,
        shipday_api || null
      ]
    );

    res.status(201).json({ success: true });

  } catch (err) {
    console.error('Error creando restaurante:', err.message);
    res.status(500).json({
      success: false,
      message: 'Error creando restaurante'
    });
  }

});
app.get('/admin/restaurantes', async (req, res) => {

  try {
    const result = await pool.query(
      `SELECT
         id,
         nombre,
         logo_url,
         woo_url,
         activo,
         created_at,
         updated_at,
         consumer_key,
         consumer_secret,
         shipday_api,
         webhook_token,
         woo_webhook_secret,
         shipday_webhook_secret
       FROM restaurantes
       ORDER BY id DESC`
    );

    res.json(result.rows.map(restaurant => ({
      id: restaurant.id,
      nombre: restaurant.nombre,
      logo_url: restaurant.logo_url,
      woo_url: restaurant.woo_url,
      activo: restaurant.activo !== false,
      created_at: restaurant.created_at,
      updated_at: restaurant.updated_at,
      consumer_key: maskSecret(restaurant.consumer_key),
      consumer_secret: maskSecret(restaurant.consumer_secret),
      shipday_api: maskSecret(restaurant.shipday_api),
      webhook_token: maskSecret(restaurant.webhook_token),
      woo_webhook_secret: maskSecret(restaurant.woo_webhook_secret),
      shipday_webhook_secret: maskSecret(restaurant.shipday_webhook_secret)
    })));
  } catch (error) {
    console.error('Error listando restaurantes:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error listando restaurantes'
    });
  }

});

app.put('/admin/restaurantes/:id', async (req, res) => {
  const restauranteId = Number(req.params.id);

  if (!Number.isInteger(restauranteId) || restauranteId <= 0) {
    return res.status(400).json({ success: false, message: 'Restaurante inválido' });
  }

  const updates = [];
  const values = [];
  const addValue = (column, value) => {
    values.push(value);
    updates.push(`${column} = $${values.length}`);
  };

  if (Object.prototype.hasOwnProperty.call(req.body, 'nombre')) {
    const nombre = String(req.body.nombre || '').trim();
    if (!nombre) {
      return res.status(400).json({ success: false, message: 'El nombre es requerido' });
    }
    addValue('nombre', nombre);
  }

  for (const field of ['logo_url', 'woo_url']) {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      addValue(field, String(req.body[field] || '').trim() || null);
    }
  }

  for (const field of [
    'consumer_key',
    'consumer_secret',
    'shipday_api',
    'webhook_token',
    'woo_webhook_secret',
    'shipday_webhook_secret'
  ]) {
    if (!Object.prototype.hasOwnProperty.call(req.body, field)) continue;
    const secret = String(req.body[field] || '').trim();
    if (!secret || secret.includes('*')) continue;
    addValue(field, secret);
  }

  if (Object.prototype.hasOwnProperty.call(req.body, 'activo')) {
    addValue('activo', req.body.activo === true || req.body.activo === 'true');
  }

  if (!updates.length) {
    return res.status(400).json({ success: false, message: 'No hay cambios válidos' });
  }

  values.push(restauranteId);

  try {
    const result = await pool.query(
      `UPDATE restaurantes
       SET ${updates.join(', ')},
           updated_at = NOW()
       WHERE id = $${values.length}
       RETURNING id, nombre, logo_url, woo_url, activo`,
      values
    );

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'Restaurante no encontrado' });
    }

    return res.json({ success: true, restaurante: result.rows[0] });
  } catch (error) {
    console.error('Error actualizando restaurante:', error.message);
    return res.status(500).json({ success: false, message: 'Error actualizando restaurante' });
  }
});

app.post('/admin/restaurantes/:id/generar-secretos', async (req, res) => {
  const restauranteId = Number(req.params.id);
  const allowedFields = new Set([
    'webhook_token',
    'woo_webhook_secret',
    'shipday_webhook_secret'
  ]);
  const requestedFields = Array.isArray(req.body?.fields)
    ? Array.from(new Set(req.body.fields.filter(field => allowedFields.has(field))))
    : Array.from(allowedFields);

  if (!Number.isInteger(restauranteId) || restauranteId <= 0) {
    return res.status(400).json({ success: false, message: 'Restaurante inválido' });
  }

  if (!requestedFields.length) {
    return res.status(400).json({ success: false, message: 'No hay secretos válidos para generar' });
  }

  const values = requestedFields.map(() => crypto.randomBytes(32).toString('hex'));
  const assignments = requestedFields.map((field, index) => `${field} = $${index + 1}`);
  values.push(restauranteId);

  try {
    const result = await pool.query(
      `UPDATE restaurantes
       SET ${assignments.join(', ')},
           updated_at = NOW()
       WHERE id = $${values.length}
       RETURNING id, webhook_token, woo_webhook_secret, shipday_webhook_secret`,
      values
    );

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'Restaurante no encontrado' });
    }

    const restaurant = result.rows[0];
    return res.json({
      success: true,
      restaurante: {
        id: restaurant.id,
        webhook_token: maskSecret(restaurant.webhook_token),
        woo_webhook_secret: maskSecret(restaurant.woo_webhook_secret),
        shipday_webhook_secret: maskSecret(restaurant.shipday_webhook_secret)
      }
    });
  } catch (error) {
    console.error('Error generando secretos:', error.message);
    return res.status(500).json({ success: false, message: 'Error generando secretos' });
  }
});

app.post('/admin/usuarios', async (req, res) => {

  const { email, password, restaurante_id } = req.body;
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPassword = typeof password === 'string' ? password : '';
  const restauranteId = Number(restaurante_id);

  const emailOrUserIsValid =
    cleanEmail.length >= 3 &&
    cleanEmail.length <= 254 &&
    /^[a-z0-9._@+\-]+$/i.test(cleanEmail) &&
    (!cleanEmail.includes('@') || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail));

  if (!emailOrUserIsValid) {
    return res.status(400).json({
      success: false,
      message: 'El correo o usuario no es válido'
    });
  }

  if (cleanPassword.length < 8) {
    return res.status(400).json({
      success: false,
      message: 'La contraseña debe tener al menos 8 caracteres'
    });
  }

  if (!Number.isInteger(restauranteId) || restauranteId <= 0) {
    return res.status(400).json({
      success: false,
      message: 'El restaurante seleccionado no es válido'
    });
  }

  try {

    const restaurantResult = await pool.query(
      `SELECT id
       FROM restaurantes
       WHERE id = $1
         AND activo IS NOT FALSE
       LIMIT 1`,
      [restauranteId]
    );

    if (!restaurantResult.rows.length) {
      return res.status(400).json({
        success: false,
        message: 'El restaurante no existe o está inactivo'
      });
    }

    await pool.query(
      `INSERT INTO usuarios (email, password, restaurante_id)
       VALUES ($1, $2, $3)`,
      [cleanEmail, cleanPassword, restauranteId]
    );

    res.status(201).json({ success: true });

  } catch (err) {
    console.error('Error creando usuario:', err.message);
    res.status(500).json({
      success: false,
      message: 'Error creando usuario'
    });
  }

});

app.get('/admin/usuarios', async (req, res) => {

  const result = await pool.query(`
    SELECT u.id, u.email, u.restaurante_id, r.nombre 
    FROM usuarios u
    LEFT JOIN restaurantes r ON r.id = u.restaurante_id
    ORDER BY u.id DESC
  `);

  res.json(result.rows);

});

app.post('/refund', requireSessionRestaurant, requireWooOperationalConfig, async (req, res) => {

  const { woo_order_id, orderId, amount } = req.body;
  const restauranteId = req.restaurant.id;
  const config = req.operationalConfig;

  // ✅ Acepta ambos nombres por seguridad
  const finalOrderId = woo_order_id || orderId;

  try {

    console.log("💸 REFUND REQUEST:", {
      finalOrderId,
      amount
    });

    if (!finalOrderId || !amount || Number(amount) <= 0) {
      return res.json({
        success: false,
        message: "Datos inválidos para reembolso"
      });
    }

    // ✅ 1. Verificar pedido en tu DB
    const pedido = await pool.query(
      `SELECT woo_order_id, refunded, refund_amount, total
       FROM pedidos
       WHERE woo_order_id = $1
         AND restaurante_id = $2`,
      [String(finalOrderId), restauranteId]
    );

    if (!pedido.rows.length) {
      return res.json({
        success: false,
        message: "Pedido no encontrado en la base de datos"
      });
    }

    if (pedido.rows[0].refunded) {
      return res.json({
        success: false,
        message: "Este pedido ya fue reembolsado"
      });
    }

    // ✅ 2. Verificar orden en Woo
    const orderUrl = `${config.woo_url}/wp-json/wc/v3/orders/${finalOrderId}`;
    console.log("🔎 ORDER URL:", orderUrl);

    const wooRes = await axios.get(
      orderUrl,
      {
        auth: getWooAxiosAuth(config)
      }
    );

    const order = wooRes.data;

    if (!order) {
      return res.json({
        success: false,
        message: "Orden no encontrada en WooCommerce"
      });
    }

    // ✅ 3. Crear refund en Woo
    const refundUrl = `${config.woo_url}/wp-json/wc/v3/orders/${finalOrderId}/refunds`;
    console.log("🔗 REFUND URL:", refundUrl);

    const refundRes = await axios.post(
      refundUrl,
      {
        amount: Number(amount).toFixed(2),
        reason: "Reembolso desde dashboard",
        api_refund: true
      },
      {
        auth: getWooAxiosAuth(config)
      }
    );

    console.log("✅ WOO REFUND OK:", refundRes.data);

    // ✅ 4. Guardar refund en DB solo si Woo respondió OK
    await pool.query(
      `UPDATE pedidos
       SET refunded = true,
           refund_amount = $1
       WHERE woo_order_id = $2
         AND restaurante_id = $3`,
      [
        Number(amount).toFixed(2),
        String(finalOrderId),
        restauranteId
      ]
    );

    invalidarCachePedidos(restauranteId);

    res.json({
      success: true,
      refund: refundRes.data
    });

  } catch (error) {

    const wooError = error.response?.data || error.message;

    console.error("❌ ERROR REFUND DETALLE:", wooError);

    res.json({
      success: false,
      message:
        wooError?.message ||
        wooError?.data?.message ||
        "Error en reembolso",
      error: wooError
    });
  }

});

app.get('/refund-data/:woo_order_id', requireSessionRestaurant, async (req, res) => {
  const wooOrderId = req.params.woo_order_id;

  try {
    const result = await pool.query(
      `SELECT woo_order_id, total, refund_items
       FROM pedidos
       WHERE woo_order_id = $1
         AND restaurante_id = $2`,
      [wooOrderId, req.restaurant.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: 'Pedido no encontrado en base de datos'
      });
    }

    const pedido = result.rows[0];

    const rawItems = typeof pedido.refund_items === 'string'
      ? JSON.parse(pedido.refund_items)
      : pedido.refund_items;

    if (!rawItems || !rawItems.length) {
      return res.json({
        success: false,
        message: 'Este pedido todavía no tiene datos completos para refund parcial'
      });
    }

    const items = rawItems.map(item => {
      const quantity = Number(item.quantity || 1);

      const lineTotal = Number(item.total || 0);
      const lineTax = Number(item.total_tax || 0);

      const refundTotal = lineTotal + lineTax;
      const unitRefund = quantity > 0 ? refundTotal / quantity : refundTotal;

      const extras = (item.meta_data || [])
        .filter(m => {
          const key = String(m.key || '');
          const value = String(m.value || m.display_value || '');

          if (!value) return false;
          if (key.includes('_wapf')) return false;
          if (value.includes('[object Object]')) return false;

          return true;
        })
        .map(m => ({
          key: m.display_key || m.key,
          value: m.display_value || m.value
        }));

      return {
        line_item_id: item.id,
        name: item.name,
        quantity,
        total: Number(lineTotal.toFixed(2)),
        tax: Number(lineTax.toFixed(2)),
        refund_total: Number(refundTotal.toFixed(2)),
        unit_refund: Number(unitRefund.toFixed(2)),
        extras
      };
    });

    res.json({
      success: true,
      woo_order_id: pedido.woo_order_id,
      order_total: Number(pedido.total || 0),
      items
    });

  } catch (error) {
    console.error('❌ ERROR REFUND DATA LOCAL:', error.message);

    res.status(500).json({
      success: false,
      message: 'Error obteniendo productos para refund parcial',
      error: error.message
    });
  }
});


app.post('/acciones-woo', requireSessionRestaurant, async (req, res) => {
  try {
    const restaurante_id = req.restaurant.id;
    const { tipo, woo_product_id, payload } = req.body;

    if (!tipo) {
      return res.status(400).json({
        success: false,
        message: "Falta tipo de acción"
      });
    }

    const result = await pool.query(
      `INSERT INTO acciones_woo
        (restaurante_id, tipo, woo_product_id, payload, estado, created_at, updated_at)
       VALUES
        ($1, $2, $3, $4, 'pending', NOW(), NOW())
       RETURNING *`,
      [
        restaurante_id,
        tipo,
        woo_product_id ? String(woo_product_id) : null,
        JSON.stringify(payload || {})
      ]
    );

    res.json({
      success: true,
      accion: result.rows[0]
    });

  } catch (error) {
    console.error("❌ ERROR CREANDO ACCIÓN WOO:", error.message);

    res.status(500).json({
      success: false,
      message: "Error creando acción",
      error: error.message
    });
  }
});

async function sendPendingWooActions(res, restauranteId) {
  try {
    const result = await pool.query(
      `SELECT *
       FROM acciones_woo
       WHERE restaurante_id = $1
         AND estado = 'pending'
       ORDER BY created_at ASC
       LIMIT 10`,
      [restauranteId]
    );

    return res.json({
      success: true,
      acciones: result.rows
    });
  } catch (error) {
    console.error("❌ ERROR ACCIONES PENDIENTES:", error.message);
    return res.status(500).json({
      success: false,
      message: "Error obteniendo acciones pendientes"
    });
  }
}

async function saveWooActionResult(req, res, restauranteId, actionId) {
  try {
    const { success, resultado, error } = req.body;
    const nuevoEstado = success ? 'completed' : 'failed';

    const result = await pool.query(
      `UPDATE acciones_woo
       SET estado = $1,
           resultado = $2,
           error = $3,
           updated_at = NOW(),
           completed_at = NOW()
       WHERE id = $4
         AND restaurante_id = $5
       RETURNING *`,
      [
        nuevoEstado,
        JSON.stringify(resultado || {}),
        error || null,
        actionId,
        restauranteId
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: 'Acción no encontrada'
      });
    }

    return res.json({ success: true, accion: result.rows[0] });
  } catch (error) {
    console.error("❌ ERROR RESULTADO ACCIÓN:", error.message);
    return res.status(500).json({
      success: false,
      message: "Error guardando resultado"
    });
  }
}

app.get('/bridge/:webhookToken/actions', async (req, res) => {
  try {
    const config = await resolveOperationalRestaurantByToken(req.params.webhookToken);
    return sendPendingWooActions(res, config.id);
  } catch (error) {
    return sendOperationalError(res, error);
  }
});

app.post('/bridge/:webhookToken/actions/:actionId/result', async (req, res) => {
  try {
    const config = await resolveOperationalRestaurantByToken(req.params.webhookToken);
    return saveWooActionResult(req, res, config.id, req.params.actionId);
  } catch (error) {
    return sendOperationalError(res, error);
  }
});

app.get('/acciones-woo-pendientes', async (req, res) => {
  try {
    const config = await getLegacyRestaurantOneOperationalConfig();
    const validSecret =
      safeEqualText(req.query.secret, config.webhook_token) ||
      safeEqualText(req.query.secret, config.woo_webhook_secret);

    if (!validSecret) {
      return res.status(401).json({ success: false, message: 'No autorizado' });
    }

    return sendPendingWooActions(res, 1);
  } catch (error) {
    return sendOperationalError(res, error);
  }
});

app.post('/acciones-woo/:id/resultado', async (req, res) => {
  try {
    const config = await getLegacyRestaurantOneOperationalConfig();
    const validSecret =
      safeEqualText(req.query.secret, config.webhook_token) ||
      safeEqualText(req.query.secret, config.woo_webhook_secret);

    if (!validSecret) {
      return res.status(401).json({ success: false, message: 'No autorizado' });
    }

    return saveWooActionResult(req, res, 1, req.params.id);
  } catch (error) {
    return sendOperationalError(res, error);
  }
});

// 🔔 Entregar clave pública para suscribir dispositivos
app.get('/push-public-key', (req, res) => {
  if (!VAPID_PUBLIC_KEY) {
    return res.status(500).json({
      success: false,
      message: 'VAPID_PUBLIC_KEY no configurada'
    });
  }

  res.json({
    success: true,
    publicKey: VAPID_PUBLIC_KEY
  });
});

// ======================================================
// 🔔 GUARDAR SUSCRIPCIÓN PUSH DEL DISPOSITIVO
// ======================================================
app.post('/push-subscribe', requireSessionRestaurant, async (req, res) => {
  try {
    const restaurante_id = req.restaurant.id;
    const subscription = req.body;

    if (
      !subscription ||
      !subscription.endpoint ||
      !subscription.keys ||
      !subscription.keys.p256dh ||
      !subscription.keys.auth
    ) {
      return res.status(400).json({
        success: false,
        message: 'Suscripción push inválida'
      });
    }

    await pool.query(
      `INSERT INTO push_subscriptions
        (
          restaurante_id,
          endpoint,
          p256dh,
          auth,
          user_agent,
          activo,
          updated_at
        )
       VALUES
        ($1, $2, $3, $4, $5, true, NOW())
       ON CONFLICT (endpoint)
       DO UPDATE SET
          restaurante_id = EXCLUDED.restaurante_id,
          p256dh = EXCLUDED.p256dh,
          auth = EXCLUDED.auth,
          user_agent = EXCLUDED.user_agent,
          activo = true,
          updated_at = NOW()`,
      [
        restaurante_id,
        subscription.endpoint,
        subscription.keys.p256dh,
        subscription.keys.auth,
        req.headers['user-agent'] || null
      ]
    );

    console.log('🔔 Dispositivo suscrito a push:', {
      restaurante_id,
      endpoint: subscription.endpoint.substring(0, 45) + '...'
    });

    res.json({
      success: true,
      message: 'Notificaciones activadas correctamente'
    });

  } catch (error) {
    console.error('❌ ERROR GUARDANDO PUSH SUBSCRIPTION:', error.message);

    res.status(500).json({
      success: false,
      message: 'Error activando notificaciones'
    });
  }
});

// ======================================================
// 🔕 DESACTIVAR SUSCRIPCIÓN PUSH DEL DISPOSITIVO
// ======================================================
app.post('/push-unsubscribe', requireSessionRestaurant, async (req, res) => {
  try {
    const restaurante_id = req.restaurant.id;
    const { endpoint } = req.body;

    if (!endpoint) {
      return res.status(400).json({
        success: false,
        message: 'Falta endpoint de suscripción'
      });
    }

    await pool.query(
      `UPDATE push_subscriptions
       SET activo = false,
           updated_at = NOW()
       WHERE endpoint = $1
         AND restaurante_id = $2`,
      [endpoint, restaurante_id]
    );

    res.json({
      success: true,
      message: 'Notificaciones desactivadas'
    });

  } catch (error) {
    console.error('❌ ERROR DESACTIVANDO PUSH:', error.message);

    res.status(500).json({
      success: false,
      message: 'Error desactivando notificaciones'
    });
  }
});

// ======================================================
// 🧪 ENVIAR NOTIFICACIÓN PUSH DE PRUEBA
// ======================================================
app.post('/push-test', requireSessionRestaurant, async (req, res) => {
  try {
    const restaurante_id = req.restaurant.id;

    const result = await pool.query(
      `SELECT id, endpoint, p256dh, auth
       FROM push_subscriptions
       WHERE restaurante_id = $1
       AND activo = true`,
      [restaurante_id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: 'No hay dispositivos suscritos para este restaurante'
      });
    }

    const payload = JSON.stringify({
      title: '🔔 Notificación Denix activada',
      body: 'Tu dispositivo ya puede recibir alertas de nuevos pedidos.',
      url: '/',
      tag: `denix-prueba-notificaciones-${restaurante_id}`
    });

    let enviados = 0;
    let desactivados = 0;

    for (const dispositivo of result.rows) {
      const subscription = {
        endpoint: dispositivo.endpoint,
        keys: {
          p256dh: dispositivo.p256dh,
          auth: dispositivo.auth
        }
      };

      try {
        await webpush.sendNotification(subscription, payload);
        enviados++;

      } catch (error) {
        console.error('❌ ERROR ENVIANDO PUSH:', error.statusCode || error.message);

        // Si la suscripción ya no existe o fue revocada, la desactivamos.
        if (error.statusCode === 404 || error.statusCode === 410) {
          await pool.query(
            `UPDATE push_subscriptions
             SET activo = false,
                 updated_at = NOW()
             WHERE id = $1
               AND restaurante_id = $2`,
            [dispositivo.id, restaurante_id]
          );

          desactivados++;
        }
      }
    }

    res.json({
      success: true,
      enviados,
      desactivados
    });

  } catch (error) {
    console.error('❌ ERROR PUSH TEST:', error.message);

    res.status(500).json({
      success: false,
      message: 'Error enviando notificación de prueba'
    });
  }
});

// 🚀 START
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});

app.get('/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).send('Error conexión DB');
  }

}); 

