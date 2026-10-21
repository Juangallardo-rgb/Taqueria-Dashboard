(() => {
  'use strict';

  const form = document.getElementById('adminLoginForm');
  const emailInput = document.getElementById('adminEmail');
  const passwordInput = document.getElementById('adminPassword');
  const loginButton = document.getElementById('loginButton');
  const message = document.getElementById('loginMessage');
  const passwordToggle = document.getElementById('passwordToggle');

  function safeNextPath() {
    const value = new URLSearchParams(window.location.search).get('next') || '/admin';
    if (
      !(value === '/admin' || value.startsWith('/admin/')) ||
      value.startsWith('//') ||
      value.startsWith('/admin/login')
    ) {
      return '/admin';
    }
    return value;
  }

  function setMessage(text, type = '') {
    message.textContent = text;
    message.className = `form-message ${type}`.trim();
  }

  passwordToggle.addEventListener('click', () => {
    const reveal = passwordInput.type === 'password';
    passwordInput.type = reveal ? 'text' : 'password';
    passwordToggle.textContent = reveal ? 'Ocultar' : 'Ver';
    passwordToggle.setAttribute('aria-label', reveal ? 'Ocultar contraseña' : 'Mostrar contraseña');
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    setMessage('');

    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) {
      setMessage('Completa el usuario y la contraseña.', 'error');
      return;
    }

    loginButton.disabled = true;
    loginButton.classList.add('loading');

    try {
      const response = await fetch('/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, next: safeNextPath() })
      });
      const body = await response.json().catch(() => ({}));

      if (!response.ok || !body.success) {
        throw new Error(body.message || 'No fue posible iniciar sesión.');
      }

      setMessage('Acceso correcto. Abriendo el administrador…', 'success');
      window.location.replace(body.redirect || safeNextPath());
    } catch (error) {
      setMessage(error.message || 'No fue posible iniciar sesión.', 'error');
      passwordInput.select();
    } finally {
      loginButton.disabled = false;
      loginButton.classList.remove('loading');
    }
  });

  async function resumeAdminSession() {
    try {
      const response = await fetch('/session', { cache: 'no-store' });
      if (!response.ok) return;
      const body = await response.json();
      if (body?.authenticated && String(body.user?.rol || '').toLowerCase() === 'admin') {
        window.location.replace(safeNextPath());
      }
    } catch {
      // El formulario sigue disponible si no hay conexión o sesión previa.
    }
  }

  resumeAdminSession();
})();
