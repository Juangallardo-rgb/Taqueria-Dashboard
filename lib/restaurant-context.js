class RestaurantContextError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = 'RestaurantContextError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function toPositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getSessionRestaurantId(req) {
  const value = req?.session?.restaurante_id;

  if (value === undefined || value === null || value === '') {
    throw new RestaurantContextError(
      'La sesión no tiene un restaurante asignado',
      401,
      'SESSION_RESTAURANT_MISSING'
    );
  }

  const restauranteId = toPositiveInteger(value);

  if (!restauranteId) {
    throw new RestaurantContextError(
      'El restaurante de la sesión no es válido',
      400,
      'SESSION_RESTAURANT_INVALID'
    );
  }

  return restauranteId;
}

function getLegacyRestaurantOneConfig(restauranteId, env = process.env) {
  if (
    toPositiveInteger(restauranteId) !== 1 ||
    String(env.ENABLE_LEGACY_RESTAURANT_1 || '').toLowerCase() !== 'true'
  ) {
    return null;
  }

  return {
    id: 1,
    woo_url: env.WOO_URL || null,
    consumer_key: env.CONSUMER_KEY || null,
    consumer_secret: env.CONSUMER_SECRET || null,
    webhook_token: env.WEBHOOK_SECRET || null,
    woo_webhook_secret: env.WEBHOOK_SECRET || null,
    shipday_webhook_secret: env.WEBHOOK_SECRET || null,
    legacy: true
  };
}

function createRestaurantContext({ pool, env = process.env }) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('Se requiere un pool PostgreSQL válido');
  }

  async function getRestaurantIntegrationConfig(restauranteId) {
    const cleanRestaurantId = toPositiveInteger(restauranteId);

    if (!cleanRestaurantId) {
      throw new RestaurantContextError(
        'restauranteId no es válido',
        400,
        'RESTAURANT_ID_INVALID'
      );
    }

    const result = await pool.query(
      `SELECT
         id,
         nombre,
         logo_url,
         woo_url,
         consumer_key,
         consumer_secret,
         shipday_api,
         webhook_token,
         woo_webhook_secret,
         shipday_webhook_secret,
         activo
       FROM restaurantes
       WHERE id = $1
       LIMIT 1`,
      [cleanRestaurantId]
    );

    const restaurant = result.rows[0];

    if (!restaurant) return null;

    const legacy = getLegacyRestaurantOneConfig(cleanRestaurantId, env);

    return {
      id: Number(restaurant.id),
      nombre: restaurant.nombre || '',
      logo_url: restaurant.logo_url || null,
      woo_url: restaurant.woo_url || legacy?.woo_url || null,
      consumer_key: restaurant.consumer_key || legacy?.consumer_key || null,
      consumer_secret: restaurant.consumer_secret || legacy?.consumer_secret || null,
      shipday_api: restaurant.shipday_api || null,
      webhook_token: restaurant.webhook_token || legacy?.webhook_token || null,
      woo_webhook_secret:
        restaurant.woo_webhook_secret || legacy?.woo_webhook_secret || null,
      shipday_webhook_secret:
        restaurant.shipday_webhook_secret || legacy?.shipday_webhook_secret || null,
      activo: restaurant.activo !== false,
      legacy: Boolean(legacy)
    };
  }

  function requireAuthenticatedUser(req, res, next) {
    if (!toPositiveInteger(req?.session?.user_id)) {
      return res.status(401).json({ authenticated: false });
    }

    return next();
  }

  function requireAdmin(req, res, next) {
    if (!toPositiveInteger(req?.session?.user_id)) {
      return res.status(401).json({ authenticated: false });
    }

    if (String(req.session.rol || '').toLowerCase() !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Acceso administrativo requerido'
      });
    }

    return next();
  }

  async function requireSessionRestaurant(req, res, next) {
    if (!toPositiveInteger(req?.session?.user_id)) {
      return res.status(401).json({ authenticated: false });
    }

    let restauranteId;

    try {
      restauranteId = getSessionRestaurantId(req);
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message,
        code: error.code || 'RESTAURANT_CONTEXT_ERROR'
      });
    }

    try {
      const result = await pool.query(
        `SELECT id, nombre, logo_url, abierto, activo
         FROM restaurantes
         WHERE id = $1
         LIMIT 1`,
        [restauranteId]
      );

      const restaurant = result.rows[0];

      if (!restaurant) {
        return res.status(404).json({
          success: false,
          message: 'Restaurante no encontrado'
        });
      }

      if (restaurant.activo === false) {
        return res.status(403).json({
          success: false,
          message: 'El restaurante está inactivo'
        });
      }

      req.restaurant = {
        id: Number(restaurant.id),
        nombre: restaurant.nombre || '',
        logo_url: restaurant.logo_url || null,
        abierto: Boolean(restaurant.abierto),
        activo: restaurant.activo !== false
      };

      return next();
    } catch (error) {
      console.error('Error resolviendo el restaurante de la sesión:', error.message);
      return res.status(500).json({
        success: false,
        message: 'No se pudo validar el restaurante de la sesión'
      });
    }
  }

  return {
    getSessionRestaurantId,
    requireAuthenticatedUser,
    requireSessionRestaurant,
    requireAdmin,
    getRestaurantIntegrationConfig,
    getLegacyRestaurantOneConfig: restauranteId =>
      getLegacyRestaurantOneConfig(restauranteId, env)
  };
}

module.exports = {
  RestaurantContextError,
  toPositiveInteger,
  getSessionRestaurantId,
  getLegacyRestaurantOneConfig,
  createRestaurantContext
};
