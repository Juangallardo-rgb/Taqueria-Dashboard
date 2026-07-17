const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);

const SESSION_COOKIE_NAME = 'denix.sid';
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function getSessionSettings(env = process.env) {
  const secret = String(env.SESSION_SECRET || '').trim();

  if (!secret) {
    throw new Error('SESSION_SECRET es requerida para iniciar el servidor');
  }

  const secure = env.NODE_ENV === 'production';

  return {
    secret,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      maxAge: SESSION_MAX_AGE_MS,
      path: '/'
    }
  };
}

function createPersistentSessionMiddleware({ pool, env = process.env }) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('Se requiere un pool PostgreSQL válido para las sesiones');
  }

  const settings = getSessionSettings(env);

  return session({
    name: SESSION_COOKIE_NAME,
    store: new PgSession({
      pool,
      tableName: 'user_sessions',
      createTableIfMissing: false
    }),
    secret: settings.secret,
    resave: false,
    saveUninitialized: false,
    cookie: settings.cookie
  });
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  getSessionSettings,
  createPersistentSessionMiddleware,
  regenerateSession,
  saveSession,
  destroySession
};
