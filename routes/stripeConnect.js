const express = require("express");
const crypto = require("crypto");
const Stripe = require("stripe");

const router = express.Router();
const pool = require("../database");

const STRIPE_CLIENT_ID = process.env.STRIPE_CONNECT_CLIENT_ID;
const STRIPE_REDIRECT_URI = process.env.STRIPE_CONNECT_REDIRECT_URI;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const DENIX_WOO_PAYMENT_SECRET = process.env.DENIX_WOO_PAYMENT_SECRET;

const stripe = new Stripe(STRIPE_SECRET_KEY);

/**
 * Fees finales Denix:
 * Pickup: $2.98
 * Delivery: $2.98 + $9.88 = $12.86
 */
const DENIX_PICKUP_FEE_CENTS = 298;
const DENIX_DELIVERY_FEE_CENTS = 1286;

function isStripeLiveMode() {
  return String(STRIPE_SECRET_KEY || "").startsWith("sk_live_");
}

function getStripeKeyMode() {
  if (String(STRIPE_SECRET_KEY || "").startsWith("sk_live_")) return "live";
  if (String(STRIPE_SECRET_KEY || "").startsWith("sk_test_")) return "test";
  return "unknown";
}

function getDenixApplicationFeeCents(orderType) {
  return String(orderType).toLowerCase() === "delivery"
    ? DENIX_DELIVERY_FEE_CENTS
    : DENIX_PICKUP_FEE_CENTS;
}

function validateDenixSecret(req) {
  const secretHeader = req.headers["x-denix-secret"];

  return Boolean(
    DENIX_WOO_PAYMENT_SECRET &&
    secretHeader &&
    secretHeader === DENIX_WOO_PAYMENT_SECRET
  );
}

function validateStripeConfig() {
  const missing = [];

  if (!STRIPE_SECRET_KEY) missing.push("STRIPE_SECRET_KEY");
  if (!STRIPE_CLIENT_ID) missing.push("STRIPE_CONNECT_CLIENT_ID");
  if (!STRIPE_REDIRECT_URI) missing.push("STRIPE_CONNECT_REDIRECT_URI");

  return missing;
}

function toPositiveInteger(value) {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) return null;
  return numberValue;
}

