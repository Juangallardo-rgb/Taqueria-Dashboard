function convertirFecha(timestamp) {
  if (!timestamp) return null;
  return new Date(Number(timestamp));
}
require('dotenv').config();
const pool = require('./database');

const axios = require('axios');
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 4000;
// 🔐 CLAVES (modo desarrollo)
const WOO_URL = process.env.WOO_URL;
const CONSUMER_KEY = process.env.WOO_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.WOO_CONSUMER_SECRET;

// 🧠 MEMORIA
let wooOrders = [];
let shipdayOrders = [];

const session = require('express-session');

app.use(session({
  secret: 'secreto-super', // puedes cambiarlo luego
  resave: false,
  saveUninitialized: true,
  cookie: {
    secure: false // ⚠️ en Render está bien así
  }
}));

// 🏠 HOME
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 🖥️ DASHBOARD
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});


// ===============================
// 📦 WOO ORDERS
// ===============================
// ===============================
// 🔥 GET WOO ORDERS (OPTIMIZADO)
// ===============================
app.get('/woo-orders', async (req, res) => {
  try {
    if (!WOO_URL || !CONSUMER_KEY || !CONSUMER_SECRET) {
      console.error("❌ Faltan variables de WooCommerce:", {
        WOO_URL: !!WOO_URL,
        WOO_CONSUMER_KEY: !!CONSUMER_KEY,
        WOO_CONSUMER_SECRET: !!CONSUMER_SECRET
      });

      return res.status(500).json({
        message: "Faltan variables de entorno de WooCommerce"
      });
    }

    const cleanWooUrl = WOO_URL.replace(/\/$/, '');

    const response = await axios.get(
      `${cleanWooUrl}/wp-json/wc/v3/orders`,
      {
        params: {
          per_page: 20,
          consumer_key: CONSUMER_KEY,
          consumer_secret: CONSUMER_SECRET
        },
        headers: {
        'Accept': 'application/json',
        'User-Agent': 'Taqueria-Dashboard/1.0'
        },
        timeout: 20000
      }
    );

    const wooOrders = response.data.map(order => {
      const esPickup = order.shipping_lines?.some(
        l => l.method_id === 'local_pickup'
      );

      return {
        id: order.id,
        total: order.total,
        estado: order.status,

        customer_name: `${order.billing?.first_name || ''} ${order.billing?.last_name || ''}`.trim() || 'Cliente',

        direccion: order.shipping?.address_1 || order.billing?.address_1 || '',
        ciudad: order.shipping?.city || order.billing?.city || '',

        estado_envio: esPickup ? 'pickup' : 'delivery',

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
    console.error("❌ ERROR WOO STATUS:", error.response?.status);
    console.error("❌ ERROR WOO DATA:", error.response?.data || error.message);

    res.status(500).json({
      message: "Error WooCommerce",
      status: error.response?.status || null,
      error: error.message,
      data: error.response?.data || null
    });
  }
});


// ===============================
// 🔥 WEBHOOK WOO (CORREGIDO)
// ===============================
app.post('/webhook-order', async (req, res) => {

  const order = req.body;

  console.log("🔥 WOO WEBHOOK:", order.id);

  try {

    const items = (order.line_items || []).map(i => {

      const extras = (i.meta_data || [])
        .filter(m => m.value && m.value !== '')
        .map(m => `${m.key}: ${m.value}`)
        .join(', ');

      return {
        nombre: `${i.name}${extras ? ` (${extras})` : ''}`,
        cantidad: i.quantity
      };
    });

    await pool.query(
  `INSERT INTO pedidos 
   (restaurante_id, total, estado, woo_order_id, customer_name, customer_phone, items, refund_items)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
   ON CONFLICT (woo_order_id)
   DO UPDATE SET
     estado = EXCLUDED.estado,
     total = EXCLUDED.total,
     customer_name = EXCLUDED.customer_name,
     customer_phone = EXCLUDED.customer_phone,
     items = EXCLUDED.items,
     refund_items = EXCLUDED.refund_items`,
  [
    1,
    order.total,
    order.status,
    order.id,
    `${order.billing?.first_name || ''} ${order.billing?.last_name || ''}`.trim() || 'Cliente',
    order.billing?.phone || '',
    JSON.stringify(items),
    JSON.stringify(order.line_items || [])
  ]
);

    console.log("✅ WOO GUARDADO CON ITEMS");

    res.sendStatus(200);

  } catch (error) {
    console.error("❌ ERROR WOO:", error);
    res.sendStatus(500);
  }

});
// ===============================
// 🚚 WEBHOOK SHIPDAY
// ===============================
app.post('/webhook-shipday', async (req, res) => {

  const data = req.body;

  const driverName = data.carrier?.name || null;
  const orderNumber = data.order?.order_number || null;

  function convertirFecha(timestamp) {
    if (!timestamp) return null;
    return new Date(Number(timestamp));
  }

  try {

    // 🔥 1. GUARDAR DELIVERY (COMO YA TENÍAS)
    await pool.query(
      `INSERT INTO deliveries 
      (order_number, driver_name, status, delivery_cost, tracking_url, picked_up_at, delivered_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (order_number)
      DO UPDATE SET
        driver_name = COALESCE(EXCLUDED.driver_name, deliveries.driver_name),
        status = EXCLUDED.status,
        delivery_cost = EXCLUDED.delivery_cost,
        tracking_url = EXCLUDED.tracking_url,
        picked_up_at = EXCLUDED.picked_up_at,
        delivered_at = EXCLUDED.delivered_at`,
      [
        String(orderNumber),
        driverName,
        data.order_status,
        data.order?.delivery_fee || null,
        data.trackingUrl,
        convertirFecha(data.order?.pickedup_time),
        convertirFecha(data.order?.delivery_time)
      ]
    );

    console.log("🚚 SHIPDAY OK (delivery actualizado)");

    // 🔥 2. TRAER PEDIDO COMPLETO DESDE WOO (RÁPIDO)
    if (orderNumber) {

      setTimeout(async () => {

        try {

          const wooRes = await axios.get(
            `${WOO_URL}/wp-json/wc/v3/orders/${orderNumber}`,
            {
              auth: {
                username: CONSUMER_KEY,
                password: CONSUMER_SECRET
              }
            }
          );

          const order = wooRes.data;

          if (!order || !order.line_items) {
            console.log("⏳ Woo aún no tiene items");
            return;
          }

          const items = order.line_items.map(i => {

            const extras = (i.meta_data || [])
              .filter(m => m.value && m.value !== '')
              .map(m => `${m.key}: ${m.value}`)
              .join(', ');

            return {
              nombre: `${i.name}${extras ? ` (${extras})` : ''}`,
              cantidad: i.quantity
            };
          });

          // 🔥 3. INSERTAR PEDIDO COMPLETO (UNA SOLA VEZ)
await pool.query(
  `INSERT INTO pedidos 
  (restaurante_id, total, estado, woo_order_id, customer_name, customer_phone, items, refund_items, created_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
  ON CONFLICT (woo_order_id)
  DO UPDATE SET
    estado = EXCLUDED.estado,
    total = EXCLUDED.total,
    customer_name = EXCLUDED.customer_name,
    customer_phone = EXCLUDED.customer_phone,
    items = EXCLUDED.items,
    refund_items = EXCLUDED.refund_items`,
  [
    1,
    order.total,
    order.status,
    order.id,
    `${order.billing?.first_name || ''} ${order.billing?.last_name || ''}`.trim() || 'Cliente',
    order.billing?.phone || '',
    JSON.stringify(items),
    JSON.stringify(order.line_items || [])
  ]
);

          console.log("🔥 PEDIDO COMPLETO GUARDADO DESDE SHIPDAY");

        } catch (err) {
          console.log("❌ ERROR WOO DESDE SHIPDAY:", err.message);
        }

      }, 2000); // 🔥 pequeño delay para que Woo esté listo
    }

    res.sendStatus(200);

  } catch (error) {
    console.error("❌ ERROR SHIPDAY:", error);
    res.sendStatus(500);
  }

});


// ===============================
// 📡 VER SHIPDAY
// ===============================
app.get('/shipday-live', (req, res) => {
  res.json(shipdayOrders);
});


// ===============================
// 🧩 UNIÓN FINAL
// ===============================
app.get('/orders-complete', async (req, res) => {
  try {

    // 🔥 OBTENER RESTAURANTE ACTUAL (SAFE)
    const restaurante_id = req.session?.restaurante_id || 1;

    const result = await pool.query(`
      SELECT 
        p.id,
        p.woo_order_id,
        p.total,
        p.estado,
        p.customer_name,
        p.customer_phone,
        p.items,
        p.created_at,

        -- 🔥 REFUND
        p.refunded,
        p.refund_amount,
        d.driver_name,

        CASE 
          WHEN d.order_number IS NULL THEN 'pickup'
          ELSE 'delivery'
        END AS estado_envio,

        d.delivery_cost,
        d.tracking_url,
        d.picked_up_at,
        d.delivered_at

      FROM pedidos p
      LEFT JOIN deliveries d
        ON d.order_number = p.woo_order_id

      WHERE p.restaurante_id = $1

      ORDER BY p.created_at DESC
    `, [restaurante_id]);

    res.json(result.rows);

  } catch (error) {
    console.error(error);
    res.status(500).send('Error join');
  }
});

// ===============================
// 🛒 PRODUCTOS (CRUD)
// ===============================

// 📦 OBTENER PRODUCTOS
app.get('/products', async (req, res) => {
  try {
    const response = await axios.get(
      `${WOO_URL}/wp-json/wc/v3/products?per_page=100&_=${Date.now()}`,
      {
        auth: {
          username: CONSUMER_KEY,
          password: CONSUMER_SECRET
        }
      }
    );

    res.json(response.data);

  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).send('Error productos');
  }
});


// ➕ CREAR PRODUCTO
app.post('/products', async (req, res) => {
  try {
    const response = await axios.post(
      `${WOO_URL}/wp-json/wc/v3/products`,
      req.body,
      {
        auth: {
          username: CONSUMER_KEY,
          password: CONSUMER_SECRET
        }
      }
    );

    res.json(response.data);

  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).send('Error crear producto');
  }
});

// ✏️ EDITAR PRODUCTO
app.put('/products/:id', async (req, res) => {
  try {
    const response = await axios.put(
      `${WOO_URL}/wp-json/wc/v3/products/${req.params.id}`,
      req.body,
      {
        auth: {
          username: CONSUMER_KEY,
          password: CONSUMER_SECRET
        }
      }
    );

    res.json(response.data);

  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).send('Error actualizar producto');
  }
});


