BEGIN;

CREATE TABLE IF NOT EXISTS order_hydration_jobs (
  id BIGSERIAL PRIMARY KEY,
  restaurante_id INTEGER NOT NULL REFERENCES restaurantes(id),
  woo_order_id TEXT NOT NULL,
  stripe_payment_intent_id TEXT NOT NULL,
  stripe_account_id TEXT NOT NULL,
  denix_application_fee_cents INTEGER NOT NULL,
  payment_split_status TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT uq_order_hydration_jobs_restaurant_order
    UNIQUE (restaurante_id, woo_order_id)
);

CREATE INDEX IF NOT EXISTS idx_order_hydration_jobs_pending
  ON order_hydration_jobs (next_attempt_at)
  WHERE status = 'pending';

COMMIT;
