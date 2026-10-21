(() => {
  'use strict';

  let installPrompt = null;

  function installButtons() {
    return Array.from(document.querySelectorAll('[data-install-admin]'));
  }

  function updateInstallButtons(visible) {
    installButtons().forEach(button => {
      button.hidden = !visible;
      button.disabled = false;
    });
  }

  async function installAdminApp() {
    if (!installPrompt) return;
    installButtons().forEach(button => { button.disabled = true; });
    try {
      await installPrompt.prompt();
      await installPrompt.userChoice;
    } finally {
      installPrompt = null;
      updateInstallButtons(false);
    }
  }

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    updateInstallButtons(true);
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    updateInstallButtons(false);
  });

  document.addEventListener('DOMContentLoaded', () => {
    installButtons().forEach(button => button.addEventListener('click', installAdminApp));
    if (window.matchMedia('(display-mode: standalone)').matches) {
      document.documentElement.classList.add('standalone-app');
    }
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/admin/sw.js', { scope: '/admin/' })
        .catch(error => console.error('No se pudo registrar Denix Admin:', error));
    });
  }
})();