// ❌ ELIMINAR PRODUCTO
app.delete('/products/:id', async (req, res) => {
  try {
    const response = await axios.delete(
      `${WOO_URL}/wp-json/wc/v3/products/${req.params.id}?force=true`,
      {
        auth: {
          username: CONSUMER_KEY,
          password: CONSUMER_SECRET
        }
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
app.get('/categories', async (req, res) => {
  try {
    const response = await axios.get(
      `${WOO_URL}/wp-json/wc/v3/products/categories`,
      {
        auth: {
          username: CONSUMER_KEY,
          password: CONSUMER_SECRET
        }
      }
    );

    res.json(response.data);

  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).send('Error categorias');
  }
});
app.get('/pedidos-db', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM pedidos ORDER BY created_at DESC"
    );

    res.json(result.rows);

  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).send(error.message); // 👈 IMPORTANTE
  }
});
//LOGIN
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query(
      'SELECT * FROM usuarios WHERE email = $1 AND password = $2',
      [email, password]
    );

    if (result.rows.length > 0) {

      const user = result.rows[0];

      req.session.restaurante_id = user.restaurante_id || 1;
      req.session.rol = user.rol || 'cliente';

      console.log("LOGIN:", user.email, "ROL:", user.rol);

      res.json({
        success: true,
        rol: user.rol
      });

    } else {
      res.json({ success: false });
    }

  } catch (error) {
    console.error(error);
    res.status(500).send('Error login');
  }
});

