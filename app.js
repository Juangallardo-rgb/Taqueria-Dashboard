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
    alert("Error");
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

// INICIO
function mostrarInicio() {
  document.getElementById('contenido').innerHTML = `
    <div class="card">
      <h2>Bienvenido a DENIX 🚀</h2>
      <p>Tu sistema inteligente de pedidos.</p>
    </div>
  `;
}

// PEDIDOS
async function verPedidos() {
  const res = await fetch('/orders-complete');
  const data = await res.json();

  const cont = document.getElementById('contenedor');
  cont.innerHTML = '';

  data.forEach(p => {
    cont.innerHTML += `
      <div class="card">
        <h3>Pedido #${p.id}</h3>
        <p>$${p.total}</p>
      </div>
    `;
  });
}