function createOrderNotifier({
  pool,
  invalidateOrderCache = () => {},
  publishAdminEvent = () => {},
  sendNewOrderPush,
  logger = console
}) {
  async function notifyStoredOrder(
    restauranteId,
    order,
    storedOrder,
    normalizedOrder
  ) {
    invalidateOrderCache(restauranteId);
    publishAdminEvent(storedOrder?.inserted ? 'order_created' : 'order_updated', {
      restaurante_id: restauranteId,
      order: {
        woo_order_id: normalizedOrder.wooOrderId,
        total: normalizedOrder.total,
        estado: normalizedOrder.estado,
        customer_name: normalizedOrder.customerName,
        order_type: normalizedOrder.tipoPedido,
        created_at: storedOrder?.created_at || new Date().toISOString()
      }
    });

    const pushClaim = await pool.query(
      `UPDATE pedidos
       SET push_notified = TRUE,
           push_notified_at = NOW(),
           push_notification_error = NULL
       WHERE woo_order_id = $1
         AND restaurante_id = $2
         AND COALESCE(push_notified, FALSE) = FALSE
       RETURNING id`,
      [String(order.id), Number(restauranteId)]
    );

    if (!pushClaim.rows.length) {
      logger.log('PUSH OMITIDO: orden ya notificada:', order.id);
      return { pushSent: false, alreadyClaimed: true };
    }

    try {
      const result = await sendNewOrderPush(restauranteId, order);

      if (result.sinDispositivos) {
        await pool.query(
          `UPDATE pedidos
           SET push_notification_error = $1
           WHERE woo_order_id = $2
             AND restaurante_id = $3`,
          [
            'No habia dispositivos activos suscritos',
            String(order.id),
            Number(restauranteId)
          ]
        );
      }

      return {
        pushSent: true,
        alreadyClaimed: false,
        result
      };
    } catch (error) {
      logger.error('ERROR PUSH NUEVO PEDIDO:', error.message);
      await pool.query(
        `UPDATE pedidos
         SET push_notified = FALSE,
             push_notified_at = NULL,
             push_notification_error = $1
         WHERE woo_order_id = $2
           AND restaurante_id = $3`,
        [error.message, String(order.id), Number(restauranteId)]
      );

      return { pushSent: false, alreadyClaimed: false, error };
    }
  }

  return { notifyStoredOrder };
}

module.exports = { createOrderNotifier };