app.get('/admin', (req, res) => {

  if (req.session.rol !== 'admin') {
    return res.send("No autorizado");
  }

  res.sendFile(__dirname + '/admin.html');
});

app.get('/estado-restaurante', async (req, res) => {

  const result = await pool.query(
    'SELECT abierto FROM restaurantes WHERE id = 1'
  );

  res.json(result.rows[0]);

});
app.post('/toggle-restaurante', async (req, res) => {

  const result = await pool.query(`
    UPDATE restaurantes
    SET abierto = NOT abierto
    WHERE id = 1
    RETURNING abierto
  `);

  res.json(result.rows[0]);

});

app.get('/force-order/:id', async (req, res) => {
  const orderId = req.params.id;

  try {

    // 🔥 1. TRAER PEDIDO ACTUAL
    const existing = await pool.query(
      `SELECT items FROM pedidos WHERE woo_order_id = $1`,
      [orderId]
    );

    if (existing.rows.length) {
      const itemsActual = existing.rows[0].items;
    }

    // 🔥 2. TRAER DESDE WOO
    const wooRes = await axios.get(
      `${WOO_URL}/wp-json/wc/v3/orders?search=${orderId}`,
      {
        auth: {
          username: CONSUMER_KEY,
          password: CONSUMER_SECRET
        }
      }
    );

    const order = wooRes.data?.[0];

    if (!order) {
      return res.json({ skipped: true });
    }

    // 🔥 3. PROCESAR ITEMS
    const items = (order.line_items || []).map(i => {

      const extras = (i.meta_data || [])
        .filter(m => m.value && m.value !== '')
        .map(m => `${m.key}: ${m.value}`)
        .join(', ');

      return {
        nombre: `${i.name}${extras ? ` (${extras})` : ''}`,
        cantidad: i.quantity
      };
    });

    // 🔥 4. GUARDAR SOLO UNA VEZ
    await pool.query(
  `UPDATE pedidos 
   SET 
     customer_phone = $1,
     items = $2,
     refund_items = $3
   WHERE woo_order_id = $4`,
  [
    // ✅ teléfono del cliente desde Woo
    order.billing?.phone || '',

    // ✅ visual actual
    JSON.stringify(items),

    // ✅ datos completos para refund parcial
    JSON.stringify(order.line_items || []),

    order.id
  ]
);

console.log("⚡ FORCE ORDER:", orderId);

    res.json({ success: true });

  } catch (err) {
    console.error("❌ ERROR FORCE ORDER:", err.message);
    res.status(500).send("Error");
  }
});

