let audioPermitido = false;
let pedidosVistos = JSON.parse(localStorage.getItem("pedidosVistos")) || [];
let productosGlobal = [];
let productoEditando = null;
let tabActual = 'recientes';
let ultimoPedidoId = null;
let ultimoPedidoGlobal = null;
let audioPedido = new Audio('/sonido.mp3');
window.currentOrderId = null;
window.currentOrderTotal = 0;


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
async function mostrarInicio() {

  window.viendoPedidos = false;
  document.getElementById('tituloPagina').innerText = "Dashboard";

  const contenido = document.getElementById('contenido');
  const contenedor = document.getElementById('contenedor');

  contenido.innerHTML = `
    <div class="dashboard-metricas">

      <div class="card-metrica">
        <h4>🧾 Órdenes Hoy</h4>
        <p id="ordenesHoy">0</p>
      </div>

      <div class="card-metrica">
        <h4>💰 Ventas Hoy</h4>
        <p id="ventasHoy">$0</p>
      </div>

      <div class="card-metrica">
        <h4>📅 Órdenes Mes</h4>
        <p id="ordenesMes">0</p>
      </div>

      <div class="card-metrica">
        <h4>💵 Ventas Mes</h4>
        <p id="ventasMes">$0</p>
      </div>

    </div>

    <div class="card card-grafico">
      <h3>📊 Órdenes últimos 7 días</h3>
      <div class="grafico-container">
        <canvas id="graficoOrdenes"></canvas>
      </div>
    </div>
  `;

  contenedor.innerHTML = '';

  await cargarMetricas(); // 🔥 SOLO UNA VEZ
  await cargarEstadoRestaurante();
}


