let pedidosVistos = JSON.parse(localStorage.getItem("pedidosVistos")) || [];
let productosGlobal = [];
let productoEditando = null;

let ultimoPedidoId = null;
window.viendoPedidos = false;

// =====================
// LOGIN
// =====================
async function login() {
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;

  const res = await fetch('/login', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ email, password })
  });

  const data = await res.json();

  if (data.success) {
    localStorage.setItem("login", "true");
    location.reload();
  } else {
    alert("Credenciales incorrectas");
  }
}

// AUTO LOGIN
if(localStorage.getItem("login") === "true") {
  document.getElementById('loginScreen').style.display = "none";
  document.getElementById('dashboard').style.display = "flex";
}

// LOGOUT
function logout() {
  localStorage.removeItem("login");
  location.reload();
}

// =====================
// INICIO
// =====================
function mostrarInicio() {

  window.viendoPedidos = false;

  document.getElementById('contenido').innerHTML = `
    <div class="card">
      <h2>Bienvenido a DENIX 🚀</h2>
      <p>Tu sistema inteligente de pedidos.</p>
    </div>
  `;

  document.getElementById('contenedor').innerHTML = '';
  cargarEstadoRestaurante();
}

// =====================
// PEDIDOS (TIEMPO REAL)
// =====================
async function verPedidos(esAuto = false) {

  window.viendoPedidos = true;

  const contenido = document.getElementById('contenido');
  const contenedor = document.getElementById('contenedor');

  if (!esAuto) {
    contenido.innerHTML = '';
    contenedor.innerHTML = '<p>Cargando pedidos...</p>';
  }

  try {

    const res = await fetch('/orders-complete?ts=' + Date.now());

    if (!res.ok) throw new Error("Error API");

    const data = await res.json();

    if (!data || data.length === 0) {
      contenedor.innerHTML = "<p>No hay pedidos</p>";
      return;
    }

    const nuevoId = data[0].id;

    if (ultimoPedidoId && nuevoId > ultimoPedidoId) {
      reproducirSonido();
    }

    ultimoPedidoId = nuevoId;

    contenedor.innerHTML = '';

    data.forEach(p => {

      let itemsHTML = "Sin detalle";

      try {
        if (p.items) {
          const items = typeof p.items === "string"
            ? JSON.parse(p.items)
            : p.items;

          itemsHTML = items.map(i => `
            <div>• ${i.nombre} x${i.cantidad}</div>
          `).join('');
        }
      } catch (e) {}

      contenedor.innerHTML += `
        <div class="card ${!pedidosVistos.includes(p.id) ? 'nuevo' : ''}" onclick="marcarComoVisto(${p.id}, this)">

          <h3>Pedido #${p.id}</h3>

          <p>🕒 ${new Date(p.created_at).toLocaleString()}</p>

          <p>👤 ${p.customer_name || 'Cliente'}</p>

          <div>
            <strong>🍽 Detalle:</strong>
            ${itemsHTML}
          </div>

          <p>💰 $${p.total}</p>

          <p>📊 ${p.estado}</p>

          <p>👨‍✈️ ${p.driver_name || "Sin asignar"}</p>

          ${p.tracking_url ? `
            <a href="${p.tracking_url}" target="_blank" class="btn-tracking">
              📍 Ver seguimiento
            </a>
          ` : ''}

        </div>
      `;
    });

  } catch (error) {
    console.error("❌ ERROR PEDIDOS:", error);
    contenedor.innerHTML = "<p>Error cargando pedidos</p>";
  }
}

// =====================
// TIEMPO REAL LOOP
// =====================
setInterval(() => {
  if (window.viendoPedidos) {
    verPedidos(true);
  }
}, 5000);

// =====================
// SONIDO
// =====================
function reproducirSonido() {
  const audio = new Audio('https://www.soundjay.com/buttons/sounds/button-3.mp3');
  audio.play();
}

// =====================
// CATEGORIAS
// =====================
async function cargarCategorias() {

  const res = await fetch('/categories');
  const data = await res.json();

  const select = document.getElementById('categoria');

  if (!select) return;

  select.innerHTML = '';

  data.forEach(cat => {
    const option = document.createElement('option');
    option.value = cat.id;
    option.textContent = cat.name;
    select.appendChild(option);
  });
}

// =====================
// PRODUCTOS
// =====================
async function verProductos() {

  window.viendoPedidos = false;

  const contenido = document.getElementById('contenido');
  const contenedor = document.getElementById('contenedor');

  contenido.innerHTML = `
    <div class="card">
      <h2>Crear / Editar Producto</h2>
      <input id="nombre" placeholder="Nombre">
      <input id="precio" placeholder="Precio">
      <input id="sku" placeholder="SKU">
      <textarea id="descripcion" placeholder="Descripción"></textarea>
      <select id="categoria"></select>
      <button onclick="guardarProducto()">Guardar</button>
    </div>
  `;

  contenedor.innerHTML = '';

  await cargarCategorias();

  const res = await fetch('/products');
  const data = await res.json();

  productosGlobal = data;

  data.forEach(p => {
    contenedor.innerHTML += `
      <div class="card">
        <h3>${p.name}</h3>
        <p>$${p.price}</p>

        <button onclick="editarProducto(${p.id})">Editar</button>
        <button onclick="eliminarProducto(${p.id})">Eliminar</button>
      </div>
    `;
  });
}

// =====================
// RESTAURANTE
// =====================
async function cargarEstadoRestaurante() {

  const res = await fetch('/estado-restaurante');
  const data = await res.json();

  const switchInput = document.getElementById('switchRestaurante');
  const texto = document.getElementById('estadoTexto');

  if (!switchInput || !texto) return;

  if (data.abierto) {
    switchInput.checked = true;
    texto.innerText = "🟢 Abierto";
  } else {
    switchInput.checked = false;
    texto.innerText = "🔴 Cerrado";
  }
}

async function toggleRestaurante() {
  await fetch('/toggle-restaurante', { method: 'POST' });
  cargarEstadoRestaurante();
}

// =====================
// INICIO APP
// =====================
mostrarInicio();
function marcarComoVisto(id, elemento) {

  if (!pedidosVistos.includes(id)) {
    pedidosVistos.push(id);
    localStorage.setItem("pedidosVistos", JSON.stringify(pedidosVistos));
  }

  elemento.classList.remove('nuevo');
}