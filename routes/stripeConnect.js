const express = require("express");
const crypto = require("crypto");
const Stripe = require("stripe");

const router = express.Router();
const pool = require("../database");

const STRIPE_CLIENT_ID = process.env.STRIPE_CONNECT_CLIENT_ID;
const STRIPE_REDIRECT_URI = process.env.STRIPE_CONNECT_REDIRECT_URI;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

const stripe = new Stripe(STRIPE_SECRET_KEY);

/**
 * Fees finales Denix:
 * Pickup: $2.98
 * Delivery: $2.98 + $9.88 = $12.86
 */
const DENIX_PICKUP_FEE_CENTS = 298;
const DENIX_DELIVERY_FEE_CENTS = 1286;

function getDenixApplicationFeeCents(orderType) {
  return orderType === "delivery"
    ? DENIX_DELIVERY_FEE_CENTS
    : DENIX_PICKUP_FEE_CENTS;
}

function validateDenixSecret(req) {
  const secretHeader = req.headers["x-denix-secret"];

  return (
    process.env.DENIX_WOO_PAYMENT_SECRET &&
    secretHeader === process.env.DENIX_WOO_PAYMENT_SECRET
  );
}

/**
 * Inicia la conexión de un restaurante con su cuenta Stripe existente.
 *
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

    if (!STRIPE_CLIENT_ID || !STRIPE_REDIRECT_URI || !STRIPE_SECRET_KEY) {
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
      VALUES ($1, $2, NOW() + INTERVAL '2 hours', false)
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
 *
 * GET /api/stripe/connect/callback
 */
