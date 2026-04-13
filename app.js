let audioPermitido = false;
let pedidosVistos = JSON.parse(localStorage.getItem("pedidosVistos")) || [];
let productosGlobal = [];
let productoEditando = null;
let tabActual = 'recientes';
let ultimoPedidoId = null;

window.viendoPedidos = false;

// activar audio
document.addEventListener('click', () => {
  audioPermitido = true;
}, { once: true });


// =====================
// LOGIN
// =====================
async function login() {
  try {
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;

    const res = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await res.json();

    if (data.success) {
      localStorage.setItem("login", "true");
      location.reload();
    } else {
      alert("Credenciales incorrectas");
    }

  } catch (error) {
    console.error("ERROR LOGIN:", error);
  }
}

// hacer login global
window.login = login;


// =====================
// AUTO LOGIN
// =====================
window.addEventListener('load', () => {
  if(localStorage.getItem("login") === "true") {
    document.getElementById('loginScreen').style.display = "none";
    document.getElementById('dashboard').style.display = "flex";
  }
});


// =====================
// LOGOUT
// =====================
function logout() {
  localStorage.removeItem("login");
  location.reload();
}


// =====================
// INICIO
// =====================
function mostrarInicio() {
  window.viendoPedidos = false;

  document.getElementById('tituloPagina').innerText = "Dashboard";

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

  document.getElementById('tituloPagina').innerText = "Pedidos";
  window.viendoPedidos = true;

  const contenido = document.getElementById('contenido');
  const contenedor = document.getElementById('contenedor');

  // tabs solo la primera vez
  if (!esAuto) {
    contenido.innerHTML = `
      <div class="tabs">

        <button onclick="cambiarTab('recientes')" id="tab-recientes" class="tab">En proceso</button>
        <button onclick="cambiarTab('hoy')" id="tab-hoy" class="tab">Hoy</button>
        <button onclick="cambiarTab('ayer')" id="tab-ayer" class="tab">Ayer</button>
        <button onclick="cambiarTab('semana')" id="tab-semana" class="tab">Todas</button>

      </div>
    `;
      contenedor.innerHTML = '<p>Cargando pedidos...</p>';
  }

  try {

    const res = await fetch('/orders-complete?ts=' + Date.now());

    if (!res.ok) throw new Error("Error API");

    const data = await res.json();

    let pedidosFiltrados = data;
    const ahora = new Date();

    // filtros
    if (tabActual === 'recientes') {
      pedidosFiltrados = data.filter(p => p.estado === 'processing');
    }

    if (tabActual === 'hoy') {
      pedidosFiltrados = data.filter(p => {
        const fecha = new Date(p.created_at);
        return p.estado === 'completed' &&
          fecha.toDateString() === ahora.toDateString();
      });
    }

    if (tabActual === 'ayer') {
      const ayer = new Date();
      ayer.setDate(ayer.getDate() - 1);

      pedidosFiltrados = data.filter(p => {
        const fecha = new Date(p.created_at);
        return p.estado === 'completed' &&
          fecha.toDateString() === ayer.toDateString();
      });
    }

    if (tabActual === 'semana') {
      const hace7dias = new Date();
      hace7dias.setDate(hace7dias.getDate() - 7);

      pedidosFiltrados = data.filter(p => {
        const fecha = new Date(p.created_at);
        return p.estado === 'completed' &&
          fecha >= hace7dias;
      });
    }

    // activar tab
    setTimeout(() => {
      document.querySelectorAll('.tab').forEach(btn => btn.classList.remove('active'));
      const tabActivo = document.getElementById('tab-' + tabActual);
      if (tabActivo) tabActivo.classList.add('active');
    }, 0);

    if (!pedidosFiltrados.length) {
      contenedor.innerHTML = "<p>No hay pedidos en esta sección</p>";
      return;
    }

    const nuevoId = data[0]?.id;

    if (ultimoPedidoId && nuevoId > ultimoPedidoId) {
      reproducirSonido();
    }

    ultimoPedidoId = nuevoId;

    contenedor.innerHTML = '';

    pedidosFiltrados.forEach(p => {

      let itemsHTML = "Sin detalle";

      try {
        if (p.items) {
          const items = typeof p.items === "string"
            ? JSON.parse(p.items)
            : p.items;

          itemsHTML = items.map(i =>
            `<div>• ${i.nombre} x${i.cantidad}</div>`
          ).join('');
        }
      } catch (e) {}

      contenedor.innerHTML += `
        <div class="card ${!pedidosVistos.includes(p.id) ? 'nuevo' : ''}" onclick="marcarComoVisto(${p.id}, this)">

          <h3>Pedido #${p.id}</h3>

          <p>🕒 ${new Date(p.created_at).toLocaleString()}</p>

          <p>👤 Cliente: ${p.customer_name || 'Cliente'}</p>

          <div>
            <strong>🍽 Detalle:</strong>
            ${itemsHTML}
          </div>

          <p>💰 Total: $${p.total}</p>

          <p>📊 Estado: ${p.estado}</p>

          <p>🛵 Driver: ${p.driver_name || "Sin asignar"}</p>

          ${p.tracking_url ? `
            <a href="${p.tracking_url}" target="_blank" class="btn-tracking">
              📍 Ver seguimiento
            </a>
          ` : ''}

        </div>
      `;
    });

  } catch (error) {
    console.error("ERROR PEDIDOS:", error);
    contenedor.innerHTML = "<p>Error cargando pedidos</p>";
  }
}