// =====================
// PEDIDOS (TIEMPO REAL)
// =====================
async function verPedidos(esAuto = false) {
  limpiarAlertaPedidos();

  document.getElementById('tituloPagina').innerText = "Pedidos";
  window.viendoPedidos = true;

  const contenido = document.getElementById('contenido');
  const contenedor = document.getElementById('contenedor');

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

    // 🔥 FIX PICKUP SIN LOOP (CLAVE)
  window.forzados = window.forzados || {};

data.forEach(p => {

  const idWoo = p.woo_order_id;

  if (!idWoo || p.estado_envio !== 'pickup') return;

  const sinItems = !p.items || p.items === '[]';

  if (sinItems) {

    if (!window.forzados[idWoo]) {
      window.forzados[idWoo] = { intentos: 0 };
    }

    if (window.forzados[idWoo].intentos < 3) {

      window.forzados[idWoo].intentos++;

      setTimeout(() => {
        fetch(`/force-order/${idWoo}`);
      }, 1000 * window.forzados[idWoo].intentos); // 1s, 2s, 3s

    }
  }

});

    let pedidosFiltrados = data;
    const ahora = new Date();

    // filtros
    if (tabActual === 'recientes') {
      pedidosFiltrados = data.filter(p =>
        (p.estado || '').toLowerCase().trim() === 'processing' ||
        (p.estado || '').toLowerCase().trim() === 'pending'
      );
    }

    if (tabActual === 'hoy') {
      pedidosFiltrados = data.filter(p => {
        const fecha = new Date(p.created_at);
        return (p.estado || '').toLowerCase() === 'completed' &&
          fecha.toDateString() === ahora.toDateString();
      });
    }

    if (tabActual === 'ayer') {
      const ayer = new Date();
      ayer.setDate(ayer.getDate() - 1);

      pedidosFiltrados = data.filter(p => {
        const fecha = new Date(p.created_at);
        return (p.estado || '').toLowerCase() === 'completed' &&
          fecha.toDateString() === ayer.toDateString();
      });
    }

    if (tabActual === 'semana') {
      const hace7dias = new Date();
      hace7dias.setDate(hace7dias.getDate() - 7);

      pedidosFiltrados = data.filter(p => {
        const fecha = new Date(p.created_at);
        return (p.estado || '').toLowerCase() === 'completed' &&
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

      const esPickup = p.estado_envio === 'pickup';

      let itemsHTML = "Sin detalle";

      try {
  if (p.items) {
    const items = typeof p.items === "string"
      ? JSON.parse(p.items)
      : p.items;

    itemsHTML = items.map(i => {

      let nombre = i.nombre || i.name || 'Producto';
      const cantidad = i.cantidad || i.quantity || 1;

      let extrasHTML = '';

      if (nombre.includes('(')) {

        const partes = nombre.split('(');
        nombre = partes[0].trim();

        let extrasRaw = partes.slice(1).join('(').replace(')', '');

        // 🔥 dividir SOLO por etiquetas reales (sin perder info)
        const bloques = extrasRaw.split(/(?=Protein Choice:|Protein Addition:|Preparation Option:|Egg Preparation Choice:|Tortilla Choice:|Side Choice:|Special requests:)/g);

        extrasHTML = bloques.map(e => {

          let limpio = e.trim();

          // 🔥 limpiar SOLO etiquetas visuales (NO valores)
          limpio = limpio
            .replace('Protein Choice:', '🥩 Protein:')
            .replace('Protein Addition:', '➕ Extra:')
            .replace('Preparation Option:', '🍳 Prep:')
            .replace('Egg Preparation Choice:', '🥚 Egg:')
            .replace('Tortilla Choice:', '🌮 Tortilla:')
            .replace('Side Choice:', '🍚 Side:')
            .replace('Special requests:', '📝 Nota:')
            .replace('_wapf_meta:', '')
            .replace('[object Object]', '')
            .trim();

          if (!limpio) return '';

          return `<div class="item-extra">${limpio}</div>`;

        }).join('');
      }

      return `
        <div class="item-card">
          <div class="item-title">🍽 ${nombre} x${cantidad}</div>
          ${extrasHTML}
        </div>
      `;
    }).join('');
  }
} catch (e) {
  console.error("ERROR ITEMS:", e);
}

      contenedor.innerHTML += `
  <div class="card ${!pedidosVistos.includes(p.id) ? 'nuevo' : ''}" onclick="marcarComoVisto(${p.id}, this)">

    ${esPickup 
      ? `<div class="badge-pickup">👜 PICKUP</div>` 
      : `<div class="badge-delivery">🚚 DELIVERY</div>`}

    <h3>Pedido #${p.id}</h3>

    <p>🕒 ${new Date(p.created_at).toLocaleString()}</p>

    <p>👤 Cliente: ${p.customer_name || 'Cliente'}</p>
    
    ${p.customer_phone ? `<p>📞 Teléfono: ${p.customer_phone}</p>` : ''}

    <div>
      <strong>🍽 Detalle:</strong>
      ${itemsHTML}
    </div>

    <p>💰 Total: $${p.total}</p>

    <p>📊 Estado: ${p.estado}</p>

    ${esPickup && p.estado !== 'completed' ? `
      <button class="btn-completar" onclick="event.stopPropagation(); completarPedido(${p.id})">
        ✅ COMPLETADO
      </button>
    ` : ''}

    ${!esPickup ? `<p>🛵 Driver: ${p.driver_name || "Sin asignar"}</p>` : ''}

    ${!esPickup && p.tracking_url ? `
      <a href="${p.tracking_url}" target="_blank" class="btn-tracking">
        📍 Ver seguimiento
      </a>
    ` : ''}

   ${p.refunded ? `
  <div style="display:flex; justify-content:center; margin-top:15px;">
    <div style="background:#28a745;color:white;padding:10px 14px;border-radius:8px;font-weight:bold;">
      ✅ Reembolsado ($${p.refund_amount || p.total})
    </div>
  </div>
` : `
  <div style="display:flex; justify-content:center; margin-top:15px;">
    <button 
      onclick="event.stopPropagation(); abrirRefund(${p.woo_order_id}, ${p.total})"
      style="background:#dc3545;color:white;padding:10px 16px;border:none;border-radius:8px;cursor:pointer;">
      💸 Refund
    </button>
  </div>
`}

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
}, 2000);


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

  try {
    // 🔥 NUEVO: leer productos desde Supabase, no desde WooCommerce
    const res = await fetch('/productos-db?ts=' + Date.now());

    if (!res.ok) throw new Error("Error productos-db");

    const data = await res.json();

    // 🔥 Convertimos productos de Supabase a formato compatible con tu render actual
    const productos = data.map(p => {

      const raw = p.raw || {};

      return {
        ...raw,

        // IDs
        id: Number(p.woo_product_id),
        woo_product_id: p.woo_product_id,

        // Datos principales
        name: p.nombre || raw.name || 'Producto',
        nombre: p.nombre || raw.name || 'Producto',

        price: String(p.precio ?? raw.price ?? '0'),
        regular_price: String(p.regular_price ?? raw.regular_price ?? '0'),
        sale_price: String(p.sale_price ?? raw.sale_price ?? ''),

        status: p.estado || raw.status || '',
        stock_status: p.stock_status || raw.stock_status || '',

        // Imagen compatible con Woo
        images: p.imagen
          ? [{ src: p.imagen }]
          : (raw.images || []),

        // Categorías compatibles
        categories: p.categorias || raw.categories || [],

        // Guardamos también el producto original de Supabase
        db_id: p.id,
        updated_at: p.updated_at
      };
    });

    productosGlobal = productos;

    if (!productos.length) {
      contenedor.innerHTML = "<p>No hay productos</p>";
      return;
    }

    // 🔥 Creamos categorías desde los productos guardados en DB
    window.categoriasGlobal = [];

    productos.forEach(producto => {
      (producto.categories || []).forEach(cat => {
        if (!window.categoriasGlobal.some(c => c.id === cat.id)) {
          window.categoriasGlobal.push(cat);
        }
      });
    });

    contenedor.innerHTML = '';

    renderProductos(productos);

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

    // ✅ ID real de WooCommerce
    const productId = p.id || p.woo_product_id;

    // ✅ Nombre compatible con Supabase/Woo
    const nombre = p.name || p.nombre || 'Producto';

    // ✅ Precio compatible con Supabase/Woo
    const precio = parseFloat(
      p.price || 
      p.precio || 
      p.regular_price || 
      0
    );

    // ✅ Stock compatible
    const stock = p.stock_status || 'instock';

    contenedor.innerHTML += `
      <div class="card">
        <h3>${nombre}</h3>

        <p>$${precio.toFixed(2)}</p>

        <p>
          ${stock === 'instock' 
            ? '🟢 Disponible' 
            : '🔴 No disponible'}
        </p>

        <button onclick="abrirEditar(${productId})">Editar</button>
        <button onclick="eliminarProducto(${productId})">Eliminar</button>
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

    const res = await fetch('/acciones-woo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tipo: 'delete_product',
        woo_product_id: id,
        payload: {}
      })
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      throw new Error(data.message || "Error creando acción de eliminación");
    }

    alert("✅ Eliminación enviada. Ejecuta el puente en WordPress para aplicarla.");

    console.log("✅ Acción eliminar producto creada:", data);

    // No lo quitamos todavía de la lista porque Woo debe eliminarlo primero.
    // Luego el webhook Product deleted actualizará Supabase.
    verProductos();

  } catch (error) {
    console.error("❌ ERROR ELIMINAR PRODUCTO:", error);
    alert("Error eliminando producto");
  }
}

