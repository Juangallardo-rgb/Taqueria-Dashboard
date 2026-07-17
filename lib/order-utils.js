const IGNORED_WOO_ORDER_STATUSES = new Set([
  'checkout-draft',
  'auto-draft',
  'draft',
  'failed',
  'cancelled'
]);

function getWooShippingText(order) {
  return (order?.shipping_lines || [])
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

function detectarTipoPedidoWoo(order) {
  const shippingText = getWooShippingText(order);

  const isPickup =
    shippingText.includes('local_pickup') ||
    shippingText.includes('pickup') ||
    shippingText.includes('pick up') ||
    shippingText.includes('recoger');

  if (isPickup) return 'pickup';

  const isDelivery =
    shippingText.includes('delivery') ||
    shippingText.includes('shipday') ||
    shippingText.includes('local_delivery') ||
    shippingText.includes('envio') ||
    shippingText.includes('envío') ||
    hasWooShippingAddress(order);

  if (isDelivery) return 'delivery';

  // Conserva el comportamiento existente: un método desconocido no se
  // convierte en pickup antes de que Shipday responda.
  return 'delivery';
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
  getWooShippingText,
  hasWooShippingAddress,
  detectarTipoPedidoWoo,
  buildWooOrderItems,
  getWooDeliveryAddress,
  shouldIgnoreWooOrder
};
