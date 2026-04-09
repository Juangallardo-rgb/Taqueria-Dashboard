let productosGlobal = [];
let productoEditando = null;

// LOGIN
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

  document.getElementById('contenido').innerHTML = `
    <div class="card">
      <h2>Bienvenido a DENIX 🚀</h2>
      <p>Tu sistema inteligente de pedidos.</p>
    </div>
  `;

  document.getElementById('contenedor').innerHTML = '';
  cargarEstadoRestaurante()
}

// =====================
// PEDIDOS
// =====================
async function verPedidos() {

  const contenido = document.getElementById('contenido');
  const contenedor = document.getElementById('contenedor');

  // LIMPIAR TODO
  contenido.innerHTML = '';
  contenedor.innerHTML = '<p>Cargando pedidos...</p>';

  try {

    const res = await fetch('/orders-complete');

    if (!res.ok) {
      throw new Error("Error en API pedidos");
    }

    const data = await res.json();

    console.log("📦 PEDIDOS:", data);

    contenedor.innerHTML = '';

    if (!data || data.length === 0) {
      contenedor.innerHTML = "<p>No hay pedidos</p>";
      return;
    }

    data.forEach(p => {
      contenedor.innerHTML += `
  <div class="card">

    <h3>Pedido #${p.id}</h3>

    <p>🕒 ${new Date(p.created_at).toLocaleString()}</p>

    <p>👤 ${p.customer_name || 'Cliente'}</p>

<div>
      <strong>🍽 Detalle:</strong>
      ${
  p.items
  ? (typeof p.items === "string"
      ? JSON.parse(p.items)
      : p.items
    ).map(i => `
      <div>• ${i.nombre} x${i.cantidad}</div>
    `).join('')
  : "Sin detalle"
    }
    </div>

    <p>💰 $${p.total}</p>

    <p>📊 ${p.estado}</p>

    <p>👨‍✈️ ${p.driver_name ? p.driver_name : "pendiente"}</p>

    ${p.tracking_url ? `
  <a href="${p.tracking_url}" target="_blank" style="
    display: inline-block;
    margin-top: 10px;
    padding: 8px 12px;
    background: #22c55e;
    color: white;
    border-radius: 8px;
    text-decoration: none;
    font-size: 14px;
  ">
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

  if (data.length === 0) {
    contenedor.innerHTML = "<p>No hay productos</p>";
    return;
  }

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
// EDITAR
// =====================
function editarProducto(id) {

  const producto = productosGlobal.find(p => p.id === id);

  productoEditando = producto.id;

  document.getElementById('nombre').value = producto.name;
  document.getElementById('precio').value = producto.price;
  document.getElementById('sku').value = producto.sku || '';
  document.getElementById('descripcion').value = producto.description || '';

  if (producto.categories.length > 0) {
    document.getElementById('categoria').value = producto.categories[0].id;
  }
}

// =====================
// GUARDAR
// =====================
async function guardarProducto() {

  const nombre = document.getElementById('nombre').value;
  const precio = document.getElementById('precio').value;
  const sku = document.getElementById('sku').value;
  const descripcion = document.getElementById('descripcion').value;
  const categoria = document.getElementById('categoria').value;

  const data = {
    name: nombre,
    type: "simple",
    regular_price: precio,
    sku: sku,
    description: descripcion,
    categories: [{ id: parseInt(categoria) }]
  };

  if (productoEditando) {

    await fetch(`/products/${productoEditando}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    alert("Producto actualizado 🔥");

  } else {

    await fetch('/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    alert("Producto creado 🔥");
  }

  productoEditando = null;
  verProductos();
}

// =====================
// ELIMINAR
// =====================
async function eliminarProducto(id) {

  await fetch(`/products/${id}`, {
    method: 'DELETE'
  });

  alert("Producto eliminado ❌");
  verProductos();
}

// INICIO
mostrarInicio();

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

  await fetch('/toggle-restaurante', {
    method: 'POST'
  });

  cargarEstadoRestaurante();

}