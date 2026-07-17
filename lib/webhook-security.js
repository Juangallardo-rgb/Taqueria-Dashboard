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
  getShipdayProvidedSecret,
  verifyShipdaySecret
};
