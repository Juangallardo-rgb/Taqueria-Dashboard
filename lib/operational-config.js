const { toPositiveInteger } = require('./restaurant-context');

class OperationalConfigError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = 'OperationalConfigError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function isLegacyRestaurantOneEnabled(env = process.env) {
  return String(env.ENABLE_LEGACY_RESTAURANT_1 || '').toLowerCase() === 'true';
}

function createOperationalConfig({
  pool,
  getRestaurantIntegrationConfig,
  env = process.env
}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('Se requiere un pool PostgreSQL válido');
  }

  if (typeof getRestaurantIntegrationConfig !== 'function') {
    throw new TypeError('Se requiere getRestaurantIntegrationConfig');
  }

  async function getOperationalRestaurantConfig(restauranteId, options = {}) {
    const cleanRestaurantId = toPositiveInteger(restauranteId);

    if (!cleanRestaurantId) {
      throw new OperationalConfigError(
        'El restaurante no es válido',
        400,
        'OPERATIONAL_RESTAURANT_INVALID'
      );
    }

    const config = await getRestaurantIntegrationConfig(cleanRestaurantId);

    if (!config) {
      throw new OperationalConfigError(
        'Restaurante no encontrado',
        404,
        'OPERATIONAL_RESTAURANT_NOT_FOUND'
      );
    }

    if (config.activo === false) {
      throw new OperationalConfigError(
        'El restaurante está inactivo',
        403,
        'OPERATIONAL_RESTAURANT_INACTIVE'
      );
    }

    if (cleanRestaurantId !== 1 && config.legacy) {
      throw new OperationalConfigError(
        'La configuración legacy solo está permitida para restaurante 1',
        500,
        'LEGACY_CONFIG_TENANT_VIOLATION'
      );
    }

    const required = Array.isArray(options.required) ? options.required : [];
    const missing = required.filter(field => !config[field]);

    if (missing.length) {
      throw new OperationalConfigError(
        `Falta configuración operativa del restaurante: ${missing.join(', ')}`,
        503,
        'OPERATIONAL_CONFIG_INCOMPLETE'
      );
    }

    return config;
  }

  async function resolveOperationalRestaurantByToken(webhookToken, options = {}) {
    const token = String(webhookToken || '').trim();

    if (!token) {
      throw new OperationalConfigError(
        'Webhook no encontrado',
        404,
        'WEBHOOK_TOKEN_MISSING'
      );
    }

    const result = await pool.query(
      `SELECT id
       FROM restaurantes
       WHERE webhook_token = $1
       LIMIT 1`,
      [token]
    );

    if (!result.rows.length) {
      throw new OperationalConfigError(
        'Webhook no encontrado',
        404,
        'WEBHOOK_TOKEN_NOT_FOUND'
      );
    }

    return getOperationalRestaurantConfig(result.rows[0].id, options);
  }

  async function getLegacyRestaurantOneOperationalConfig(options = {}) {
    if (!isLegacyRestaurantOneEnabled(env)) {
      throw new OperationalConfigError(
        'Compatibilidad legacy desactivada',
        404,
        'LEGACY_RESTAURANT_ONE_DISABLED'
      );
    }

    return getOperationalRestaurantConfig(1, options);
  }

  return {
    getOperationalRestaurantConfig,
    resolveOperationalRestaurantByToken,
    getLegacyRestaurantOneOperationalConfig,
    isLegacyRestaurantOneEnabled: () => isLegacyRestaurantOneEnabled(env)
  };
}

module.exports = {
  OperationalConfigError,
  isLegacyRestaurantOneEnabled,
  createOperationalConfig
};
