BEGIN;

-- Los hashes scrypt versionados caben holgadamente en TEXT y se evita que un
-- VARCHAR heredado trunque credenciales durante la migración.
ALTER TABLE usuarios
  ALTER COLUMN password TYPE TEXT;

COMMENT ON COLUMN usuarios.password IS
  'Hash de contraseña versionado; nunca debe contener credenciales en texto plano';

COMMIT;
