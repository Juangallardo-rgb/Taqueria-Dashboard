const crypto = require('crypto');

function safeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');

  if (!leftBuffer.length || leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyWooWebhookSignature(rawBody, secret, providedSignature) {
  if (!Buffer.isBuffer(rawBody) || !secret || !providedSignature) return false;

  const normalizedSignature = String(providedSignature)
    .replace(/^sha256=/i, '')
    .trim();

  const expectedSignature = crypto
    .createHmac('sha256', String(secret))
    .update(rawBody)
    .digest('base64');

  return safeEqualText(expectedSignature, normalizedSignature);
}

function getRequestHeader(req, headerName) {
  const headers = req?.headers;

  if (!headers || typeof headers !== 'object') return undefined;

  const normalizedName = String(headerName).toLowerCase();
  const matchingKey = Object.keys(headers).find(
    key => String(key).toLowerCase() === normalizedName
  );

  return matchingKey === undefined ? undefined : headers[matchingKey];
}

function hasRequestHeader(req, headerName) {
  return getRequestHeader(req, headerName) !== undefined;
}

function isWooWebhookPing(req) {
  try {
    if (String(req?.method || '').toUpperCase() !== 'POST') return false;

    if (hasRequestHeader(req, 'x-wc-webhook-signature')) return false;
    if (hasRequestHeader(req, 'x-wc-webhook-topic')) return false;
    if (hasRequestHeader(req, 'x-wc-webhook-resource')) return false;
    if (hasRequestHeader(req, 'x-wc-webhook-event')) return false;

    const userAgent = String(getRequestHeader(req, 'user-agent') || '');

    if (!/WooCommerce\//i.test(userAgent) || !/Hookshot/i.test(userAgent)) {
      return false;
    }

    const body = req?.body;

    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;

    const bodyKeys = Object.keys(body);

    if (bodyKeys.length !== 1 || bodyKeys[0] !== 'webhook_id') return false;

    const webhookId = body.webhook_id;
    const normalizedWebhookId = typeof webhookId === 'number'
      ? String(webhookId)
      : (typeof webhookId === 'string' ? webhookId.trim() : '');

    if (!/^[1-9]\d*$/.test(normalizedWebhookId)) return false;

    const numericWebhookId = Number(normalizedWebhookId);

    return Number.isSafeInteger(numericWebhookId) && numericWebhookId > 0;
  } catch (error) {
    return false;
  }
}

function sendWooWebhookPingAccepted(res, logger = console) {
  logger.log('Woo webhook ping accepted');
  return res.status(200).json({ success: true, ping: true });
}

function getShipdayProvidedSecret(req) {
  return (
    req.headers['x-shipday-secret'] ||
    req.headers['x-webhook-secret'] ||
    req.query?.secret ||
    ''
  );
}

function verifyShipdaySecret(req, expectedSecret) {
  return safeEqualText(getShipdayProvidedSecret(req), expectedSecret);
}

module.exports = {
  safeEqualText,
  verifyWooWebhookSignature,
  isWooWebhookPing,
  sendWooWebhookPingAccepted,
  getShipdayProvidedSecret,
  verifyShipdaySecret
};
