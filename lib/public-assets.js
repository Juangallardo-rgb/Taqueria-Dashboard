const path = require('path');

const PUBLIC_ASSETS = Object.freeze({
  '/app.js': 'app.js',
  '/styles.css': 'styles.css',
  '/sw.js': 'sw.js',
  '/manifest.json': 'manifest.json',
  '/icon-192.png': 'icon-192.png',
  '/icon-512.png': 'icon-512.png',
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
