-- No se revierte un hash a texto plano. TEXT es compatible con los valores
-- anteriores y conservarlo es el rollback más seguro para la aplicación.
SELECT 1 AS password_security_rollback_noop;
