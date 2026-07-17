function createPublicRestaurantStatusHandler({ pool }) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('Se requiere un pool PostgreSQL válido');
  }

  return async function publicRestaurantStatusHandler(req, res) {
    const webhookToken = String(req.params?.webhookToken || '').trim();

    if (!webhookToken) {
      return res.status(404).json({
        success: false,
        message: 'No encontrado'
      });
    }

    try {
      const result = await pool.query(
        `SELECT abierto, activo
         FROM restaurantes
         WHERE webhook_token = $1
         LIMIT 1`,
        [webhookToken]
      );

      const restaurant = result.rows[0];

      if (!restaurant) {
        return res.status(404).json({
          success: false,
          message: 'No encontrado'
        });
      }

      return res.status(200).json({
        abierto: restaurant.activo === false
          ? false
          : Boolean(restaurant.abierto)
      });
    } catch (error) {
      console.error('Error consultando estado público del restaurante:', error.message);
      return res.status(500).json({
        success: false,
        message: 'Error consultando estado'
      });
    }
  };
}

module.exports = { createPublicRestaurantStatusHandler };
