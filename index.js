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
app.get('/woo-orders', async (req, res) => {
  try {
    const response = await axios.get(
      `${WOO_URL}/wp-json/wc/v3/orders`,
      {
        auth: {
          username: CONSUMER_KEY,
          password: CONSUMER_SECRET
        }
      }
    );

    const wooOrders = response.data.map(order => {


      // 🔥 DETECCIÓN PICKUP (SEGURA)
      const esPickup = !order.shipping?.address_1;

      console.log(JSON.stringify(order.line_items, null, 2));
      console.log("ORDER:", order.id, "Pickup:", esPickup);

      return {
        id: order.id,
        total: order.total,
        estado: order.status,
        customer_name: order.billing?.first_name + " " + order.billing?.last_name,
        direccion: order.shipping?.address_1,
        ciudad: order.shipping?.city,

        // 🔥 CLAVE
        estado_envio: esPickup ? 'pickup' : 'delivery',

        created_at: order.date_created,
        items: order.line_items.map(item => {

  const extras = item.meta_data
    ?.filter(m => m.value)
    .map(m => `${m.key}: ${m.value}`)
    .join(', ');

  return {
    nombre: item.name + (extras ? ` (${extras})` : ''),
    cantidad: item.quantity
  };
})
      };
    });

    // 🔥 ESTO FALTABA
    res.json(wooOrders);

  } catch (error) {
    console.error("ERROR WOO:", error.response?.data || error.message);
    res.status(500).send('Error WooCommerce');
  }
});


// ===============================
// 🔥 WEBHOOK WOO
// ===============================
app.post('/webhook-order', async (req, res) => {

  const order = req.body;

  console.log("🔥 WOO WEBHOOK:", order);

  try {

    await pool.query(
      `INSERT INTO pedidos (restaurante_id, total, estado, woo_order_id, customer_name, items)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (woo_order_id)
       DO UPDATE SET
         estado = EXCLUDED.estado,
         total = EXCLUDED.total`,
      [
        1,
        order.total,
        order.status, // 🔥 CLAVE
        order.id,
        order.billing ? order.billing.first_name + " " + order.billing.last_name : "Cliente",
        JSON.stringify(order.line_items.map(i => ({
          nombre: i.name,
          cantidad: i.quantity
        })))
      ]
    );

    res.sendStatus(200);

  } catch (error) {
    console.error("❌ ERROR WOO:", error);
    res.sendStatus(500);
  }
  console.log("🔥 PEDIDO RECIBIDO:", new Date());
});

// ===============================
// 🚚 WEBHOOK SHIPDAY
// ===============================
app.post('/webhook-shipday', async (req, res) => {

  const data = req.body;

  console.log("🔥 SHIPDAY:", data);

  // ✅ DRIVER SEGURO
  const driverName = data.carrier && data.carrier.name 
    ? data.carrier.name 
    : null;

  // ✅ ORDER NUMBER SEGURO
  const orderNumber = data.order 
    ? data.order.order_number 
    : null;

  function convertirFecha(timestamp) {
    if (!timestamp) return null;
    return new Date(Number(timestamp));
  }

  try {

    // 🔥 1. GUARDAR / ACTUALIZAR DELIVERY
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
        data.order ? data.order.delivery_fee : null,
        data.trackingUrl,
        convertirFecha(data.order ? data.order.pickedup_time : null),
        convertirFecha(data.order ? data.order.delivery_time : null)
      ]
    );

    console.log("✅ DELIVERY GUARDADO");

    // 🔥 2. TRAER ITEMS REALES DESDE WOO (CON VARIACIONES)
    if (orderNumber) {
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

        const wooItems = wooRes.data.line_items;

        // 🔥 3. ACTUALIZAR PEDIDO CON ITEMS REALES
        await pool.query(
          `UPDATE pedidos 
           SET items = $1 
           WHERE woo_order_id = $2`,
          [
            JSON.stringify(wooItems),
            String(orderNumber)
          ]
        );

        console.log("🔥 ITEMS ACTUALIZADOS DESDE WOO");

      } catch (err) {
        console.error("❌ ERROR WOO ITEMS:", err.message);
      }
    }

    console.log("🚚 SHIPDAY PROCESADO:", new Date());

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

