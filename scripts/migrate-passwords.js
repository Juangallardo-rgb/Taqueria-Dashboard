require('dotenv').config();

const pool = require('../database');
const { hashPassword, isPasswordHash } = require('../lib/password-security');

async function migratePasswords() {
  const client = await pool.connect();
  let migrated = 0;

  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT id, password
       FROM usuarios
       ORDER BY id
       FOR UPDATE`
    );

    for (const user of result.rows) {
      if (isPasswordHash(user.password)) continue;
      const passwordHash = await hashPassword(String(user.password || ''));
      await client.query(
        `UPDATE usuarios
         SET password = $1
         WHERE id = $2`,
        [passwordHash, user.id]
      );
      migrated += 1;
    }

    await client.query('COMMIT');
    console.log(`Migración completada: ${migrated} contraseña(s) protegida(s).`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migratePasswords().catch(error => {
  console.error('No se pudo migrar las contraseñas:', error.message);
  process.exitCode = 1;
});
