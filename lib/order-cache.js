const cachePedidos = new Map();
const CACHE_PEDIDOS_MS = 5000;

function invalidarCachePedidos(restauranteId) {
  cachePedidos.delete(String(restauranteId));
}

module.exports = {
  cachePedidos,
  CACHE_PEDIDOS_MS,
  invalidarCachePedidos
};
