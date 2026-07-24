const IGNORED_WOO_ORDER_STATUSES = new Set([
  'checkout-draft',
  'auto-draft',
  'draft',
  'failed',
  'cancelled'
]);
const EXPLICIT_WOO_ORDER_TYPE_KEY = '_denix_order_type';
const VALID_WOO_ORDER_TYPES = new Set(['pickup', 'delivery']);

function getWooShippingText(order) {
  const shippingLines = Array.isArray(order?.shipping_lines)
    ? order.shipping_lines
    : [];

  return shippingLines
    .map(line => `${line.method_id || ''} ${line.method_title || ''}`)
    .join(' ')
    .toLowerCase();
}

function hasWooShippingAddress(order) {
  return Boolean(
    order?.shipping?.address_1 ||
    order?.shipping?.city ||
    order?.shipping?.postcode
  );
}

function getExplicitWooOrderType(order) {
  if (!Array.isArray(order?.meta_data)) return null;

  for (const meta of order.meta_data) {
    if (
      !meta ||
      typeof meta !== 'object' ||
      meta.key !== EXPLICIT_WOO_ORDER_TYPE_KEY ||
      typeof meta.value !== 'string'
    ) {
      continue;
    }

    const normalizedValue = meta.value.trim().toLowerCase();
    if (VALID_WOO_ORDER_TYPES.has(normalizedValue)) {
      return normalizedValue;
    }
  }

  return null;
}

function resolverTipoPedidoWoo(order) {
  const explicitOrderType = getExplicitWooOrderType(order);
  if (explicitOrderType) {
    return {
      tipoPedido: explicitOrderType,
      tipoPedidoExplicito: true
    };
  }

  const shippingText = getWooShippingText(order);

  const isPickup =
    shippingText.includes('local_pickup') ||
    shippingText.includes('pickup') ||
    shippingText.includes('pick up') ||
    shippingText.includes('recoger');

  if (isPickup) {
    return {
      tipoPedido: 'pickup',
      tipoPedidoExplicito: false
    };
  }

  const isDelivery =
    shippingText.includes('delivery') ||
    shippingText.includes('shipday') ||
    shippingText.includes('local_delivery') ||
    shippingText.includes('envio') ||
    shippingText.includes('envío') ||
    hasWooShippingAddress(order);

  if (isDelivery) {
    return {
      tipoPedido: 'delivery',
      tipoPedidoExplicito: false
    };
  }

  // Conserva el comportamiento existente: un método desconocido no se
  // convierte en pickup antes de que Shipday responda.
  return {
    tipoPedido: 'delivery',
    tipoPedidoExplicito: false
  };
}

function detectarTipoPedidoWoo(order) {
  return resolverTipoPedidoWoo(order).tipoPedido;
}

function buildWooOrderItems(order) {
  return (order?.line_items || []).map(item => {
    const extras = (item.meta_data || [])
      .filter(meta => meta.value && meta.value !== '')
      .map(meta => `${meta.key}: ${meta.value}`)
      .join(', ');

    return {
      nombre: `${item.name}${extras ? ` (${extras})` : ''}`,
      cantidad: item.quantity
    };
  });
}

function getWooDeliveryAddress(order) {
  return {
    deliveryAddress:
      order?.shipping?.address_1 || order?.billing?.address_1 || '',
    deliveryCity:
      order?.shipping?.city || order?.billing?.city || '',
    deliveryPostcode:
      order?.shipping?.postcode || order?.billing?.postcode || ''
  };
}

function shouldIgnoreWooOrder(order) {
  return IGNORED_WOO_ORDER_STATUSES.has(
    String(order?.status || '').trim().toLowerCase()
  );
}

module.exports = {
  IGNORED_WOO_ORDER_STATUSES,
  EXPLICIT_WOO_ORDER_TYPE_KEY,
  getWooShippingText,
  hasWooShippingAddress,
  getExplicitWooOrderType,
  resolverTipoPedidoWoo,
  detectarTipoPedidoWoo,
  buildWooOrderItems,
  getWooDeliveryAddress,
  shouldIgnoreWooOrder
};
