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
const WOO_URL = 'https://user.taquerialabonita.com';
const CONSUMER_KEY = 'ck_1f0e1358b2b92f6d1c2556b065ee7fde816db5e4';
const CONSUMER_SECRET = 'cs_6254e435ed2161cdaa7cb6baedb9b885995965f6';

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

    wooOrders = response.data.map(order => ({
      id: order.id,
      total: order.total,
      estado: order.status,
      cliente: order.billing?.first_name + " " + order.billing?.last_name,
      direccion: order.shipping?.address_1,
      ciudad: order.shipping?.city
    }));

    res.json(wooOrders);

  } catch (error) {
    console.error("ERROR WOO:", error.response?.data || error.message);
    res.status(500).send('Error WooCommerce');
  }
});


// ===============================
// 🔥 WEBHOOK WOO
// ===============================
app.post('/webhook-order', (req, res) => {
  console.log("🔥 WEBHOOK WOO:", req.body);

  const order = req.body;

  wooOrders.push({
    id: order.id,
    total: order.total,
    estado: order.status,
    cliente: order.billing?.first_name + " " + order.billing?.last_name,
    direccion: order.shipping?.address_1,
    ciudad: order.shipping?.city
  });

  res.sendStatus(200);
});


// ===============================
// 🚚 WEBHOOK SHIPDAY
// ===============================
app.post('/webhook-shipday', (req, res) => {
  const data = req.body;

  console.log("🚚 SHIPDAY:", data.orderNumber, data.status);

  // 🔥 EVITAR DUPLICADOS
  const index = shipdayOrders.findIndex(s => s.orderNumber == data.orderNumber);

  if (index !== -1) {
    shipdayOrders[index] = data; // actualizar
  } else {
    shipdayOrders.push(data); // nuevo
  }

  res.sendStatus(200);
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
app.get('/orders-complete', (req, res) => {

  const resultado = wooOrders.map(order => {

    const ship = shipdayOrders.find(s =>
      String(s.orderNumber).includes(String(order.id))
    );

    return {
      id: order.id,
      cliente: order.cliente,
      total: order.total,
      estado: order.estado,
      direccion: order.direccion,
      ciudad: order.ciudad,

      estado_envio: ship?.status || "pendiente",
      driver: ship?.driverName || "no asignado",
      tracking: ship?.trackingUrl || null
    };
  });

  res.json(resultado);
});


// ===============================
// 🛒 PRODUCTOS (CRUD)
// ===============================

// 📦 OBTENER PRODUCTOS
app.get('/products', async (req, res) => {
  try {
    const response = await axios.get(
      `${WOO_URL}/wp-json/wc/v3/products?per_page=100`,
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

// 🚀 START
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});