async function guardarProducto() {

  // 🔥 Soporta ambos nombres de inputs por seguridad
  const nombreInput = document.getElementById('nombre') || document.getElementById('editNombre');
  const precioInput = document.getElementById('precio') || document.getElementById('editPrecio');
  const descripcionInput = document.getElementById('descripcion') || document.getElementById('editDescripcion');
  const categoriaInput = document.getElementById('categoria') || document.getElementById('editCategoria');

  const nombre = nombreInput ? nombreInput.value.trim() : '';
  const precio = precioInput ? precioInput.value.trim() : '';
  const descripcion = descripcionInput ? descripcionInput.value.trim() : '';
  const categoria = categoriaInput ? categoriaInput.value : '';

  if (!nombre) {
    alert("Ingresa el nombre del producto");
    return;
  }

  if (!precio) {
    alert("Ingresa el precio del producto");
    return;
  }

  const payload = {
    name: nombre,
    regular_price: precio,
    price: precio,
    description: descripcion,
    status: 'publish',
    stock_status: 'instock'
  };

  if (categoria) {
    payload.categories = [{ id: parseInt(categoria) }];
  }

  try {

    let tipo = 'create_product';
    let wooProductId = null;

    // 🔥 SI ESTÁ EDITANDO
    if (productoEditando) {
      tipo = 'update_product';
      wooProductId = productoEditando;
    }

    const res = await fetch('/acciones-woo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tipo,
        woo_product_id: wooProductId,
        payload
      })
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      throw new Error(data.message || "Error creando acción");
    }

    productoEditando = null;

    const popup = document.getElementById('popupEditar');
    if (popup) {
      popup.classList.remove('active');
    }

    alert("✅ Acción enviada. Ejecuta el puente en WordPress para aplicar el cambio.");

    verProductos();

    console.log("✅ Acción producto creada:", data);

  } catch (error) {
    console.error("❌ ERROR GUARDAR PRODUCTO:", error);
    alert("Error guardando producto");
  }
}

