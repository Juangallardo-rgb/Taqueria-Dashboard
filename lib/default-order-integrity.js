const axios = require('axios');
const pool = require('../database');
const { createRestaurantContext } = require('./restaurant-context');
const { createOperationalConfig } = require('./operational-config');
const { invalidarCachePedidos } = require('./order-cache');
const { createOrderIntegrityService } = require('./order-integrity');

const { getRestaurantIntegrationConfig } = createRestaurantContext({ pool });
const { getOperationalRestaurantConfig } = createOperationalConfig({
  pool,
  getRestaurantIntegrationConfig
});

module.exports = createOrderIntegrityService({
  pool,
  getOperationalRestaurantConfig,
  httpClient: axios,
  invalidateOrderCache: invalidarCachePedidos
});