router.get("/callback", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      code,
      state,
      error,
      error_description: errorDescription,
    } = req.query;

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
 * Consultar estado de cuenta conectada.
 *
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

    const stripeAccount = await stripe.accounts.retrieve(
      restaurante.stripe_account_id
    );

    const isReady =
      stripeAccount.charges_enabled === true &&
      stripeAccount.payouts_enabled === true &&
      stripeAccount.details_submitted === true;

    await pool.query(
      `
      UPDATE restaurantes
      SET stripe_connect_status = $1
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
      error:
        error?.raw?.message ||
        error.message ||
        "No se pudo verificar la cuenta Stripe conectada",
    });
  }
});

/**
 * Pago temporal de prueba.
 *
 * POST /api/stripe/connect/test-payment/1
 *
 * Body opcional:
 * {
 *   "amountCents": 2000,
 *   "orderType": "pickup"
 * }
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

    const {
      amountCents = 2000,
      orderType = "pickup",
    } = req.body || {};

    const parsedAmountCents = Number(amountCents);
    const parsedOrderType = String(orderType).toLowerCase();

    if (!Number.isInteger(parsedAmountCents) || parsedAmountCents <= 50) {
      return res.status(400).json({
        success: false,
        error: "amountCents inválido",
      });
    }

    if (parsedOrderType !== "pickup" && parsedOrderType !== "delivery") {
      return res.status(400).json({
        success: false,
        error: "orderType debe ser pickup o delivery",
      });
    }

    const restauranteResult = await pool.query(
      `
      SELECT
        id,
        nombre,
        stripe_account_id,
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

    const applicationFeeCents =
      getDenixApplicationFeeCents(parsedOrderType);

    if (parsedAmountCents <= applicationFeeCents) {
      return res.status(400).json({
        success: false,
        error: "El total no puede ser menor o igual al fee de Denix",
      });
    }

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: parsedAmountCents,
        currency: "usd",

        payment_method: "pm_card_visa",
        payment_method_types: ["card"],
        confirm: true,

        application_fee_amount: applicationFeeCents,

        description:
          parsedOrderType === "delivery"
            ? "Prueba Stripe Connect Denix - Delivery"
            : "Prueba Stripe Connect Denix - Pickup",

        metadata: {
          restaurante_id: String(restaurante.id),
          restaurante_nombre: restaurante.nombre,
          order_type: parsedOrderType,
          denix_application_fee_cents: String(applicationFeeCents),
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
        application_fee_amount: paymentIntent.application_fee_amount,
        connected_account: restaurante.stripe_account_id,
        order_type: parsedOrderType,
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

/**
 * Crear y/o confirmar PaymentIntent para WooCommerce.
 *
 * POST /api/stripe/connect/create-payment-intent
 */
router.post("/create-payment-intent", async (req, res) => {
  try {
    if (!validateDenixSecret(req)) {
      return res.status(401).json({
        success: false,
        error: "No autorizado",
      });
    }

    const {
      restauranteId,
      wooOrderId,
      amountCents,
      currency,
      orderType,
      customerEmail,
      paymentMethodId,
      confirmPayment,
    } = req.body;

    const parsedRestauranteId = Number(restauranteId);
    const parsedWooOrderId = String(wooOrderId || "").trim();
    const parsedAmountCents = Number(amountCents);
    const parsedCurrency = String(currency || "usd").toLowerCase();
    const parsedOrderType = String(orderType || "pickup").toLowerCase();
    const parsedPaymentMethodId = String(paymentMethodId || "").trim();
    const shouldConfirmPayment = confirmPayment === true;

    if (!Number.isInteger(parsedRestauranteId) || parsedRestauranteId <= 0) {
      return res.status(400).json({
        success: false,
        error: "restauranteId inválido",
      });
    }

    if (!parsedWooOrderId) {
      return res.status(400).json({
        success: false,
        error: "wooOrderId requerido",
      });
    }

    if (!Number.isInteger(parsedAmountCents) || parsedAmountCents <= 50) {
      return res.status(400).json({
        success: false,
        error: "amountCents inválido",
      });
    }

    if (parsedOrderType !== "pickup" && parsedOrderType !== "delivery") {
      return res.status(400).json({
        success: false,
        error: "orderType inválido",
      });
    }

    if (shouldConfirmPayment && !parsedPaymentMethodId.startsWith("pm_")) {
      return res.status(400).json({
        success: false,
        error: "paymentMethodId requerido para confirmar el pago",
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
      [parsedRestauranteId]
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

    const applicationFeeCents =
      getDenixApplicationFeeCents(parsedOrderType);

    if (parsedAmountCents <= applicationFeeCents) {
      return res.status(400).json({
        success: false,
        error: "El total de la orden no puede ser menor o igual al fee de Denix",
      });
    }

    const paymentIntentPayload = {
      amount: parsedAmountCents,
      currency: parsedCurrency,

      application_fee_amount: applicationFeeCents,

      receipt_email: customerEmail || undefined,

      description: `WooCommerce Order #${parsedWooOrderId}`,

      metadata: {
        woo_order_id: parsedWooOrderId,
        restaurante_id: String(restaurante.id),
        restaurante_nombre: restaurante.nombre,
        order_type: parsedOrderType,
        denix_application_fee_cents: String(applicationFeeCents),
        source: "denix_woocommerce_embedded_checkout",
      },
    };

    if (shouldConfirmPayment) {
      paymentIntentPayload.payment_method = parsedPaymentMethodId;
      paymentIntentPayload.confirm = true;
      paymentIntentPayload.confirmation_method = "automatic";
      paymentIntentPayload.payment_method_types = ["card"];
    } else {
      paymentIntentPayload.automatic_payment_methods = {
        enabled: true,
      };
    }

    const paymentIntent = await stripe.paymentIntents.create(
      paymentIntentPayload,
      {
        stripeAccount: restaurante.stripe_account_id,
      }
    );

    /**
     * Guardar datos Stripe Connect en pedidos.
     * Si la orden aún no está insertada por el webhook, este UPDATE simplemente no afectará filas.
     */
    await pool.query(
      `
      UPDATE pedidos
      SET
        stripe_payment_intent_id = $1,
        stripe_account_id = $2,
        denix_application_fee_cents = $3,
        payment_split_status = $4
      WHERE woo_order_id = $5
        AND restaurante_id = $6
      `,
      [
        paymentIntent.id,
        restaurante.stripe_account_id,
        applicationFeeCents,
        paymentIntent.status,
        parsedWooOrderId,
        parsedRestauranteId,
      ]
    );

    return res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      status: paymentIntent.status,
      connectedAccount: restaurante.stripe_account_id,
      applicationFeeAmount: applicationFeeCents,
      nextAction: paymentIntent.next_action || null,
    });
  } catch (error) {
    console.error("Error creando PaymentIntent WooCommerce:", error);

    return res.status(500).json({
      success: false,
      error:
        error?.raw?.message ||
        error.message ||
        "No se pudo crear el PaymentIntent",
    });
  }
});

/**
 * Refund para pagos Stripe Connect Direct Charges.
 *
 * Regla Denix:
 * - Refund total: cliente recibe todo, restaurante asume todo, Denix conserva fee.
 * - Refund parcial: cliente recibe el monto parcial, restaurante asume, Denix conserva fee.
 * - Por eso refund_application_fee SIEMPRE es false.
 *
 * POST /api/stripe/connect/refund
 */
router.post("/refund", async (req, res) => {
  try {
    if (!validateDenixSecret(req)) {
      return res.status(401).json({
        success: false,
        error: "No autorizado",
      });
    }

    const {
      restauranteId,
      wooOrderId,
      refundType,
      refundAmountCents,
      reason,
      refundRequestId,
    } = req.body;

    const parsedRestauranteId = Number(restauranteId);
    const parsedWooOrderId = String(wooOrderId || "").trim();
    const parsedRefundType = String(refundType || "").toLowerCase();
    const parsedRefundAmountCents = Number(refundAmountCents || 0);
    const parsedRefundRequestId = String(refundRequestId || "").trim();

    if (!Number.isInteger(parsedRestauranteId) || parsedRestauranteId <= 0) {
      return res.status(400).json({
        success: false,
        error: "restauranteId inválido",
      });
    }

    if (!parsedWooOrderId) {
      return res.status(400).json({
        success: false,
        error: "wooOrderId requerido",
      });
    }

    if (parsedRefundType !== "total" && parsedRefundType !== "partial") {
      return res.status(400).json({
        success: false,
        error: "refundType debe ser total o partial",
      });
    }

    if (
      parsedRefundType === "partial" &&
      (!Number.isInteger(parsedRefundAmountCents) ||
        parsedRefundAmountCents <= 0)
    ) {
      return res.status(400).json({
        success: false,
        error: "refundAmountCents requerido para refund parcial",
      });
    }

    const pedidoResult = await pool.query(
      `
      SELECT
        id,
        woo_order_id,
        restaurante_id,
        total,
        refunded,
        refund_amount,
        stripe_payment_intent_id,
        stripe_account_id
      FROM pedidos
      WHERE woo_order_id = $1
        AND restaurante_id = $2
      LIMIT 1
      `,
      [parsedWooOrderId, parsedRestauranteId]
    );

    if (pedidoResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: "Pedido no encontrado en la base de datos",
      });
    }

    const pedido = pedidoResult.rows[0];

    if (!pedido.stripe_payment_intent_id || !pedido.stripe_account_id) {
      return res.status(400).json({
        success: false,
        error:
          "Este pedido no tiene datos de Stripe Connect guardados. No se puede hacer refund automático.",
      });
    }

    if (parsedRefundType === "total" && pedido.refunded === true) {
      return res.status(400).json({
        success: false,
        error: "Este pedido ya tiene un refund total registrado",
      });
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(
      pedido.stripe_payment_intent_id,
      {},
      {
        stripeAccount: pedido.stripe_account_id,
      }
    );

    if (paymentIntent.status !== "succeeded") {
      return res.status(400).json({
        success: false,
        error: `El pago no está completado. Estado actual: ${paymentIntent.status}`,
      });
    }

    const totalPaidCents = Number(paymentIntent.amount);
    const amountRefundedAlreadyCents = Number(paymentIntent.amount_received || 0) > 0
      ? Number(paymentIntent.amount) - Number(paymentIntent.amount_capturable || 0)
      : 0;

    let amountToRefundCents = null;

    if (parsedRefundType === "partial") {
      amountToRefundCents = parsedRefundAmountCents;

      if (amountToRefundCents >= totalPaidCents) {
        return res.status(400).json({
          success: false,
          error: "Para devolver el total usa refundType total, no partial.",
        });
      }
    }

    const refundPayload = {
      payment_intent: pedido.stripe_payment_intent_id,

      /**
       * CLAVE DEL MODELO DENIX:
       * Denix conserva su fee siempre.
       */
      refund_application_fee: false,

      metadata: {
        woo_order_id: parsedWooOrderId,
        restaurante_id: String(parsedRestauranteId),
        refund_type: parsedRefundType,
        denix_keeps_fee: "true",
        reason: reason ? String(reason).slice(0, 300) : "",
      },
    };

    if (parsedRefundType === "partial") {
      refundPayload.amount = amountToRefundCents;
    }

    const safeRequestId =
      parsedRefundRequestId ||
      crypto.randomBytes(12).toString("hex");

    const idempotencyKey =
      `denix_refund_${parsedWooOrderId}_${parsedRefundType}_${amountToRefundCents || "remaining"}_${safeRequestId}`;

    const refund = await stripe.refunds.create(
      refundPayload,
      {
        stripeAccount: pedido.stripe_account_id,
        idempotencyKey,
      }
    );

    const refundedAmountCents =
      refund.amount || amountToRefundCents || totalPaidCents;

    await pool.query(
      `
      INSERT INTO stripe_connect_refunds (
        woo_order_id,
        restaurante_id,
        stripe_payment_intent_id,
        stripe_account_id,
        stripe_refund_id,
        refund_type,
        refund_amount_cents,
        refund_application_fee,
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8)
      ON CONFLICT (stripe_refund_id) DO NOTHING
      `,
      [
        parsedWooOrderId,
        parsedRestauranteId,
        pedido.stripe_payment_intent_id,
        pedido.stripe_account_id,
        refund.id,
        parsedRefundType,
        refundedAmountCents,
        refund.status,
      ]
    );

    await pool.query(
      `
      UPDATE pedidos
      SET
        refunded = CASE WHEN $1 = 'total' THEN true ELSE refunded END,
        refund_amount = COALESCE(refund_amount, 0) + ($2::numeric / 100),
        stripe_refund_id = $3,
        stripe_refund_status = $4,
        stripe_refund_amount_cents = COALESCE(stripe_refund_amount_cents, 0) + $2,
        stripe_refunded_at = NOW(),
        stripe_refund_error = NULL
      WHERE woo_order_id = $5
        AND restaurante_id = $6
      `,
      [
        parsedRefundType,
        refundedAmountCents,
        refund.id,
        refund.status,
        parsedWooOrderId,
        parsedRestauranteId,
      ]
    );

    return res.json({
      success: true,
      message: "Refund procesado correctamente. Denix conserva su fee.",
      refund: {
        id: refund.id,
        status: refund.status,
        amount: refund.amount,
        currency: refund.currency,
        refund_application_fee: false,
      },
      denix_keeps_fee: true,
    });
  } catch (error) {
    console.error("Error procesando refund Stripe Connect:", error);

    const errorMessage =
      error?.raw?.message ||
      error.message ||
      "No se pudo procesar el refund";

    try {
      const { restauranteId, wooOrderId } = req.body || {};

      if (wooOrderId && restauranteId) {
        await pool.query(
          `
          UPDATE pedidos
          SET stripe_refund_error = $1
          WHERE woo_order_id = $2
            AND restaurante_id = $3
          `,
          [errorMessage, String(wooOrderId), Number(restauranteId)]
        );
      }
    } catch (_) {}

    return res.status(500).json({
      success: false,
      error: errorMessage,
    });
  }
});

module.exports = router;