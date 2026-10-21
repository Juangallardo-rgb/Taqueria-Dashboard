const path = require('path');

const PUBLIC_ASSETS = Object.freeze({
  '/app.js': 'app.js',
  '/styles.css': 'styles.css',
  '/sw.js': 'sw.js',
  '/manifest.json': 'manifest.json',
  '/icon-192.png': 'icon-192.png',
  '/icon-512.png': 'icon-512.png',
  '/admin/manifest.webmanifest': 'admin-manifest.webmanifest',
  '/admin/sw.js': 'admin-sw.js',
  '/admin/pwa.js': 'admin-pwa.js',
  '/admin/login/assets/login.css': 'admin-login.css',
  '/admin/login/assets/login.js': 'admin-login.js',
  '/admin/offline.html': 'admin-offline.html',
  '/admin/icon-192.png': 'icon-192.png',
  '/admin/icon-512.png': 'icon-512.png',
  '/logoDenix.png': 'logoDenix.png',
  '/labonita.png': 'labonita.png',
  '/sonido.mp3': 'sonido.mp3'
});

function registerPublicAssetRoutes(app, rootDirectory) {
  for (const [route, filename] of Object.entries(PUBLIC_ASSETS)) {
    app.get(route, (req, res) => {
      res.sendFile(path.join(rootDirectory, filename));
    });
  }
}

module.exports = { PUBLIC_ASSETS, registerPublicAssetRoutes };
