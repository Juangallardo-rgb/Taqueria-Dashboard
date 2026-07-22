'use strict';

function createRestaurantProductCache({ ttlMs = 5000, now = Date.now } = {}) {
  const entries = new Map();

  function key(restauranteId) {
    return String(restauranteId);
  }

  return {
    get(restauranteId) {
      const cacheKey = key(restauranteId);
      const entry = entries.get(cacheKey);

      if (!entry) return undefined;
      if (now() - entry.createdAt >= ttlMs) {
        entries.delete(cacheKey);
        return undefined;
      }

      return entry.value;
    },

    set(restauranteId, value) {
      entries.set(key(restauranteId), { value, createdAt: now() });
      return value;
    },

    invalidate(restauranteId) {
      return entries.delete(key(restauranteId));
    },

    has(restauranteId) {
      return entries.has(key(restauranteId));
    }
  };
}

module.exports = { createRestaurantProductCache };