async function abrirEditar(id) {

  await cargarCategoriasPopup();

  const p = productosGlobal.find(p => p.id == id || p.woo_product_id == id);

  if (!p) {
    alert("Producto no encontrado");
    return;
  }

  document.getElementById('editNombre').value = p.name || p.nombre || '';
  document.getElementById('editPrecio').value = p.price || p.precio || '';
  document.getElementById('editDescripcion').value = p.description || p.raw?.description || '';
  
  const stockInput = document.getElementById('editStock');
  if (stockInput) {
    stockInput.value = p.stock_status || 'instock';
  }

  const categoriaInput = document.getElementById('editCategoria');
  if (categoriaInput && p.categories && p.categories.length) {
    categoriaInput.value = p.categories[0].id;
  }

  productoEditando = p.id || p.woo_product_id || id;

  document.getElementById('popupEditar').classList.add('active');
}

function cerrarEditar() {
  document.getElementById('popupEditar').classList.remove('active');
}

async function guardarEdicion() {

  const nombre = document.getElementById('editNombre').value.trim();
  const precio = document.getElementById('editPrecio').value.trim();
  const descripcion = document.getElementById('editDescripcion').value.trim();
  const categoria = document.getElementById('editCategoria').value;
  const stock = document.getElementById('editStock').value;

  if (!nombre) {
    alert("Ingresa el nombre del producto");
    return;
  }

  if (!precio) {
    alert("Ingresa el precio del producto");
    return;
  }

  try {

    let tipo = 'create_product';
    let wooProductId = null;

    // 👉 SI ESTÁ EDITANDO
    if (productoEditando) {
      tipo = 'update_product';
      wooProductId = productoEditando;
    }

    const payload = {
      name: nombre,
      regular_price: precio,
      price: precio,
      description: descripcion,
      stock_status: stock,
      status: 'publish'
    };

    if (categoria) {
      payload.categories = [{ id: parseInt(categoria) }];
    }

    const res = await fetch('/acciones-woo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tipo,
        woo_product_id: wooProductId,
        payload
      })
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      throw new Error(data.message || "Error creando acción");
    }

    cerrarEditar();
    productoEditando = null;

    alert("✅ Cambio enviado. Ejecuta el puente en WordPress para aplicarlo.");

    verProductos();

  } catch (error) {
    console.error("❌ ERROR GUARDAR EDICIÓN:", error);
    alert("Error guardando producto");
  }
}

async function abrirCrear() {

  await cargarCategoriasPopup();

  productoEditando = null;

  document.getElementById('editNombre').value = '';
  document.getElementById('editPrecio').value = '';
  document.getElementById('editDescripcion').value = '';

  const categoria = document.getElementById('editCategoria');
  if (categoria) {
    categoria.selectedIndex = 0;
  }

  document.getElementById('popupEditar').classList.add('active');
}

