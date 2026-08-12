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

El endpoint de órdenes acepta tanto `order.created` como `order.updated`; el
topic no cambia la ruta ni el aislamiento por token. Operativamente, cada
restaurante debe configurar ambos webhooks hacia su mismo endpoint DENIX de
órdenes. Solo se persisten como órdenes visibles los estados `processing` y
`completed`; los estados previos o fallidos continúan ignorándose.

El sistema no depende exclusivamente de `order.updated`: después de un pago
Stripe exitoso, si la fila todavía no existe, DENIX consulta la orden exacta en
WooCommerce y la hidrata. Un fallo temporal de Woo no cambia la respuesta del
pago y activa reintentos de hidratación sin insertar una orden vacía.

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
4. Configurar `order.created` y `order.updated` con la misma URL tokenizada de
   órdenes y el mismo secreto HMAC.
5. Configurar Shipday con su URL tokenizada y secreto por header o query.
6. Configurar WordPress Bridge con las rutas tokenizadas.
7. Probar pickup, delivery, producto, Bridge, push y refund en entorno controlado.
8. Confirmar aislamiento usando IDs repetidos antes de activar el restaurante.

## Dashboard administrativo analítico

`/admin` conserva el shell y la gestión operativa existente, pero su vista
principal usa un snapshot agregado protegido por rol ADMIN:

- `GET /admin/api/dashboard`: acepta `range=today|yesterday|7d|30d` o
  `range=custom&start=YYYY-MM-DD&end=YYYY-MM-DD`; `restaurant_id` es un filtro
  analítico posterior a la autorización, no una identidad de sesión.
- `GET /admin/events`: stream SSE en memoria con eventos mínimos de órdenes,
  refunds, deliveries y estado abierto/cerrado. No contiene credenciales.
- `/admin/restaurants` y `/admin/restaurants/:id`: mantienen creación, edición,
  configuración Woo/Shipday y generación de secretos.
- `/admin/analytics/restaurants/:id`: detalle analítico de un restaurante sin
  reutilizar una sesión operativa de restaurante.

Las consultas analíticas cuentan únicamente estados `processing` y
`completed`, igual que el flujo operativo actual. Ventas brutas es la suma de
`pedidos.total`; refunds es la suma de `refund_amount` cuando `refunded=true`;
ventas netas es bruto menos refunds; ticket promedio es ventas netas dividido
por órdenes válidas. `pending`, `failed`, `cancelled` y estados desconocidos no
se incluyen.

El snapshot ejecuta cuatro consultas PostgreSQL agregadas en paralelo y usa
una caché en memoria de 5 segundos por rango y restaurante. Las escrituras
operativas existentes solo añaden una invalidación y un evento posterior al
éxito. Si SSE se desconecta, el frontend reconecta con backoff exponencial y
activa temporalmente un único snapshot cada 15 segundos.

La base actual no contiene timezone por restaurante. El rango general usa
`ADMIN_DASHBOARD_TIMEZONE` cuando existe; de lo contrario usa `UTC` y lo indica
en la interfaz y en la respuesta (`timezone.source=default_utc`). No se añadió
una zona horaria silenciosa ni una migración. El índice existente
`idx_pedidos_restaurante_created_at` y los índices compuestos de deliveries
cubren las consultas nuevas, por lo que no se requiere un índice adicional.

### Validación local

```powershell
npm.cmd test
node --check index.js
node --check routes\stripeConnect.js
```

Las pruebas no llaman WooCommerce, Shipday, Stripe, Supabase ni push reales.
