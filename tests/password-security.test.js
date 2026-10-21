const test = require('node:test');
const assert = require('node:assert/strict');

const {
  hashPassword,
  verifyPassword,
  isPasswordHash
} = require('../lib/password-security');

test('hash scrypt no conserva la contraseña y valida la credencial correcta', async () => {
  const password = 'Una-clave-segura-2026';
  const hash = await hashPassword(password);

  assert.equal(isPasswordHash(hash), true);
  assert.equal(hash.includes(password), false);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword('clave-incorrecta', hash), false);
});

test('cada hash usa un salt distinto', async () => {
  const first = await hashPassword('Misma-clave-segura');
  const second = await hashPassword('Misma-clave-segura');
  assert.notEqual(first, second);
});

test('credenciales heredadas siguen validando para permitir su migración', async () => {
  assert.equal(isPasswordHash('clave-heredada'), false);
  assert.equal(await verifyPassword('clave-heredada', 'clave-heredada'), true);
  assert.equal(await verifyPassword('otra-clave', 'clave-heredada'), false);
});

test('hashes dañados se rechazan sin lanzar errores', async () => {
  assert.equal(await verifyPassword('clave', 'denix-scrypt$v1$bad'), false);
  assert.equal(await verifyPassword('', ''), false);
});
