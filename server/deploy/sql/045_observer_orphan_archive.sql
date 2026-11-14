-- 045: Parsed archive of observer-only orphan blocks.
-- An observer-only orphan is a captured_blocks row whose hash is in neither
-- blocks nor orphaned_blocks while blocks holds a different hash at that height:
-- a competing block our observers received that our node never adopted.
--
-- These rows deliberately live outside orphaned_blocks/orphaned_transactions*.
-- Those tables mean "our node indexed this block and then reorged it out"; reorg
-- lists, fork events, orphan rates, Ask analytics and open data read them that
-- way. Column names and meanings match the orphaned_* tables so readers can use
-- the same select lists. Moving captures into orphaned_* (or into any rate) needs
-- a separate release decision.
--
-- Data authority: the raw block retained in captured_blocks (hash and coinbase
-- height re-verified on parse). Transparent prevouts resolve from the same
-- block, canonical transaction_outputs, then archived orphan outputs. An
-- unresolved prevout leaves the input value/address, transaction total_input
-- and fee NULL (unknown), never zero. Final pool roots are NULL: raw headers
-- carry only a commitment hash and the node cannot be asked about a block it
-- never adopted. size is the exact serialized block length in bytes.
-- Values are integer zatoshis.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '120s';
CREATE TABLE IF NOT EXISTS public.observer_orphan_blocks (
    hash text PRIMARY KEY CHECK (hash ~ '^[0-9a-f]{64}$') REFERENCES public.captured_blocks(hash),
    height bigint NOT NULL CHECK (height >= 0),
    canonical_hash text CHECK (canonical_hash ~ '^[0-9a-f]{64}$'),
    "timestamp" bigint NOT NULL,
    transaction_count integer NOT NULL CHECK (transaction_count >= 1),
    size integer NOT NULL CHECK (size > 0),
    difficulty text,
    miner_address text,
    previous_block_hash text NOT NULL CHECK (previous_block_hash ~ '^[0-9a-f]{64}$'),
    source text NOT NULL DEFAULT 'observer' CHECK (source = 'observer'),
    final_sapling_root text,
    final_orchard_root text,
    final_ironwood_root text,
    coinbase_hex text,
    block_metadata jsonb NOT NULL,
    archive_version smallint NOT NULL CHECK (archive_version >= 1),
    unresolved_inputs integer NOT NULL CHECK (unresolved_inputs >= 0),
    detected_at timestamp without time zone NOT NULL DEFAULT now(),
    first_indexed_at timestamp without time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS observer_orphan_blocks_height_idx ON public.observer_orphan_blocks (height DESC);
CREATE TABLE IF NOT EXISTS public.observer_orphan_transactions (
    txid text NOT NULL CHECK (txid ~ '^[0-9a-f]{64}$'),
    block_height bigint NOT NULL,
    block_hash text NOT NULL REFERENCES public.observer_orphan_blocks(hash) ON DELETE CASCADE,
    "timestamp" bigint,
    tx_index integer NOT NULL CHECK (tx_index >= 0),
    version integer,
    locktime bigint,
    expiry_height integer,
    size integer,
    fee bigint,
    is_coinbase boolean NOT NULL DEFAULT false,
    vin_count integer DEFAULT 0,
    vout_count integer DEFAULT 0,
    total_input bigint,
    total_output bigint DEFAULT 0,
    has_sapling boolean DEFAULT false,
    has_orchard boolean DEFAULT false,
    has_sprout boolean DEFAULT false,
    has_ironwood boolean DEFAULT false,
    has_shielded_data boolean DEFAULT false,
    sapling_spend_count integer DEFAULT 0,
    sapling_output_count integer DEFAULT 0,
    orchard_actions integer DEFAULT 0,
    ironwood_actions integer DEFAULT 0,
    sprout_joinsplit_count integer DEFAULT 0,
    value_balance bigint DEFAULT 0,
    value_balance_sapling bigint DEFAULT 0,
    value_balance_orchard bigint DEFAULT 0,
    value_balance_ironwood bigint DEFAULT 0,
    value_balance_sprout bigint DEFAULT 0,
    flow_type text,
    privacy_score smallint,
    orchard_anchor text,
    ironwood_anchor text,
    archived_at timestamp without time zone NOT NULL DEFAULT now(),
    first_indexed_at timestamp without time zone,
    PRIMARY KEY (txid, block_hash),
    UNIQUE (block_hash, tx_index)
);
CREATE INDEX IF NOT EXISTS observer_orphan_transactions_txid_idx ON public.observer_orphan_transactions (txid);
CREATE TABLE IF NOT EXISTS public.observer_orphan_transaction_inputs (
    txid text NOT NULL,
    block_hash text NOT NULL,
    vout_index integer NOT NULL CHECK (vout_index >= 0),
    prev_txid text NOT NULL,
    prev_vout integer NOT NULL,
    address text,
    value bigint CHECK (value >= 0),
    coinbase text,
    PRIMARY KEY (block_hash, txid, vout_index),
    FOREIGN KEY (txid, block_hash) REFERENCES public.observer_orphan_transactions(txid, block_hash) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS public.observer_orphan_transaction_outputs (
    txid text NOT NULL,
    block_hash text NOT NULL,
    vout_index integer NOT NULL CHECK (vout_index >= 0),
    value bigint NOT NULL CHECK (value >= 0),
    address text,
    script_type text,
    PRIMARY KEY (block_hash, txid, vout_index),
    FOREIGN KEY (txid, block_hash) REFERENCES public.observer_orphan_transactions(txid, block_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS observer_orphan_transaction_outputs_txid_idx ON public.observer_orphan_transaction_outputs (txid, vout_index);
REVOKE ALL ON public.observer_orphan_blocks, public.observer_orphan_transactions,
    public.observer_orphan_transaction_inputs, public.observer_orphan_transaction_outputs FROM PUBLIC;
DO $$
DECLARE r record;
BEGIN
  -- Same role mapping as 035: readers of blocks may read; block writers archive.
  FOR r IN SELECT DISTINCT grantee FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name='blocks' AND grantee <> 'PUBLIC'
  LOOP
    IF has_table_privilege(r.grantee,'public.blocks','SELECT') THEN
      EXECUTE format('GRANT SELECT ON public.observer_orphan_blocks, public.observer_orphan_transactions, public.observer_orphan_transaction_inputs, public.observer_orphan_transaction_outputs TO %I', r.grantee);
    END IF;
    IF has_table_privilege(r.grantee,'public.blocks','INSERT') THEN
      EXECUTE format('GRANT INSERT, UPDATE, DELETE ON public.observer_orphan_blocks, public.observer_orphan_transactions, public.observer_orphan_transaction_inputs, public.observer_orphan_transaction_outputs TO %I', r.grantee);
    END IF;
  END LOOP;
END $$;
COMMIT;
