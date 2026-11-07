-- Shielded-rate tracking for ZEC delivered by cross-chain swaps (NEAR 1Click).
-- networks: mainnet
-- One row per successful inflow swap identity. Rows are derived and may be
-- recomputed at any time from crosschain_swaps_v2 + canonical chain tables.
--
-- arrival:
--   no_zec_tx        provider reported no Zcash destination transaction (uncovered)
--   tx_not_indexed   reported hash is not in canonical `transactions` (uncovered)
--   unmatched        tx is indexed but no output can be tied to the recipient (uncovered)
--   shielded         delivery went straight into a shielded pool (shield flow, non-t recipient)
--   transparent      delivery paid a transparent output to the recipient
-- outcome (transparent arrivals only; one hop, same priority as Turnstile):
--   held | shielded | exchange | bridge | transferred
-- delivered_zat is exact chain value for transparent arrivals. Shielded amounts
-- are not visible on chain, so shielded arrivals use the provider-reported
-- destination amount and say so in amount_source.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '120s';
CREATE TABLE IF NOT EXISTS public.crosschain_shielding (
    deposit_address text NOT NULL,
    deposit_memo text NOT NULL DEFAULT '',
    swap_created_at timestamptz NOT NULL,
    source_chain text NOT NULL,
    recipient text,
    zec_txid text,
    arrival text NOT NULL CHECK (arrival IN ('no_zec_tx','tx_not_indexed','unmatched','shielded','transparent')),
    arrival_block_time bigint,
    delivered_zat bigint CHECK (delivered_zat BETWEEN 0 AND 2100000000000000),
    amount_source text CHECK (amount_source IN ('chain_output','provider_reported')),
    held_zat bigint NOT NULL DEFAULT 0 CHECK (held_zat >= 0),
    shielded_zat bigint NOT NULL DEFAULT 0 CHECK (shielded_zat >= 0),
    exchange_zat bigint NOT NULL DEFAULT 0 CHECK (exchange_zat >= 0),
    bridge_zat bigint NOT NULL DEFAULT 0 CHECK (bridge_zat >= 0),
    transferred_zat bigint NOT NULL DEFAULT 0 CHECK (transferred_zat >= 0),
    first_shield_block_time bigint,
    classified_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (deposit_address, deposit_memo),
    CHECK (arrival NOT IN ('shielded','transparent') OR (zec_txid IS NOT NULL AND arrival_block_time IS NOT NULL)),
    CHECK (arrival <> 'transparent' OR delivered_zat = held_zat + shielded_zat + exchange_zat + bridge_zat + transferred_zat)
);
COMMENT ON TABLE public.crosschain_shielding IS
'Derived per-swap shielding classification for successful NEAR 1Click ZEC inflows. Exact zatoshis. One spend hop only; uncovered arrivals are not zero.';
CREATE INDEX IF NOT EXISTS crosschain_shielding_created ON public.crosschain_shielding (swap_created_at);
CREATE INDEX IF NOT EXISTS crosschain_shielding_open ON public.crosschain_shielding (classified_at)
  WHERE arrival IN ('tx_not_indexed','unmatched') OR (arrival = 'transparent' AND held_zat > 0);
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT grantee FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name='turnstile_daily' AND grantee <> 'PUBLIC'
  LOOP
    IF has_table_privilege(r.grantee,'public.turnstile_daily','SELECT') THEN
      EXECUTE format('GRANT SELECT ON public.crosschain_shielding TO %I', r.grantee);
    END IF;
    IF has_table_privilege(r.grantee,'public.turnstile_daily','INSERT') THEN
      EXECUTE format('GRANT INSERT, UPDATE, DELETE ON public.crosschain_shielding TO %I', r.grantee);
    END IF;
  END LOOP;
END $$;
COMMIT;
