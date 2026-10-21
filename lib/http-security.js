const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ADMIN_SHELL_PATHS = [
  /^\/$/,
  /^\/restaurants$/,
  /^\/restaurants\/\d+$/,
  /^\/analytics\/restaurants\/\d+$/,
  /^\/users$/
];

function normalizeOrigin(value) {
  try {
    return new URL(String(value || '')).origin;
  } catch {
    return null;
  }
}

function requestOrigin(req, env = process.env) {
  const configured = normalizeOrigin(env.PUBLIC_APP_ORIGIN);
  if (configured) return configured;

  const protocol = String(req.get?.('x-forwarded-proto') || req.protocol || 'https')
    .split(',')[0]
    .trim();
  const host = String(req.get?.('x-forwarded-host') || req.get?.('host') || '')
    .split(',')[0]
    .trim();

  return host ? normalizeOrigin(`${protocol}://${host}`) : null;
}

function requireSameOrigin(req, res, next) {
  if (SAFE_METHODS.has(String(req.method || 'GET').toUpperCase())) return next();

  const originHeader = req.get?.('origin');
  if (!originHeader) return next();

  const actual = normalizeOrigin(originHeader);
  const expected = requestOrigin(req);
  if (actual && expected && actual === expected) return next();

  return res.status(403).json({
    success: false,
    message: 'Origen de solicitud no permitido',
    code: 'ORIGIN_NOT_ALLOWED'
  });
}

function requireAdminCsrf(req, res, next) {
  if (SAFE_METHODS.has(String(req.method || 'GET').toUpperCase())) return next();

  const sessionToken = String(req.session?.csrf_token || '');
  const requestToken = String(req.get?.('x-csrf-token') || '');
  const sessionBuffer = Buffer.from(sessionToken);
  const requestBuffer = Buffer.from(requestToken);

  if (
    sessionToken &&
    requestToken &&
    sessionBuffer.length === requestBuffer.length &&
    crypto.timingSafeEqual(sessionBuffer, requestBuffer)
  ) {
    return next();
  }

  return res.status(403).json({
    success: false,
    message: 'La sesión de seguridad expiró. Vuelve a ingresar.',
    code: 'CSRF_TOKEN_INVALID'
  });
}

function createLoginAttemptLimiter({
  windowMs = 15 * 60 * 1000,
  maxAttempts = 5,
  maxEntries = 10000,
  now = () => Date.now()
} = {}) {
  const attempts = new Map();

  function keyFor(req, email) {
    const address = String(req.ip || req.socket?.remoteAddress || 'unknown');
    return `${address}:${String(email || '').trim().toLowerCase()}`;
  }

  function current(key) {
    const value = attempts.get(key);
    if (!value || value.resetAt <= now()) {
      attempts.delete(key);
      return null;
    }
    return value;
  }

  function prune() {
    for (const [key, value] of attempts) {
      if (value.resetAt <= now()) attempts.delete(key);
    }
    while (attempts.size >= maxEntries) {
      const oldestKey = attempts.keys().next().value;
      if (oldestKey === undefined) break;
      attempts.delete(oldestKey);
    }
  }

  return {
    check(req, email) {
      const value = current(keyFor(req, email));
      if (!value || value.count < maxAttempts) return { allowed: true };
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((value.resetAt - now()) / 1000))
      };
    },
    fail(req, email) {
      prune();
      const key = keyFor(req, email);
      const value = current(key) || { count: 0, resetAt: now() + windowMs };
      value.count += 1;
      attempts.set(key, value);
      return value.count;
    },
    clear(req, email) {
      attempts.delete(keyFor(req, email));
    },
    size() {
      return attempts.size;
    }
  };
}

function isAdminShellRequest(req) {
  if (String(req.method || 'GET').toUpperCase() !== 'GET') return false;
  const path = String(req.path || '/');
  return ADMIN_SHELL_PATHS.some(pattern => pattern.test(path));
}

function redirectAdminShellToLogin(req, res, next) {
  if (req.session?.user_id && String(req.session?.rol || '').toLowerCase() === 'admin') {
    return next();
  }
  if (!isAdminShellRequest(req)) return next();

  const nextPath = String(req.originalUrl || '/admin');
  return res.redirect(302, `/admin/login?next=${encodeURIComponent(nextPath)}`);
}

function applySecurityHeaders(req, res, next) {
  const adminRequest = String(req.path || '').startsWith('/admin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      adminRequest
        ? "script-src 'self'"
        // El panel operativo heredado aún usa controladores inline.
        : "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: https:",
      "media-src 'self'",
      "connect-src 'self'",
      "worker-src 'self'",
      "manifest-src 'self'"
    ].join('; ')
  );

  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
}

module.exports = {
  SAFE_METHODS,
  applySecurityHeaders,
  createLoginAttemptLimiter,
  isAdminShellRequest,
  redirectAdminShellToLogin,
  requireAdminCsrf,
  requireSameOrigin,
  requestOrigin
};
