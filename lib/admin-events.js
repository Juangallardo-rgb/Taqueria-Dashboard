const ADMIN_EVENT_TYPES = new Set([
  'order_created',
  'order_updated',
  'restaurant_status_changed',
  'refund_updated',
  'delivery_updated'
]);

function safeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeOrder(order = {}) {
  return {
    woo_order_id: order.woo_order_id === undefined ? null : String(order.woo_order_id),
    total: safeNumber(order.total),
    estado: String(order.estado || '').trim().toLowerCase() || null,
    customer_name: String(order.customer_name || '').slice(0, 160) || 'Cliente',
    order_type: order.order_type === 'pickup' ? 'pickup' : 'delivery',
    created_at: order.created_at || new Date().toISOString()
  };
}

function sanitizeAdminEvent(type, payload = {}) {
  if (!ADMIN_EVENT_TYPES.has(type)) return null;
  const restauranteId = safeNumber(payload.restaurante_id);
  if (!Number.isInteger(restauranteId) || restauranteId <= 0) return null;

  if (type === 'order_created' || type === 'order_updated') {
    return {
      type,
      restaurante_id: restauranteId,
      order: sanitizeOrder(payload.order)
    };
  }

  if (type === 'restaurant_status_changed') {
    return {
      type,
      restaurante_id: restauranteId,
      abierto: Boolean(payload.abierto)
    };
  }

  if (type === 'refund_updated') {
    return {
      type,
      restaurante_id: restauranteId,
      woo_order_id: payload.woo_order_id === undefined ? null : String(payload.woo_order_id),
      refund_amount: safeNumber(payload.refund_amount)
    };
  }

  return {
    type,
    restaurante_id: restauranteId,
    order_number: payload.order_number === undefined ? null : String(payload.order_number),
    status: String(payload.status || '').slice(0, 80) || null,
    driver_name: String(payload.driver_name || '').slice(0, 160) || null
  };
}

function createAdminEventHub({ heartbeatMs = 25000 } = {}) {
  const clients = new Set();
  let nextEventId = 1;

  function writeEvent(response, event) {
    response.write(`id: ${nextEventId++}\n`);
    response.write(`event: ${event.type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  function subscribe(req, res) {
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
    res.write('retry: 5000\n');
    res.write(`event: connected\ndata: ${JSON.stringify({ type: 'connected' })}\n\n`);
    clients.add(res);

    const heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': heartbeat\n\n');
    }, heartbeatMs);
    heartbeat.unref?.();

    const close = () => {
      clearInterval(heartbeat);
      clients.delete(res);
    };
    req.on('close', close);
    res.on?.('close', close);
  }

  function publish(type, payload) {
    const event = sanitizeAdminEvent(type, payload);
    if (!event) return null;
    for (const response of clients) {
      if (response.writableEnded || response.destroyed) {
        clients.delete(response);
        continue;
      }
      writeEvent(response, event);
    }
    return event;
  }

  function close() {
    for (const response of clients) response.end?.();
    clients.clear();
  }

  return {
    subscribe,
    publish,
    close,
    getClientCount: () => clients.size
  };
}

module.exports = {
  ADMIN_EVENT_TYPES,
  sanitizeAdminEvent,
  createAdminEventHub
};