async function cargarCategoriasPopup() {

  const select = document.getElementById('editCategoria');
  if (!select) return;

  select.innerHTML = '';

  const categoriasMap = new Map();

  (productosGlobal || []).forEach(producto => {
    const categorias = producto.categories || producto.categorias || [];

    categorias.forEach(cat => {
      if (cat && cat.id && !categoriasMap.has(cat.id)) {
        categoriasMap.set(cat.id, {
          id: cat.id,
          name: cat.name || cat.nombre || 'Categoría'
        });
      }
    });
  });

  const categorias = Array.from(categoriasMap.values());

  if (!categorias.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Sin categorías cargadas';
    select.appendChild(option);
    return;
  }

  categorias.forEach(cat => {
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

async function cargarMetricas() {

  try {

    const res = await fetch('/orders-complete?ts=' + Date.now());
    const data = await res.json();

    const hoy = new Date();

    let ordenesHoy = 0;
    let ventasHoy = 0;
    let ordenesMes = 0;
    let ventasMes = 0;

    data.forEach(p => {

      if (p.estado !== 'processing' && p.estado !== 'completed') return;

      const fecha = new Date(p.created_at);
      const total = Number(p.total) || 0;

      if (fecha.toDateString() === hoy.toDateString()) {
        ordenesHoy++;
        ventasHoy += total;
      }

      if (
        fecha.getMonth() === hoy.getMonth() &&
        fecha.getFullYear() === hoy.getFullYear()
      ) {
        ordenesMes++;
        ventasMes += total;
      }

    });

    // UI
    document.getElementById('ordenesHoy').innerText = ordenesHoy;
    document.getElementById('ventasHoy').innerText = `$${ventasHoy.toFixed(2)}`;
    document.getElementById('ordenesMes').innerText = ordenesMes;
    document.getElementById('ventasMes').innerText = `$${ventasMes.toFixed(2)}`;

    // 🔥 EL GRÁFICO VA AQUÍ (DENTRO DEL TRY)
    renderGraficoOrdenes(data);

  } catch (error) {
    console.error("Error métricas:", error);
  }
}

function renderGraficoOrdenes(data) {

  const canvas = document.getElementById('graficoOrdenes');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');

  const hoy = new Date();

  const labels = [];
  const valores = [];

  for (let i = 6; i >= 0; i--) {

    const d = new Date();
    d.setDate(hoy.getDate() - i);

    const dia = d.toLocaleDateString('es-ES', {
  day: 'numeric',
  month: 'short'
});

labels.push(dia);

    let count = 0;

    data.forEach(p => {

      if (p.estado !== 'processing' && p.estado !== 'completed') return;

      const fecha = new Date(p.created_at);

      const keyFecha = fecha.toISOString().split('T')[0];
      const keyDia = d.toISOString().split('T')[0];

      if (keyFecha === keyDia) {
        count++;
      }

    });

    valores.push(count);
  }

  if (window.graficoOrdenes && typeof window.graficoOrdenes.destroy === 'function') {
  window.graficoOrdenes.destroy();
}

  window.graficoOrdenes = new Chart(ctx, {
  type: 'bar',
  data: {
    labels, // los dejamos pero los formateamos abajo
    datasets: [{
      label: 'Órdenes',
      data: valores,
      backgroundColor: '#f97316',
      borderRadius: 8,
      barThickness: 40
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,

    plugins: {
      legend: {
        display: false
      },

      tooltip: {
        callbacks: {
          title: function(context) {
            return `Día ${context[0].label}`;
          },
          label: function(context) {
            return `${context.raw} órdenes`;
          }
        }
      }
    },

    scales: {
      x: {
        grid: {
          display: false
        },
        ticks: {
          font: {
            size: 12
          }
        }
      },

      y: {
        beginAtZero: true,
        ticks: {
          stepSize: 1,
          callback: function(value) {
            return value + ' ord';
          }
        },
        grid: {
          color: '#e5e7eb'
        }
      }
    }
  }
});
window.abrirEditar = abrirEditar;
window.cerrarEditar = cerrarEditar;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js')
    .then(() => console.log('SW registrado'));
}
}

setInterval(async () => {
  try {

    const res = await fetch('/orders-complete');
    const data = await res.json();

    if (!data.length) return;

    const nuevoId = data[0].id;

    // 🔥 DETECTAR NUEVO PEDIDO GLOBAL
    if (ultimoPedidoGlobal && nuevoId > ultimoPedidoGlobal) {

      // 🔊 SONIDO SIEMPRE
      audioPedido.currentTime = 0;
      audioPedido.play();

      // 🔴 ACTIVAR PARPADEO
      activarAlertaPedidos();
    }

    ultimoPedidoGlobal = nuevoId;

  } catch (e) {
    console.error("ERROR GLOBAL PEDIDOS:", e);
  }

}, 3000); // cada 3s

function activarAlertaPedidos() {
  const btn = document.getElementById('btn-pedidos');
  if (btn) {
    btn.classList.add('parpadeo');
  }
}

function limpiarAlertaPedidos() {
  const btn = document.getElementById('btn-pedidos');
  if (btn) {
    btn.classList.remove('parpadeo');
  }
}
async function completarPedido(id) {
  try {

    await fetch(`/complete-order/${id}`, {
      method: 'POST'
    });

    // 🔥 recargar pedidos inmediatamente
    verPedidos(true);

  } catch (e) {
    console.error("ERROR COMPLETAR PEDIDO:", e);
  }
}
let currentOrderId = null;

window.abrirRefund = function(orderId, total) {

  console.log("CLICK REFUND");

  window.currentOrderId = orderId;
  window.currentOrderTotal = total;

  const modal = document.getElementById('refundModal');

  modal.classList.add('active');
};

function seleccionarTotal() {
  document.getElementById('refundStep1').style.display = 'none';
  document.getElementById('refundStepTotal').style.display = 'block';
}

async function seleccionarParcial() {

  document.getElementById('refundStep1').style.display = 'none';
  document.getElementById('refundStepTotal').style.display = 'none';
  document.getElementById('refundStepParcial').style.display = 'block';

  const container = document.getElementById('refundItemsContainer');
  const totalBox = document.getElementById('refundTotal');

  container.innerHTML = '<p style="text-align:center;">Cargando productos...</p>';
  totalBox.innerText = '0.00';
  window.currentRefundTotal = 0;

  try {
    const res = await fetch(`/refund-data/${window.currentOrderId}`);
    const data = await res.json();

    if (!data.success) {
      container.innerHTML = `<p style="color:red; text-align:center;">${data.message || 'No se pudieron cargar productos'}</p>`;
      return;
    }

    window.currentRefundItems = data.items || [];

    if (!window.currentRefundItems.length) {
      container.innerHTML = '<p style="text-align:center;">No hay productos disponibles para reembolso parcial</p>';
      return;
    }

    container.innerHTML = '';

    window.currentRefundItems.forEach((item, index) => {

      const extrasHTML = (item.extras || []).map(extra => {
        return `<div class="refund-item-extra">• ${extra.key}: ${extra.value}</div>`;
      }).join('');

      container.innerHTML += `
        <label class="refund-item-row">
          <input 
            type="checkbox" 
            class="refund-item-check"
            data-amount="${item.refund_total}"
            onchange="actualizarRefundTotal()"
          >

          <div class="refund-item-info">
            <div class="refund-item-title">
              ${item.name} x${item.quantity}
            </div>

            ${extrasHTML}

            <div class="refund-item-price">
              Reembolso: $${Number(item.refund_total).toFixed(2)}
            </div>
          </div>
        </label>
      `;
    });

    actualizarRefundTotal();

  } catch (error) {
    console.error("ERROR CARGANDO REFUND DATA:", error);
    container.innerHTML = '<p style="color:red; text-align:center;">Error cargando productos</p>';
  }
}

function actualizarRefundTotal() {
  const checks = document.querySelectorAll('.refund-item-check:checked');

  let total = 0;

  checks.forEach(check => {
    total += Number(check.dataset.amount || 0);
  });

  window.currentRefundTotal = Number(total.toFixed(2));

  const totalBox = document.getElementById('refundTotal');
  if (totalBox) {
    totalBox.innerText = window.currentRefundTotal.toFixed(2);
  }
}

window.cerrarRefund = function() {
  const modal = document.getElementById('refundModal');

  modal.classList.remove('active');

  document.getElementById('refundStep1').style.display = 'block';
  document.getElementById('refundStepTotal').style.display = 'none';
  document.getElementById('refundStepParcial').style.display = 'none';

  document.getElementById('refundAmount').value = '';
};

async function hacerRefund(woo_order_id, amount) {
  try {

    const res = await fetch('/refund', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        woo_order_id,
        amount
      })
    });

    const data = await res.json();

    if (data.success) {
      alert("✅ Reembolso realizado");

      cerrarRefund();

      // 🔥 Esto actualiza la tarjeta y oculta el botón
      await verPedidos(true);

    } else {
      alert(data.message || "❌ Error en reembolso");
    }

  } catch (e) {
    console.error(e);
    alert("Error de conexión");
  }
}
async function confirmarRefundTotal() {
  await hacerRefund(window.currentOrderId, window.currentOrderTotal);
}
async function confirmarRefundParcial() {

  if (!window.currentRefundTotal || window.currentRefundTotal <= 0) {
    alert("Selecciona al menos un producto");
    return;
  }

  const ok = confirm(`¿Seguro que deseas reembolsar $${window.currentRefundTotal.toFixed(2)}?`);
  if (!ok) return;

  await hacerRefund(window.currentOrderId, window.currentRefundTotal);
}
window.onclick = function(e) {
  const modal = document.getElementById('refundModal');

  if (e.target === modal) {
    cerrarRefund();
  }
};
// =====================
// INIT
// =====================
mostrarInicio();