app.post('/complete-order/:id', async (req, res) => {
  const id = req.params.id;

  try {

    // 🔥 1. TRAER EL woo_order_id REAL
    const result = await pool.query(
      `SELECT woo_order_id FROM pedidos WHERE id = $1`,
      [id]
    );

    const wooId = result.rows[0]?.woo_order_id;

    // 🔥 2. ACTUALIZAR TU BD
    await pool.query(
      `UPDATE pedidos SET estado = 'completed' WHERE id = $1`,
      [id]
    );

    // 🔥 3. ACTUALIZAR WOO (CLAVE)
    if (wooId) {
      await axios.put(
        `${WOO_URL}/wp-json/wc/v3/orders/${wooId}`,
        {
          status: 'completed'
        },
        {
          auth: {
            username: CONSUMER_KEY,
            password: CONSUMER_SECRET
          }
        }
      );
    }

    console.log("✅ COMPLETADO LOCAL + WOO:", id);

    res.json({ success: true });

  } catch (error) {
    console.error("❌ ERROR COMPLETAR:", error);
    res.status(500).send("Error");
  }
});
app.get('/admin', (req, res) => {
  res.sendFile(__dirname + '/admin.html');
});
app.post('/admin/restaurantes', async (req, res) => {

  const { nombre, logo_url, woo_url, consumer_key, consumer_secret, shipday_api } = req.body;

  try {

    await pool.query(
      `INSERT INTO restaurantes 
      (nombre, logo_url, woo_url, consumer_key, consumer_secret, shipday_api)
      VALUES ($1,$2,$3,$4,$5,$6)`,
      [nombre, logo_url, woo_url, consumer_key, consumer_secret, shipday_api]
    );

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).send('Error');
  }

});
app.get('/admin/restaurantes', async (req, res) => {

  const result = await pool.query(`SELECT * FROM restaurantes ORDER BY id DESC`);

  res.json(result.rows);

});
app.post('/admin/usuarios', async (req, res) => {

  const { email, password, restaurante_id } = req.body;

  try {

    await pool.query(
      `INSERT INTO usuarios (email, password, restaurante_id)
       VALUES ($1, $2, $3)`,
      [email, password, restaurante_id]
    );

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).send('Error');
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

app.post('/refund', async (req, res) => {

  const { woo_order_id, orderId, amount } = req.body;

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
       WHERE woo_order_id = $1`,
      [String(finalOrderId)]
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
    const orderUrl = `${WOO_URL}/wp-json/wc/v3/orders/${finalOrderId}`;
    console.log("🔎 ORDER URL:", orderUrl);

    const wooRes = await axios.get(
      orderUrl,
      {
        auth: {
          username: CONSUMER_KEY,
          password: CONSUMER_SECRET
        }
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
    const refundUrl = `${WOO_URL}/wp-json/wc/v3/orders/${finalOrderId}/refunds`;
    console.log("🔗 REFUND URL:", refundUrl);

    const refundRes = await axios.post(
      refundUrl,
      {
        amount: Number(amount).toFixed(2),
        reason: "Reembolso desde dashboard",
        api_refund: true
      },
      {
        auth: {
          username: CONSUMER_KEY,
          password: CONSUMER_SECRET
        }
      }
    );

    console.log("✅ WOO REFUND OK:", refundRes.data);

    // ✅ 4. Guardar refund en DB solo si Woo respondió OK
    await pool.query(
      `UPDATE pedidos
       SET refunded = true,
           refund_amount = $1
       WHERE woo_order_id = $2`,
      [
        Number(amount).toFixed(2),
        String(finalOrderId)
      ]
    );

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

app.post('/refund', async (req, res) => {
  const { woo_order_id, amount } = req.body;

  try {
    // 🔥 1. VALIDAR SI YA FUE REEMBOLSADO
    const pedido = await pool.query(
      'SELECT refunded FROM pedidos WHERE woo_order_id = $1',
      [woo_order_id]
    );

    if (!pedido.rows.length) {
      return res.json({ success: false, message: "Pedido no encontrado" });
    }

    if (pedido.rows[0].refunded) {
      return res.json({ success: false, message: "Ya fue reembolsado" });
    }

    // 🔥 2. HACER REFUND EN WOO
    await axios.post(
      `${WOO_URL}/wp-json/wc/v3/orders/${woo_order_id}/refunds`,
      {
        amount: amount.toString()
      },
      {
        auth: {
          username: CONSUMER_KEY,
          password: CONSUMER_SECRET
        }
      }
    );

    // 🔥 3. GUARDAR EN DB
    await pool.query(
      `UPDATE pedidos
       SET refunded = true,
           refund_amount = $1
       WHERE woo_order_id = $2`,
      [amount, woo_order_id]
    );

    console.log("💸 REFUND OK:", woo_order_id);

    res.json({ success: true });

  } catch (error) {
    console.error("❌ ERROR REFUND:", error.response?.data || error.message);
    res.json({ success: false, message: "Error refund" });
  }
});

app.get('/refund-data/:woo_order_id', async (req, res) => {
  const wooOrderId = req.params.woo_order_id;

  try {
    const result = await pool.query(
      `SELECT woo_order_id, total, refund_items
       FROM pedidos
       WHERE woo_order_id = $1`,
      [wooOrderId]
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
app.use(express.static(__dirname));

