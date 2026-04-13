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

  await cargarMetricas();
  await cargarEstadoRestaurante();
}


// =====================
// MÉTRICAS + GRÁFICO
// =====================
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

    document.getElementById('ordenesHoy').innerText = ordenesHoy;
    document.getElementById('ventasHoy').innerText = `$${ventasHoy.toFixed(2)}`;
    document.getElementById('ordenesMes').innerText = ordenesMes;
    document.getElementById('ventasMes').innerText = `$${ventasMes.toFixed(2)}`;

    renderGraficoOrdenes(data);

  } catch (error) {
    console.error("Error métricas:", error);
  }
}


// =====================
// GRÁFICO BARRAS
// =====================
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

    labels.push(d.getDate());

    let count = 0;

    data.forEach(p => {

      if (p.estado !== 'processing' && p.estado !== 'completed') return;

      const fecha = new Date(p.created_at);

      if (
        fecha.getDate() === d.getDate() &&
        fecha.getMonth() === d.getMonth() &&
        fecha.getFullYear() === d.getFullYear()
      ) {
        count++;
      }

    });

    valores.push(count);
  }

  if (window.graficoOrdenes) {
    window.graficoOrdenes.destroy();
  }

  window.graficoOrdenes = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: valores,
        backgroundColor: '#f97316'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { stepSize: 1 }
        }
      }
    }
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
// INIT
// =====================
mostrarInicio();