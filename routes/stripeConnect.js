const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const pool = require("../database");

const STRIPE_CLIENT_ID = process.env.STRIPE_CONNECT_CLIENT_ID;
const STRIPE_REDIRECT_URI = process.env.STRIPE_CONNECT_REDIRECT_URI;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Inicia la conexión de un restaurante con su cuenta Stripe existente.
 *
 * Ejemplo:
 * GET /api/stripe/connect/authorize/1
 */
router.get("/authorize/:restauranteId", async (req, res) => {
  try {
    const restauranteId = Number(req.params.restauranteId);

    if (!Number.isInteger(restauranteId) || restauranteId <= 0) {
      return res.status(400).json({
        success: false,
        error: "restauranteId inválido",
      });
    }

    if (!STRIPE_CLIENT_ID || !STRIPE_REDIRECT_URI) {
      return res.status(500).json({
        success: false,
        error: "Faltan variables de entorno de Stripe Connect",
      });
    }

    const restauranteResult = await pool.query(
      `
      SELECT id, nombre, stripe_account_id
      FROM restaurantes
      WHERE id = $1
      LIMIT 1
      `,
      [restauranteId]
    );

    if (restauranteResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: "Restaurante no encontrado",
      });
    }

    const state = crypto.randomBytes(32).toString("hex");

    await pool.query(
      `
      INSERT INTO stripe_oauth_states (
        state,
        restaurante_id,
        expires_at,
        used
      )
      VALUES ($1, $2, NOW() + INTERVAL '15 minutes', false)
      `,
      [state, restauranteId]
    );

    const params = new URLSearchParams({
      response_type: "code",
      client_id: STRIPE_CLIENT_ID,
      scope: "read_write",
      redirect_uri: STRIPE_REDIRECT_URI,
      state,
    });

    const authorizationUrl =
      `https://connect.stripe.com/oauth/authorize?${params.toString()}`;

    return res.redirect(authorizationUrl);
  } catch (error) {
    console.error("Error iniciando Stripe OAuth:", error);

    return res.status(500).json({
      success: false,
      error: "No se pudo iniciar la conexión con Stripe",
    });
  }
});

/**
 * Stripe redirige aquí después de que el restaurante autoriza la conexión.
 */
router.get("/callback", async (req, res) => {
  const client = await pool.connect();

  try {
    const { code, state, error, error_description: errorDescription } = req.query;

    if (error) {
      console.error("Stripe OAuth rechazado:", {
        error,
        errorDescription,
      });

      return res.status(400).send(
        `La conexión con Stripe fue cancelada o rechazada: ${
          errorDescription || error
        }`
      );
    }

    if (!code || !state) {
      return res.status(400).send(
        "Stripe no devolvió el código o estado requerido."
      );
    }

    await client.query("BEGIN");

    const stateResult = await client.query(
      `
      SELECT id, restaurante_id, expires_at, used
      FROM stripe_oauth_states
      WHERE state = $1
      FOR UPDATE
      `,
      [state]
    );

    if (stateResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(400).send("Estado OAuth inválido.");
    }

    const oauthState = stateResult.rows[0];

    if (oauthState.used) {
      await client.query("ROLLBACK");
      return res.status(400).send("Este enlace OAuth ya fue utilizado.");
    }

    if (new Date(oauthState.expires_at).getTime() < Date.now()) {
      await client.query("ROLLBACK");
      return res.status(400).send("El enlace OAuth ha expirado.");
    }

    const tokenResponse = await fetch(
      "https://connect.stripe.com/oauth/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_secret: STRIPE_SECRET_KEY,
          code,
          grant_type: "authorization_code",
        }),
      }
    );

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      throw new Error(
        tokenData.error_description ||
          tokenData.error ||
          "Stripe rechazó el intercambio OAuth"
      );
    }

    if (!tokenData.stripe_user_id) {
      throw new Error("Stripe no devolvió stripe_user_id");
    }

    await client.query(
      `
      UPDATE restaurantes
      SET
        stripe_account_id = $1,
        stripe_connect_status = 'connected',
        stripe_connected_at = NOW(),
        stripe_livemode = $2
      WHERE id = $3
      `,
      [
        tokenData.stripe_user_id,
        Boolean(tokenData.livemode),
        oauthState.restaurante_id,
      ]
    );

    await client.query(
      `
      UPDATE stripe_oauth_states
      SET used = true
      WHERE id = $1
      `,
      [oauthState.id]
    );

    await client.query("COMMIT");

    return res.status(200).send(`
      <!DOCTYPE html>
      <html lang="es">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Stripe conectado</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              background: #f5f7fb;
              display: flex;
              justify-content: center;
              align-items: center;
              min-height: 100vh;
              margin: 0;
            }

            .card {
              background: white;
              max-width: 520px;
              padding: 40px;
              border-radius: 16px;
              box-shadow: 0 10px 30px rgba(0,0,0,.08);
              text-align: center;
            }

            h1 {
              color: #1f2937;
            }

            p {
              color: #4b5563;
              line-height: 1.5;
            }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Cuenta Stripe conectada</h1>
            <p>
              La cuenta Stripe del restaurante fue conectada correctamente
              con Denix Orders.
            </p>
            <p>Ya puedes cerrar esta ventana.</p>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    console.error("Error completando Stripe OAuth:", error);

    return res.status(500).send(
      "No se pudo completar la conexión con Stripe. Revisa los registros del servidor."
    );
  } finally {
    client.release();
  }
});


/**
 * Consulta y verifica una cuenta Stripe conectada.
 *
 * Ejemplo:
 * GET /api/stripe/connect/status/1
 */
router.get("/status/:restauranteId", async (req, res) => {
  try {
    const restauranteId = Number(req.params.restauranteId);

    if (!Number.isInteger(restauranteId) || restauranteId <= 0) {
      return res.status(400).json({
        success: false,
        error: "restauranteId inválido",
      });
    }

    const restauranteResult = await pool.query(
      `
      SELECT
        id,
        nombre,
        stripe_account_id,
        stripe_connect_status,
        stripe_livemode
      FROM restaurantes
      WHERE id = $1
      LIMIT 1
      `,
      [restauranteId]
    );

    if (restauranteResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: "Restaurante no encontrado",
      });
    }

    const restaurante = restauranteResult.rows[0];

    if (!restaurante.stripe_account_id) {
      return res.status(400).json({
        success: false,
        error: "El restaurante todavía no tiene una cuenta Stripe conectada",
      });
    }

    const stripeResponse = await fetch(
      `https://api.stripe.com/v1/accounts/${encodeURIComponent(
        restaurante.stripe_account_id
      )}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        },
      }
    );

    const stripeAccount = await stripeResponse.json();

    if (!stripeResponse.ok) {
      console.error("Stripe account retrieve error:", stripeAccount);

      return res.status(502).json({
        success: false,
        error:
          stripeAccount?.error?.message ||
          "No se pudo consultar la cuenta conectada en Stripe",
      });
    }

    const isReady =
      stripeAccount.charges_enabled === true &&
      stripeAccount.payouts_enabled === true &&
      stripeAccount.details_submitted === true;

    await pool.query(
      `
      UPDATE restaurantes
      SET
        stripe_connect_status = $1
      WHERE id = $2
      `,
      [isReady ? "active" : "connected_pending", restauranteId]
    );

    return res.json({
      success: true,
      restaurante: {
        id: restaurante.id,
        nombre: restaurante.nombre,
      },
      stripe: {
        account_id: stripeAccount.id,
        type: stripeAccount.type,
        country: stripeAccount.country,
        default_currency: stripeAccount.default_currency,
        charges_enabled: stripeAccount.charges_enabled,
        payouts_enabled: stripeAccount.payouts_enabled,
        details_submitted: stripeAccount.details_submitted,
        livemode: Boolean(stripeAccount.livemode),
        ready_for_payments: isReady,
        requirements: {
          currently_due:
            stripeAccount.requirements?.currently_due || [],
          eventually_due:
            stripeAccount.requirements?.eventually_due || [],
          past_due:
            stripeAccount.requirements?.past_due || [],
          disabled_reason:
            stripeAccount.requirements?.disabled_reason || null,
        },
      },
    });
  } catch (error) {
    console.error("Error consultando Stripe Connect:", error);

    return res.status(500).json({
      success: false,
      error: "No se pudo verificar la cuenta Stripe conectada",
    });
  }
});

