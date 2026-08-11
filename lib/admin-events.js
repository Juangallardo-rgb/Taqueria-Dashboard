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

function safeWrite(response, chunk) {
  try {
    if (!response || response.writableEnded || response.destroyed) return false;
    response.write(chunk);
    return true;
  } catch {
    return false;
  }
}

function safeEnd(response) {
  try {
    response?.end?.();
  } catch {
    // SSE es best-effort: cerrar un cliente roto tampoco debe propagarse.
  }
}

function createAdminEventHub({ heartbeatMs = 25000 } = {}) {
  const clients = new Map();
  let nextEventId = 1;

  function writeEvent(response, event) {
    const eventId = nextEventId++;
    if (!safeWrite(response, `id: ${eventId}\n`)) return false;
    if (!safeWrite(response, `event: ${event.type}\n`)) return false;
    return safeWrite(response, `data: ${JSON.stringify(event)}\n\n`);
  }

  function subscribe(req, res) {
    let heartbeat = null;
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      if (heartbeat) clearInterval(heartbeat);
      clients.delete(res);
    };

    try {
      res.status(200);
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.flushHeaders?.();
    } catch {
      remove();
      safeEnd(res);
      return;
    }

    if (
      !safeWrite(res, 'retry: 5000\n') ||
      !safeWrite(res, `event: connected\ndata: ${JSON.stringify({ type: 'connected' })}\n\n`)
    ) {
      remove();
      safeEnd(res);
      return;
    }

    clients.set(res, remove);
    heartbeat = setInterval(() => {
      if (!safeWrite(res, ': heartbeat\n\n')) remove();
    }, heartbeatMs);
    heartbeat.unref?.();

    req.on('close', remove);
    res.on?.('close', remove);
    res.on?.('error', remove);
  }

  function publish(type, payload) {
    let event;
    try {
      event = sanitizeAdminEvent(type, payload);
    } catch {
      return null;
    }
    if (!event) return null;

    for (const [response, remove] of clients) {
      if (response.writableEnded || response.destroyed || !writeEvent(response, event)) {
        remove();
        continue;
      }
    }
    return event;
  }

  function close() {
    for (const [response, remove] of clients) {
      remove();
      safeEnd(response);
    }
  }

  return {
    subscribe,
    publish,
    close,
    getClientCount: () => clients.size
  };
}

function createBestEffortAdminPublisher({ analytics, events, logger = console } = {}) {
  return function publishAdminEvent(type, payload) {
    try {
      analytics?.invalidate?.();
      return events?.publish?.(type, payload) || null;
    } catch (error) {
      try {
        logger?.warn?.('No se pudo publicar evento admin en vivo:', error?.message || error);
      } catch {
        // Incluso el logging debe permanecer fuera del camino operativo.
      }
      return null;
    }
  };
}

module.exports = {
  ADMIN_EVENT_TYPES,
  sanitizeAdminEvent,
  safeWrite,
  createAdminEventHub,
  createBestEffortAdminPublisher
};