async function getRestauranteById(restauranteId) {
  const result = await pool.query(
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

  return result.rows[0] || null;
}

async function getStripeAccountStatus(stripeAccountId) {
  const account = await stripe.accounts.retrieve(stripeAccountId);

  const readyForPayments =
    account.charges_enabled === true &&
    account.payouts_enabled === true &&
    account.details_submitted === true;

  return {
    account,
    readyForPayments,
    status: readyForPayments ? "active" : "connected_pending",
  };
}

/**
 * Iniciar conexión OAuth Stripe Connect.
 *
 * GET /api/stripe/connect/authorize/1
 */
router.get("/authorize/:restauranteId", async (req, res) => {
  try {
    const restauranteId = toPositiveInteger(req.params.restauranteId);

    if (!restauranteId) {
      return res.status(400).json({
        success: false,
        error: "restauranteId inválido",
      });
    }

    const missingConfig = validateStripeConfig();

    if (missingConfig.length > 0) {
      return res.status(500).json({
        success: false,
        error: "Faltan variables de entorno de Stripe Connect",
        missing: missingConfig,
      });
    }

    const restaurante = await getRestauranteById(restauranteId);

    if (!restaurante) {
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

    return res.redirect(
      `https://connect.stripe.com/oauth/authorize?${params.toString()}`
    );
  } catch (error) {
    console.error("Error iniciando Stripe OAuth:", error);

    return res.status(500).json({
      success: false,
      error: "No se pudo iniciar la conexión con Stripe",
    });
  }
});

/**
 * Callback OAuth Stripe Connect.
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
      return res.status(400).send(`
        <h2>Conexión cancelada</h2>
        <p>${errorDescription || error}</p>
      `);
    }

    if (!code || !state) {
      return res.status(400).send("Stripe no devolvió código o estado.");
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
      throw new Error("Stripe no devolvió stripe_user_id.");
    }

    const stripeAccountId = tokenData.stripe_user_id;
    const isLiveMode = isStripeLiveMode();

    let connectStatus = "connected";

    try {
      const accountStatus = await getStripeAccountStatus(stripeAccountId);
      connectStatus = accountStatus.status;
    } catch (accountError) {
      console.error("No se pudo verificar cuenta conectada:", accountError);
    }

    await client.query(
      `
      UPDATE restaurantes
      SET
        stripe_account_id = $1,
        stripe_connect_status = $2,
        stripe_connected_at = NOW(),
        stripe_livemode = $3
      WHERE id = $4
      `,
      [
        stripeAccountId,
        connectStatus,
        isLiveMode,
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
              background: #ffffff;
              max-width: 520px;
              padding: 38px;
              border-radius: 18px;
              box-shadow: 0 12px 35px rgba(0,0,0,.08);
              text-align: center;
            }

            h1 {
              color: #111827;
              margin-bottom: 12px;
            }

            p {
              color: #4b5563;
              line-height: 1.5;
            }

            .badge {
              display: inline-block;
              margin-top: 18px;
              padding: 10px 16px;
              border-radius: 999px;
              background: #dcfce7;
              color: #166534;
              font-weight: bold;
            }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Cuenta Stripe conectada ✅</h1>
            <p>La cuenta del restaurante fue conectada correctamente con Denix Orders.</p>
            <p>Ya puedes cerrar esta ventana y volver al panel.</p>
            <div class="badge">
              Modo ${isLiveMode ? "Producción / Live" : "Prueba / Test"}
            </div>
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
 * Verificar cuenta conectada.
 *
 * GET /api/stripe/connect/status/1
 */
router.get("/status/:restauranteId", async (req, res) => {
  try {
    const restauranteId = toPositiveInteger(req.params.restauranteId);

    if (!restauranteId) {
      return res.status(400).json({
        success: false,
        error: "restauranteId inválido",
      });
    }

    const restaurante = await getRestauranteById(restauranteId);

    if (!restaurante) {
      return res.status(404).json({
        success: false,
        error: "Restaurante no encontrado",
      });
    }

    if (!restaurante.stripe_account_id) {
      return res.status(400).json({
        success: false,
        error: "El restaurante todavía no tiene una cuenta Stripe conectada",
      });
    }

    const isLiveMode = isStripeLiveMode();
    const accountStatus = await getStripeAccountStatus(
      restaurante.stripe_account_id
    );

    const account = accountStatus.account;

    await pool.query(
      `
      UPDATE restaurantes
      SET
        stripe_connect_status = $1,
        stripe_livemode = $2
      WHERE id = $3
      `,
      [accountStatus.status, isLiveMode, restauranteId]
    );

    return res.json({
      success: true,
      backend: {
        stripe_key_mode: getStripeKeyMode(),
      },
      restaurante: {
        id: restaurante.id,
        nombre: restaurante.nombre,
      },
      stripe: {
        account_id: account.id,
        type: account.type,
        country: account.country,
        default_currency: account.default_currency,
        charges_enabled: account.charges_enabled,
        payouts_enabled: account.payouts_enabled,
        details_submitted: account.details_submitted,
        livemode: isLiveMode,
        ready_for_payments: accountStatus.readyForPayments,
        requirements: {
          currently_due: account.requirements?.currently_due || [],
          eventually_due: account.requirements?.eventually_due || [],
          past_due: account.requirements?.past_due || [],
          disabled_reason: account.requirements?.disabled_reason || null,
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
 * Pago de prueba interno.
 * Solo funciona en modo test.
 *
 * POST /api/stripe/connect/test-payment/1
 */
router.post("/test-payment/:restauranteId", async (req, res) => {
  try {
    const restauranteId = toPositiveInteger(req.params.restauranteId);

    if (!restauranteId) {
      return res.status(400).json({
        success: false,
        error: "restauranteId inválido",
      });
    }

    if (isStripeLiveMode()) {
      return res.status(400).json({
        success: false,
        error: "Esta ruta solo puede usarse en modo de prueba.",
      });
    }

    const restaurante = await getRestauranteById(restauranteId);

    if (!restaurante || !restaurante.stripe_account_id) {
      return res.status(400).json({
        success: false,
        error: "El restaurante no tiene Stripe conectado.",
      });
    }

    const orderType = req.body?.orderType || "pickup";
    const amountCents = toPositiveInteger(req.body?.amountCents) || 2000;
    const applicationFeeAmount = getDenixApplicationFeeCents(orderType);

    if (applicationFeeAmount >= amountCents) {
      return res.status(400).json({
        success: false,
        error: "El total del pago debe ser mayor que el fee de Denix.",
      });
    }

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: amountCents,
        currency: "usd",
        payment_method: "pm_card_visa",
        payment_method_types: ["card"],
        confirm: true,
        application_fee_amount: applicationFeeAmount,
        description: `Prueba Stripe Connect Denix - ${orderType}`,
        metadata: {
          restaurante_id: String(restaurante.id),
          restaurante_nombre: restaurante.nombre || "",
          order_type: String(orderType),
          denix_fee_cents: String(applicationFeeAmount),
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
 * Crear PaymentIntent real para WooCommerce con Direct Charge.
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
      currency = "usd",
      orderType = "pickup",
      customerEmail,
      paymentMethodId,
      confirmPayment = false,
    } = req.body || {};

    const cleanRestauranteId = toPositiveInteger(restauranteId);
    const cleanAmountCents = toPositiveInteger(amountCents);
    const cleanWooOrderId = String(wooOrderId || "").trim();

    if (!cleanRestauranteId) {
      return res.status(400).json({
        success: false,
        error: "restauranteId inválido",
      });
    }

    if (!cleanWooOrderId) {
      return res.status(400).json({
        success: false,
        error: "wooOrderId es requerido",
      });
    }

    if (!cleanAmountCents) {
      return res.status(400).json({
        success: false,
        error: "amountCents inválido",
      });
    }

    const restaurante = await getRestauranteById(cleanRestauranteId);

    if (!restaurante || !restaurante.stripe_account_id) {
      return res.status(400).json({
        success: false,
        error: "El restaurante no tiene una cuenta Stripe conectada",
      });
    }

    const normalizedOrderType =
      String(orderType).toLowerCase() === "delivery" ? "delivery" : "pickup";

    const applicationFeeAmount =
      getDenixApplicationFeeCents(normalizedOrderType);

    if (applicationFeeAmount >= cleanAmountCents) {
      return res.status(400).json({
        success: false,
        error:
          "El total del pedido debe ser mayor que el fee de Denix para poder procesar el pago.",
      });
    }

    const paymentIntentPayload = {
      amount: cleanAmountCents,
      currency: String(currency || "usd").toLowerCase(),
      payment_method_types: ["card"],
      application_fee_amount: applicationFeeAmount,
      description: `WooCommerce Order #${cleanWooOrderId}`,
      metadata: {
        restaurante_id: String(restaurante.id),
        restaurante_nombre: restaurante.nombre || "",
        woo_order_id: cleanWooOrderId,
        order_type: normalizedOrderType,
        denix_application_fee_cents: String(applicationFeeAmount),
        denix_fee_policy:
          normalizedOrderType === "delivery"
            ? "pickup_fee_298_plus_delivery_988"
            : "pickup_fee_298",
        source: "denix_woocommerce",
      },
    };

    if (customerEmail) {
      paymentIntentPayload.receipt_email = String(customerEmail);
      paymentIntentPayload.metadata.customer_email = String(customerEmail);
    }

    if (paymentMethodId) {
      paymentIntentPayload.payment_method = String(paymentMethodId);
    }

    if (confirmPayment === true || confirmPayment === "true") {
      if (!paymentMethodId) {
        return res.status(400).json({
          success: false,
          error:
            "paymentMethodId es requerido cuando confirmPayment está activo",
        });
      }

      paymentIntentPayload.confirm = true;
    }

    const paymentIntent = await stripe.paymentIntents.create(
      paymentIntentPayload,
      {
        stripeAccount: restaurante.stripe_account_id,
        idempotencyKey: `denix_pi_${cleanRestauranteId}_${cleanWooOrderId}_${cleanAmountCents}_${normalizedOrderType}`,
      }
    );

    await pool.query(
      `
      INSERT INTO pedidos (
        restaurante_id,
        total,
        estado,
        woo_order_id,
        customer_name,
        items,
        stripe_payment_intent_id,
        stripe_account_id,
        denix_application_fee_cents,
        payment_split_status,
        created_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        '[]'::json,
        $6,
        $7,
        $8,
        $9,
        NOW()
      )
      ON CONFLICT (woo_order_id)
      DO UPDATE SET
        restaurante_id = EXCLUDED.restaurante_id,
        total = EXCLUDED.total,
        stripe_payment_intent_id = EXCLUDED.stripe_payment_intent_id,
        stripe_account_id = EXCLUDED.stripe_account_id,
        denix_application_fee_cents = EXCLUDED.denix_application_fee_cents,
        payment_split_status = EXCLUDED.payment_split_status
      `,
      [
        restaurante.id,
        cleanAmountCents / 100,
        paymentIntent.status === "succeeded" ? "processing" : paymentIntent.status,
        cleanWooOrderId,
        customerEmail ? String(customerEmail) : "Cliente",
        paymentIntent.id,
        restaurante.stripe_account_id,
        applicationFeeAmount,
        paymentIntent.status,
      ]
    );

    return res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      status: paymentIntent.status,
      connectedAccount: restaurante.stripe_account_id,
      applicationFeeAmount,
      nextAction: paymentIntent.next_action || null,
    });
  } catch (error) {
    console.error("Error creando PaymentIntent Connect:", error);

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
 * Refund Stripe Connect.
 * Regla Denix:
 * - Cliente recibe refund.
 * - Restaurante asume refund.
 * - Denix conserva application fee.
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
      refundType = "total",
      refundAmountCents,
      reason = "Refund Denix Orders",
    } = req.body || {};

    const cleanRestauranteId = toPositiveInteger(restauranteId);
    const cleanWooOrderId = String(wooOrderId || "").trim();
    const cleanRefundType =
      String(refundType).toLowerCase() === "partial" ? "partial" : "total";

    if (!cleanRestauranteId) {
      return res.status(400).json({
        success: false,
        error: "restauranteId inválido",
      });
    }

    if (!cleanWooOrderId) {
      return res.status(400).json({
        success: false,
        error: "wooOrderId es requerido",
      });
    }

    const pedidoResult = await pool.query(
      `
      SELECT
        id,
        restaurante_id,
        total,
        woo_order_id,
        stripe_payment_intent_id,
        stripe_account_id,
        denix_application_fee_cents,
        stripe_refund_amount_cents
      FROM pedidos
      WHERE restaurante_id = $1
      AND woo_order_id = $2
      LIMIT 1
      `,
      [cleanRestauranteId, cleanWooOrderId]
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
        error: "Este pedido no tiene datos de Stripe Connect guardados",
      });
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(
      pedido.stripe_payment_intent_id,
      {
        expand: ["latest_charge"],
      },
      {
        stripeAccount: pedido.stripe_account_id,
      }
    );

    if (!paymentIntent) {
      return res.status(404).json({
        success: false,
        error: "PaymentIntent no encontrado en Stripe",
      });
    }

    if (paymentIntent.status !== "succeeded") {
      return res.status(400).json({
        success: false,
        error: `El pago no está completado. Estado actual: ${paymentIntent.status}`,
      });
    }

    const latestCharge = paymentIntent.latest_charge;
    const amountReceivedCents =
      Number(paymentIntent.amount_received) || Number(paymentIntent.amount) || 0;

    const amountAlreadyRefundedCents =
      latestCharge && typeof latestCharge === "object"
        ? Number(latestCharge.amount_refunded || 0)
        : Number(pedido.stripe_refund_amount_cents || 0);

    const remainingRefundableCents =
      amountReceivedCents - amountAlreadyRefundedCents;

    if (remainingRefundableCents <= 0) {
      return res.status(400).json({
        success: false,
        error: "Este pago ya no tiene saldo disponible para reembolsar",
      });
    }

    let amountToRefundCents = remainingRefundableCents;

    if (cleanRefundType === "partial") {
      amountToRefundCents = toPositiveInteger(refundAmountCents);

      if (!amountToRefundCents) {
        return res.status(400).json({
          success: false,
          error: "refundAmountCents inválido para refund parcial",
        });
      }

      if (amountToRefundCents > remainingRefundableCents) {
        return res.status(400).json({
          success: false,
          error: "El refund parcial excede el saldo disponible para reembolso",
          remainingRefundableCents,
        });
      }
    }

    const idempotencyKey = `denix_refund_${cleanRestauranteId}_${cleanWooOrderId}_${cleanRefundType}_${amountToRefundCents}`;

    const refund = await stripe.refunds.create(
      {
        payment_intent: pedido.stripe_payment_intent_id,
        amount: amountToRefundCents,
        refund_application_fee: false,
        metadata: {
          woo_order_id: cleanWooOrderId,
          restaurante_id: String(cleanRestauranteId),
          refund_type: cleanRefundType,
          denix_keeps_fee: "true",
          denix_application_fee_cents: String(
            pedido.denix_application_fee_cents || 0
          ),
          reason: String(reason || ""),
          source: "denix_orders",
        },
      },
      {
        stripeAccount: pedido.stripe_account_id,
        idempotencyKey,
      }
    );

    const newTotalRefundedCents =
      amountAlreadyRefundedCents + Number(refund.amount || amountToRefundCents);

    const isFullyRefunded = newTotalRefundedCents >= amountReceivedCents;

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
        status,
        error_message,
        created_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8,NULL,NOW())
      ON CONFLICT (stripe_refund_id)
      DO UPDATE SET
        status = EXCLUDED.status,
        error_message = NULL
      `,
      [
        cleanWooOrderId,
        cleanRestauranteId,
        pedido.stripe_payment_intent_id,
        pedido.stripe_account_id,
        refund.id,
        cleanRefundType,
        Number(refund.amount || amountToRefundCents),
        refund.status || "succeeded",
      ]
    );

    await pool.query(
      `
      UPDATE pedidos
      SET
        refunded = $1,
        refund_amount = $2,
        stripe_refund_id = $3,
        stripe_refund_status = $4,
        stripe_refund_amount_cents = $5,
        stripe_refunded_at = NOW(),
        stripe_refund_error = NULL
      WHERE id = $6
      `,
      [
        isFullyRefunded,
        newTotalRefundedCents / 100,
        refund.id,
        refund.status || "succeeded",
        newTotalRefundedCents,
        pedido.id,
      ]
    );

    return res.json({
      success: true,
      message: "Refund procesado correctamente. Denix conserva su fee.",
      refund: {
        refund_id: refund.id,
        status: refund.status,
        amount_cents: Number(refund.amount || amountToRefundCents),
        total_refunded_cents: newTotalRefundedCents,
        fully_refunded: isFullyRefunded,
      },
      denix_keeps_fee: true,
      refund_application_fee: false,
    });
  } catch (error) {
    console.error("Error procesando refund Connect:", error);

    const wooOrderId = req.body?.wooOrderId;
    const restauranteId = req.body?.restauranteId;

    if (wooOrderId && restauranteId) {
      try {
        await pool.query(
          `
          UPDATE pedidos
          SET stripe_refund_error = $1
          WHERE woo_order_id = $2
          AND restaurante_id = $3
          `,
          [
            error?.raw?.message || error.message || "Error refund Stripe",
            String(wooOrderId),
            Number(restauranteId),
          ]
        );
      } catch (dbError) {
        console.error("No se pudo guardar error de refund:", dbError);
      }
    }

    return res.status(500).json({
      success: false,
      error:
        error?.raw?.message ||
        error.message ||
        "No se pudo procesar el refund",
      denix_keeps_fee: true,
    });
  }
});

module.exports = router;