/**
 * Pago de prueba con Direct Charge.
 *
 * POST /api/stripe/connect/test-payment/1
 */
router.post("/test-payment/:restauranteId", async (req, res) => {
  try {
    const restauranteId = Number(req.params.restauranteId);

    if (!Number.isInteger(restauranteId) || restauranteId <= 0) {
      return res.status(400).json({
        success: false,
        error: "restauranteId inválido",
      });
    }

    const restauranteResult = await pool.query(
      `
      SELECT
        id,
        nombre,
        stripe_account_id,
        stripe_connect_status,
        stripe_livemode
      FROM restaurantes
      WHERE id = $1
      LIMIT 1
      `,
      [restauranteId]
    );

    if (restauranteResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: "Restaurante no encontrado",
      });
    }

    const restaurante = restauranteResult.rows[0];

    if (!restaurante.stripe_account_id) {
      return res.status(400).json({
        success: false,
        error: "El restaurante no tiene Stripe conectado",
      });
    }

    if (restaurante.stripe_livemode === true) {
      return res.status(400).json({
        success: false,
        error: "Esta ruta solo puede usarse en modo de prueba",
      });
    }

    /*
     * Prueba:
     * Cliente paga $20.00
     * Denix recibe $2.50
     * Restaurante recibe el resto menos el fee real de Stripe.
     */
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: 2000,
        currency: "usd",

        payment_method: "pm_card_visa",
        payment_method_types: ["card"],
        confirm: true,

        application_fee_amount: 250,

        description: "Prueba Stripe Connect Denix - Pickup",

        metadata: {
          restaurante_id: String(restaurante.id),
          restaurante_nombre: restaurante.nombre,
          order_type: "pickup",
          denix_fee_cents: "250",
          source: "denix_connect_test",
        },
      },
      {
        stripeAccount: restaurante.stripe_account_id,
      }
    );

    return res.json({
      success: true,
      message: "Pago directo de prueba realizado correctamente",
      payment: {
        payment_intent_id: paymentIntent.id,
        status: paymentIntent.status,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        application_fee_amount:
          paymentIntent.application_fee_amount,
        connected_account:
          restaurante.stripe_account_id,
      },
    });
  } catch (error) {
    console.error("Error en pago Direct Charge de prueba:", error);

    return res.status(500).json({
      success: false,
      error:
        error?.raw?.message ||
        error.message ||
        "No se pudo realizar el pago de prueba",
    });
  }
});

module.exports = router;