// =====================
// LOOP TIEMPO REAL
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
  if (!audioPermitido) return;

  const audio = new Audio('/sonido.mp3');
  audio.volume = 1;
  audio.play().catch(() => {});
}


// =====================
// PRODUCTOS
// =====================
async function verProductos() {

  document.getElementById('tituloPagina').innerText = "Productos";
  window.viendoPedidos = false;

  const contenido = document.getElementById('contenido');
  const contenedor = document.getElementById('contenedor');

  // FORMULARIO
 contenido.innerHTML = `
  <div class="card">
    <h2>Productos</h2>
    <input id="buscadorProductos" placeholder="🔍 Buscar producto..." oninput="filtrarProductos()" />
    <button onclick="abrirCrear()">➕ Crear Producto</button>
  </div>
`;
  
  contenedor.innerHTML = '<p>Cargando productos...</p>';

  // CATEGORÍAS (NO BLOQUEA)
  try {
    await cargarCategorias();
  } catch (e) {
    console.log("⚠️ Error cargando categorías", e);
  }

  // PRODUCTOS
  try {
    const res = await fetch('/products?ts=' + Date.now());

    if (!res.ok) throw new Error("Error products");

    const data = await res.json();

    productosGlobal = data;

    if (!data.length) {
      contenedor.innerHTML = "<p>No hay productos</p>";
      return;
    }

    contenedor.innerHTML = '';

    renderProductos(data);

  } catch (error) {
    console.error("❌ ERROR PRODUCTOS:", error);
    contenedor.innerHTML = "<p>Error cargando productos</p>";
  }
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
// UTILS
// =====================
function marcarComoVisto(id, elemento) {
  if (!pedidosVistos.includes(id)) {
    pedidosVistos.push(id);
    localStorage.setItem("pedidosVistos", JSON.stringify(pedidosVistos));
  }
  elemento.classList.remove('nuevo');
}

function cambiarTab(tab) {
  tabActual = tab;
  verPedidos();
}

function abrirSoporte() {
  document.getElementById('popupSoporte').classList.add('active');
}

function cerrarSoporte() {
  document.getElementById('popupSoporte').classList.remove('active');
}

function irWhatsApp() {
  const mensaje = encodeURIComponent("Hola, necesito ayuda con DENIX 🚀");
  window.open(`https://wa.me/14437617813?text=${mensaje}`, '_blank');
}

function irCorreo() {
  window.location.href = "mailto:tualiadodigitalinfo@gmail.com";
}

function filtrarProductos() {

  const texto = document.getElementById('buscadorProductos')
    .value
    .trim()
    .toLowerCase();

  if (!texto) {
    renderProductos(productosGlobal);
    return;
  }

  const filtrados = productosGlobal.filter(p => {

    const nombre = String(p.name || "").toLowerCase();

    return nombre.includes(texto);
  });

  renderProductos(filtrados);
}

function renderProductos(lista) {

  const contenedor = document.getElementById('contenedor');

  contenedor.innerHTML = '';

  if (!lista.length) {
    contenedor.innerHTML = "<p>No se encontraron productos</p>";
    return;
  }

  lista.forEach(p => {
    contenedor.innerHTML += `
      <div class="card">
        <h3>${p.name}</h3>
        <p>$${parseFloat(p.price || p.regular_price).toFixed(2)}</p>

        <button onclick="abrirEditar(${p.id})">Editar</button>
        <button onclick="eliminarProducto(${p.id})">Eliminar</button>
      </div>
    `;
  });
}
function editarProducto(id) {

  const producto = productosGlobal.find(p => p.id == id);

  if (!producto) {
    console.log("❌ Producto no encontrado");
    return;
  }

  document.getElementById('nombre').value = producto.name || '';
  document.getElementById('precio').value = producto.price || '';
  document.getElementById('descripcion').value = producto.description || '';

  // categoría si existe
  if (producto.categories && producto.categories.length > 0) {
    document.getElementById('categoria').value = producto.categories[0].id;
  }

  productoEditando = id;

  console.log("✅ Editando producto:", producto);
}

async function eliminarProducto(id) {

  if (!confirm("¿Eliminar este producto?")) return;

  try {
    const res = await fetch(`/products/${id}`, {
      method: 'DELETE'
    });

    if (!res.ok) throw new Error("Error eliminando");

    // actualizar lista local
    productosGlobal = productosGlobal.filter(p => p.id != id);

    renderProductos(productosGlobal);

    console.log("✅ Producto eliminado");
    verProductos(); // recargar lista

  } catch (error) {
    console.error("❌ ERROR ELIMINAR:", error);
    alert("Error eliminando producto");
  }
}

async function guardarProducto() {

  const nombre = document.getElementById('nombre').value;
  const precio = document.getElementById('precio').value;
  const descripcion = document.getElementById('descripcion').value;
  const categoria = document.getElementById('categoria').value;

  const data = {
    name: nombre,
    regular_price: precio,
    description: descripcion,
    categories: [{ id: parseInt(categoria) }]
  };

  try {

    let url = '/products';
    let method = 'POST';

    // 🔥 SI ESTÁ EDITANDO
    if (productoEditando) {
      url = `/products/${productoEditando}`;
      method = 'PUT';
    }

    const res = await fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (!res.ok) throw new Error("Error guardando");

    productoEditando = null;

    verProductos(); // recargar lista

    console.log("✅ Producto guardado");

  } catch (error) {
    console.error("❌ ERROR GUARDAR:", error);
    alert("Error guardando producto");
  }
}

function abrirEditar(id) {
  cargarCategoriasPopup();

  const p = productosGlobal.find(p => p.id == id);

  if (!p) return;

  document.getElementById('editNombre').value = p.name || '';
  document.getElementById('editPrecio').value = p.price || '';
  document.getElementById('editDescripcion').value = p.description || '';

  productoEditando = id;

  document.getElementById('popupEditar').classList.add('active');
}

function cerrarEditar() {
  document.getElementById('popupEditar').classList.remove('active');
}

async function guardarEdicion() {

  const nombre = document.getElementById('editNombre').value;
  const precio = document.getElementById('editPrecio').value;
  const descripcion = document.getElementById('editDescripcion').value;
  const categoria = document.getElementById('editCategoria').value;

  try {

    let url = '/products';
    let method = 'POST';

    // 👉 SI ESTÁ EDITANDO
    if (productoEditando) {
      url = `/products/${productoEditando}`;
      method = 'PUT';
    }

    const res = await fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: nombre,
        regular_price: precio,
        description: descripcion,
        categories: [{ id: parseInt(categoria) }]
      })
    });

    if (!res.ok) throw new Error("Error guardando");

    cerrarEditar();
    productoEditando = null;

    verProductos();

  } catch (error) {
    console.error("❌ ERROR GUARDAR:", error);
    alert("Error guardando producto");
  }
}

