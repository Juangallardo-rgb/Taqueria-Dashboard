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
const WOO_URL = 'https://taquerialabonita.com';
const CONSUMER_KEY = 'ck_09ccb2842a83e1b4d089505baecb6c627a8cab1c';
const CONSUMER_SECRET = 'cs_f0a533f8a25ec307a44126e421e2088b0b27f57a';

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
    const response = await axios.get(
      `${WOO_URL}/wp-json/wc/v3/orders?per_page=20`,
      {
        auth: {
          username: CONSUMER_KEY,
          password: CONSUMER_SECRET
        }
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
        direccion: order.shipping?.address_1 || '',
        ciudad: order.shipping?.city || '',

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
    console.error("❌ ERROR WOO:", error.response?.data || error.message);
    res.status(500).send('Error WooCommerce');
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
      `INSERT INTO pedidos (restaurante_id, total, estado, woo_order_id, customer_name, items)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (woo_order_id)
       DO UPDATE SET
         estado = EXCLUDED.estado,
         total = EXCLUDED.total,
         customer_name = EXCLUDED.customer_name,
         items = EXCLUDED.items`,
      [
        1,
        order.total,
        order.status,
        order.id,
        `${order.billing?.first_name || ''} ${order.billing?.last_name || ''}`.trim() || 'Cliente',
        JSON.stringify(items)
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
            (restaurante_id, total, estado, woo_order_id, customer_name, items, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
            ON CONFLICT (woo_order_id)
            DO UPDATE SET
              estado = EXCLUDED.estado,
              total = EXCLUDED.total,
              customer_name = EXCLUDED.customer_name,
              items = EXCLUDED.items`,
            [
              1,
              order.total,
              order.status,
              order.id,
              `${order.billing?.first_name || ''} ${order.billing?.last_name || ''}`.trim() || 'Cliente',
              JSON.stringify(items)
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
    const result = await pool.query(`
      SELECT 
        p.id,
        p.total,
        p.estado,
        p.customer_name,
        p.items,
        p.created_at,
        d.driver_name,

        -- 🔥 FIX AQUÍ
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
      ORDER BY p.created_at DESC
    `);

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

      // 🔥 CLAVE PARA MULTI-RESTAURANTE
      req.session.restaurante_id = user.restaurante_id || 1;

      console.log("RESTAURANTE LOGUEADO:", req.session.restaurante_id);

      res.json({ success: true });

    } else {
      res.json({ success: false });
    }

  } catch (error) {
    console.error(error);
    res.status(500).send('Error login');
  }
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
   SET items = $1
   WHERE woo_order_id = $2
   AND (items IS NULL OR items::text != $1)`,
  [
    JSON.stringify(items),
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

