-- Exchange flows v1: classified deposits and withdrawals of labelled exchange
-- and custody wallets, plus UTC daily totals. Additive: new tables only.
-- Written by server/jobs/refresh-exchange-flows.js. Reads stay unavailable
-- until `refresh-exchange-flows.js --rebuild` completes (exchange_flow_state.ready).
-- Amounts are exact zatoshi integers. A day with no row inside the covered
-- range is zero; a day outside it is unknown, never zero.
BEGIN;
SET LOCAL lock_timeout = '2s';

-- One row per classified event. A transaction can produce several deposits
-- (one per receiving entity) but at most one event per entity and direction.
CREATE TABLE IF NOT EXISTS public.exchange_flows (
  txid text NOT NULL,
  entity text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('deposit','withdrawal')),
  block_height integer NOT NULL,
  block_hash text NOT NULL,
  block_time bigint NOT NULL,
  day date NOT NULL,
  amount_zat bigint NOT NULL CHECK (amount_zat > 0),
  counterparty text NOT NULL CHECK (counterparty IN ('transparent','shielded','mixed')),
  label_version text NOT NULL,
  PRIMARY KEY (txid, entity, direction)
);
CREATE INDEX IF NOT EXISTS idx_exchange_flows_height ON public.exchange_flows (block_height);
CREATE INDEX IF NOT EXISTS idx_exchange_flows_direction_time ON public.exchange_flows (direction, block_time);
CREATE INDEX IF NOT EXISTS idx_exchange_flows_entity_time ON public.exchange_flows (entity, block_time);

CREATE TABLE IF NOT EXISTS public.exchange_flow_daily (
  day date NOT NULL,
  entity text NOT NULL,
  deposits_zat bigint NOT NULL CHECK (deposits_zat >= 0),
  withdrawals_zat bigint NOT NULL CHECK (withdrawals_zat >= 0),
  deposit_count integer NOT NULL CHECK (deposit_count >= 0),
  withdrawal_count integer NOT NULL CHECK (withdrawal_count >= 0),
  label_version text NOT NULL,
  PRIMARY KEY (day, entity)
);

-- Single-row job state. label_version is the version every stored row was
-- classified with; the reader compares it with the live labels to detect
-- staleness. rebuild_* track an in-progress (resumable) full rebuild.
CREATE TABLE IF NOT EXISTS public.exchange_flow_state (
  id smallint PRIMARY KEY CHECK (id = 1),
  ready boolean NOT NULL DEFAULT false,
  label_version text,
  coverage_from_height integer,
  coverage_from_time bigint,
  through_height integer,
  through_hash text,
  through_time bigint,
  rebuild_label_version text,
  rebuild_next_height integer,
  last_run_at timestamptz,
  last_skipped jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.exchange_flow_state(id) VALUES (1) ON CONFLICT DO NOTHING;

-- The address -> entity map that produced the stored rows. A label change is
-- diffed against it so only affected transactions are re-classified.
CREATE TABLE IF NOT EXISTS public.exchange_flow_labels (
  address text PRIMARY KEY,
  entity text NOT NULL
);

-- Readers of blocks may read the new tables; writers of blocks may maintain
-- them. Never copy PUBLIC grants.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT grantee FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'blocks' AND grantee <> 'PUBLIC'
  LOOP
    IF has_table_privilege(r.grantee, 'public.blocks', 'SELECT') THEN
      EXECUTE format('GRANT SELECT ON public.exchange_flows, public.exchange_flow_daily, public.exchange_flow_state, public.exchange_flow_labels TO %I', r.grantee);
    END IF;
    IF has_table_privilege(r.grantee, 'public.blocks', 'INSERT') OR has_table_privilege(r.grantee, 'public.blocks', 'UPDATE') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.exchange_flows, public.exchange_flow_daily, public.exchange_flow_state, public.exchange_flow_labels TO %I', r.grantee);
    END IF;
  END LOOP;
END $$;
COMMIT;