function abrirCrear() {

  cargarCategoriasPopup();

  productoEditando = null;

  document.getElementById('editNombre').value = '';
  document.getElementById('editPrecio').value = '';
  document.getElementById('editDescripcion').value = '';

  document.getElementById('popupEditar').classList.add('active');
}

async function cargarCategoriasPopup() {

  const res = await fetch('/categories');
  const data = await res.json();

  const select = document.getElementById('editCategoria');

  if (!select) return;

  select.innerHTML = '';

  data.forEach(cat => {
    const option = document.createElement('option');
    option.value = cat.id;
    option.textContent = cat.name;
    select.appendChild(option);
  });
}

function toggleMenu() {

  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('overlay');

  sidebar.classList.toggle('active');
  overlay.classList.toggle('active');
}
document.querySelectorAll('.menu button').forEach(btn => {
  btn.addEventListener('click', () => {

    if (window.innerWidth <= 768) {
      document.querySelector('.sidebar').classList.remove('active');
      document.getElementById('overlay').classList.remove('active');
    }

  });
});

@media (max-width: 768px) {

  .sidebar {
    position: fixed;
    top: 0;
    left: -260px;
    width: 260px;
    height: 100%;

    display: flex;
    flex-direction: column;
    justify-content: space-between; /* 🔥 CLAVE */

    padding: 20px;

    background: white;
    z-index: 999;
    transition: 0.3s;
  }

  .sidebar.active {
    left: 0;
  }

  /* TOP */
  .sidebar-top {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .business-logo img {
    width: 100px;
    margin-bottom: 15px;
  }

  .switch-container {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
  }

  /* MENU */
  .menu {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 20px;
  }

  .menu button {
    width: 100%;
    text-align: left;
    padding: 12px;
    border-radius: 10px;
  }

  /* LOGOUT ABAJO */
  .logout {
    width: 100%;
    margin-top: 20px;
    background: #f97316;
    color: white;
    padding: 12px;
    border-radius: 10px;
  }

}
// =====================
// INIT
// =====================
mostrarInicio();