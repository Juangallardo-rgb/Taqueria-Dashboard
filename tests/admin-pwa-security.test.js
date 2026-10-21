const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const loginHtml = fs.readFileSync(path.join(root, 'admin-login.html'), 'utf8');
const adminJs = fs.readFileSync(path.join(root, 'admin.js'), 'utf8');
const serviceWorker = fs.readFileSync(path.join(root, 'admin-sw.js'), 'utf8');
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'admin-manifest.webmanifest'), 'utf8')
);

test('admin tiene login público antes de la protección general por rol', () => {
  const loginRoute = indexSource.indexOf("app.get('/admin/login'");
  const adminGuard = indexSource.indexOf("app.use('/admin', requireAdmin)");
  assert.ok(loginRoute >= 0);
  assert.ok(adminGuard > loginRoute);
  assert.match(indexSource, /app\.post\('\/admin\/login', requireSameOrigin/);
  assert.match(indexSource, /requiredRole: 'admin'/);
  assert.match(indexSource, /redirectAdminShellToLogin/);
});

test('login ya no compara contraseñas en texto plano y migra formatos heredados', () => {
  assert.doesNotMatch(indexSource, /AND u\.password = \$2/);
  assert.match(indexSource, /await verifyPassword\(password, user\.password\)/);
  assert.match(indexSource, /await hashPassword\(password\)/);
  assert.match(indexSource, /SET password = \$1/);
  assert.match(indexSource, /const passwordHash = await hashPassword\(cleanPassword\)/);
});

test('sesión administrativa expone CSRF y las mutaciones lo envían', () => {
  assert.match(indexSource, /req\.session\.csrf_token = crypto\.randomBytes/);
  assert.match(indexSource, /app\.use\('\/admin', requireSameOrigin, requireAdminCsrf\)/);
  assert.match(adminJs, /'X-CSRF-Token': state\.csrfToken/);
});

test('manifest y páginas forman una PWA administrativa independiente', () => {
  assert.equal(manifest.id, '/admin/');
  assert.equal(manifest.start_url, '/admin/');
  assert.equal(manifest.scope, '/admin/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some(icon => icon.sizes === '192x192'));
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512'));
  assert.match(adminHtml, /rel="manifest" href="\/admin\/manifest\.webmanifest"/);
  assert.match(loginHtml, /rel="manifest" href="\/admin\/manifest\.webmanifest"/);
  assert.match(adminHtml, /data-install-admin/);
  assert.match(loginHtml, /data-install-admin/);
});

test('service worker solo precarga el shell público y no cachea APIs administrativas', () => {
  assert.match(serviceWorker, /PUBLIC_SHELL/);
  assert.match(serviceWorker, /request\.method !== 'GET'/);
  assert.doesNotMatch(serviceWorker, /cache\.put/);
  assert.doesNotMatch(serviceWorker, /\/admin\/api\/dashboard/);
  assert.doesNotMatch(serviceWorker, /\/admin\/usuarios/);
  assert.doesNotMatch(serviceWorker, /\/admin\/restaurantes/);
});
