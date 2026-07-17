# Taqueria-Dashboard

## Migración multi-restaurante — Fase 2

Esta rama convierte los flujos operativos de DENIX a una identidad compuesta
`(restaurante_id, id_externo)`. Las migraciones incluidas son archivos para
revisión: no deben ejecutarse automáticamente desde la aplicación.

### Configuración operativa

La configuración se lee primero desde `restaurantes` mediante
`getOperationalRestaurantConfig(restauranteId)`. Las variables globales
`WOO_URL`, `CONSUMER_KEY`, `CONSUMER_SECRET` y `WEBHOOK_SECRET` solo son fallback
para el restaurante 1 cuando `ENABLE_LEGACY_RESTAURANT_1=true`.

Campos requeridos por restaurante:

- `woo_url`, `consumer_key`, `consumer_secret`
- `shipday_api`
- `webhook_token`
- `woo_webhook_secret`
- `shipday_webhook_secret`
- `activo`

Las claves VAPID permanecen globales. Los secretos nunca se devuelven completos
al frontend.

### Webhooks y Bridge

- `POST /webhooks/woo/:webhookToken/order`
- `POST /webhooks/woo/:webhookToken/product`
- `POST /webhooks/shipday/:webhookToken`
- `GET /bridge/:webhookToken/actions`
- `POST /bridge/:webhookToken/actions/:actionId/result`

WooCommerce debe enviar `X-WC-Webhook-Signature` calculada con HMAC SHA-256
sobre el body HTTP exacto. Shipday debe enviar el secreto en
`X-Shipday-Secret`, `X-Webhook-Secret` o `?secret=`.

Las rutas legacy `/webhook-order`, `/webhook-product`, `/webhook-shipday`,
`/acciones-woo-pendientes` y `/acciones-woo/:id/resultado` se conservan solo
para el restaurante 1 y solo mientras la feature flag esté activa.

Los estados `checkout-draft`, `auto-draft`, `draft`, `failed` y `cancelled` se
ignoran. `pending` se conserva porque Woo/Stripe puede crear la orden antes de
completar el pago; una actualización posterior hace upsert del mismo registro.

### Migraciones

Orden de revisión y ejecución manual:

1. `001_multitenant_foundation.sql` si todavía no fue aplicada.
2. `002_multitenant_operations_preflight.sql` (solo diagnóstico).
3. Revisar que no existan nulos, duplicados, huérfanos ni tokens repetidos.
4. `003_multitenant_operations_additive.sql`.
5. Desplegar y validar el backend nuevo únicamente con restaurante 1.
6. Ejecutar `004_multitenant_operations_cutover.sql` cuando el preflight esté limpio.
7. Configurar y activar restaurante 2 en una etapa posterior.

Los rollbacks son conservadores: no eliminan datos ni intentan restaurar
unicidad global después de que dos restaurantes compartan IDs externos.

### Checklist externo para un restaurante nuevo

1. Crear/revisar el registro de restaurante sin activarlo todavía.
2. Guardar sus credenciales Woo y Shipday propias; no usar variables globales.
3. Crear los tokens en un gestor seguro y guardarlos con la edición protegida;
   el panel solo volverá a mostrarlos enmascarados.
4. Configurar los dos webhooks Woo con su URL tokenizada y secreto HMAC.
5. Configurar Shipday con su URL tokenizada y secreto por header o query.
6. Configurar WordPress Bridge con las rutas tokenizadas.
7. Probar pickup, delivery, producto, Bridge, push y refund en entorno controlado.
8. Confirmar aislamiento usando IDs repetidos antes de activar el restaurante.

### Validación local

```powershell
npm.cmd test
node --check index.js
node --check routes\stripeConnect.js
```

Las pruebas no llaman WooCommerce, Shipday, Stripe, Supabase ni push reales.
