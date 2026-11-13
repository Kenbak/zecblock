"""Published open-data tables, read from the reviewed analytics_public views.

Row-level address tables, venue-level swap records, reviewed labels and privacy
linkage output are deliberately absent. value_pools_daily is absent until its
view can be read within the reader role's temporary-file limit. Add a table here only after deciding it
should be downloadable in bulk.

Bump a table's `version` whenever its definition or column meaning changes; that
forces its partitions to be rebuilt and tells consumers the meaning moved.

Column types: i64, bool, str, date, or dec:<scale> for exact decimals.
"""
from dataclasses import dataclass
from typing import Optional

ZAT = 'zatoshis'
UNIX = 'Unix seconds UTC'
COUNT = 'count'
HASH = 'hex'
ADDR = 'payout address'
DAY = 'UTC date'


@dataclass(frozen=True)
class Dataset:
    id: str
    view: str
    title: str
    description: str
    columns: tuple
    key: tuple
    version: int = 1
    # Set for block-height partitioned tables; otherwise the table is one file.
    bucket: Optional[int] = None
    # dataset_coverage row guarding this view; None means core coverage only.
    coverage: Optional[str] = None
    # Upper bound for single-file tables, and whether it uses the delayed cutoff.
    date_column: Optional[str] = None
    # Read in disjoint date windows from this start (rows before it in one more
    # window), for views that exceed the reader's temporary-file limit whole.
    date_window_start: Optional[str] = None
    date_window_days: Optional[int] = None
    time_column: Optional[str] = None
    delayed: bool = False
    # Every height in range must have exactly one row.
    one_per_height: bool = False
    # Row count must equal the block transaction totals minus coinbase.
    reconcile_transactions: bool = False
    unique: bool = True

    @property
    def names(self):
        return [column[0] for column in self.columns]


DATASETS = (
    Dataset('blocks', 'blocks_query', 'Blocks',
            'Canonical blocks. Transaction counts include coinbase; miner is a payout address.',
            (('height', 'i64', 'block'), ('hash', 'str', HASH), ('timestamp', 'i64', UNIX),
             ('miner', 'str', ADDR), ('transactions', 'i64', COUNT), ('bytes', 'i64', 'bytes'), ('fees', 'i64', ZAT)),
            ('height',), bucket=50_000, one_per_height=True),
    Dataset('transactions', 'transactions_query', 'Transactions',
            'Confirmed non-coinbase transactions. Component flags do not reveal private payments.',
            (('txid', 'str', HASH), ('height', 'i64', 'block'), ('timestamp', 'i64', UNIX), ('miner', 'str', ADDR),
             ('shielded', 'bool', 'flag'), ('orchard', 'bool', 'flag'), ('ironwood', 'bool', 'flag'),
             ('sapling', 'bool', 'flag'), ('bytes', 'i64', 'bytes'), ('fees', 'i64', ZAT)),
            ('txid',), bucket=50_000, reconcile_transactions=True),
    Dataset('flows', 'flows_query', 'Public pool flows',
            'Public shielding and deshielding boundary observations. direction is shield or deshield; pool is sprout, '
            'sapling, orchard, ironwood or mixed. Historical completeness is unverified.',
            (('txid', 'str', HASH), ('height', 'i64', 'block'), ('timestamp', 'i64', UNIX), ('direction', 'str', 'enum'),
             ('pool', 'str', 'enum'), ('amount', 'i64', ZAT)),
            ('height', 'txid', 'direction', 'pool', 'amount'), bucket=50_000, unique=False),
    Dataset('issuance', 'issuance_query', 'Block issuance',
            'Consensus block subsidy and its allocation per canonical block. subsidy = miner_subsidy + founders + '
            'funding_streams + lockbox. NULL means the schedule value is unavailable for that height, never zero.',
            (('height', 'i64', 'block'), ('hash', 'str', HASH), ('timestamp', 'i64', UNIX), ('subsidy', 'i64', ZAT),
             ('miner_subsidy', 'i64', ZAT), ('founders', 'i64', ZAT), ('funding_streams', 'i64', ZAT),
             ('lockbox', 'i64', ZAT), ('lockbox_disbursed', 'i64', ZAT), ('fees', 'i64', ZAT)),
            ('height',), bucket=50_000, one_per_height=True),
    Dataset('daily', 'daily_query', 'Daily pool history',
            'UTC daily counts and closing pool balances. Balances are stocks: never sum them across dates.',
            (('date', 'date', DAY), ('transactions', 'i64', COUNT), ('shielded_transactions', 'i64', COUNT),
             ('transparent_transactions', 'i64', COUNT), ('orchard', 'i64', ZAT), ('ironwood', 'i64', ZAT),
             ('sapling', 'i64', ZAT), ('sprout', 'i64', ZAT)),
            ('date',), coverage='daily', date_column='date'),
    Dataset('activity_daily', 'activity_daily_query', 'Daily activity',
            'Completed UTC days derived from canonical non-coinbase transactions. fees is NULL when any fee is missing.',
            (('date', 'date', DAY), ('blocks', 'i64', COUNT), ('transactions', 'i64', COUNT),
             ('shielded_transactions', 'i64', COUNT), ('transparent_transactions', 'i64', COUNT),
             ('unclassified_transactions', 'i64', COUNT), ('bytes', 'i64', 'bytes'), ('fees', 'i64', ZAT),
             ('missing_fees', 'i64', COUNT), ('missing_bytes', 'i64', COUNT)),
            ('date',), coverage='activity_daily', date_column='date'),
    Dataset('flow_daily', 'flow_daily_query', 'Daily pool flows',
            'Completed UTC day, pool and direction aggregates of recorded public boundary flows. amount is NULL when '
            'any amount is missing; absent rows do not certify zero flow.',
            (('date', 'date', DAY), ('pool', 'str', 'enum'), ('direction', 'str', 'enum'), ('records', 'i64', COUNT),
             ('amount', 'i64', ZAT), ('missing_amounts', 'i64', COUNT)),
            ('date', 'pool', 'direction'), coverage='flow_daily', date_column='date'),
    Dataset('supply_daily', 'supply_daily_query', 'Daily supply',
            'Chain state at the last canonical block of each completed UTC date, from the node archive. chain_supply '
            'is all ZEC in every value pool, including the NU6 lockbox.',
            (('date', 'date', DAY), ('height', 'i64', 'block'), ('hash', 'str', HASH), ('timestamp', 'i64', UNIX),
             ('chain_supply', 'i64', ZAT), ('lockbox', 'i64', ZAT), ('circulating_supply', 'i64', ZAT),
             ('net_change', 'i64', ZAT)),
            ('date',), coverage='supply_daily', date_column='date'),
    Dataset('issuance_daily', 'issuance_daily_query', 'Daily issuance',
            'Block subsidy and its allocation summed over the canonical heights first_height through last_height.',
            (('date', 'date', DAY), ('first_height', 'i64', 'block'), ('last_height', 'i64', 'block'),
             ('blocks', 'i64', COUNT), ('subsidy', 'i64', ZAT), ('miner_subsidy', 'i64', ZAT), ('founders', 'i64', ZAT),
             ('funding_streams', 'i64', ZAT), ('lockbox', 'i64', ZAT), ('lockbox_disbursed', 'i64', ZAT)),
            ('date',), coverage='issuance_daily', date_column='date'),
    Dataset('mining_daily', 'mining_daily_query', 'Daily mining pools',
            'Canonical blocks credited to each pool per completed UTC date by the ZecBlock pool registry. Unknown is '
            'unattributed; labels such as Private Miner B name a recurring payout address, not a verified identity.',
            (('date', 'date', DAY), ('pool', 'str', 'label'), ('blocks', 'i64', COUNT), ('day_blocks', 'i64', COUNT)),
            ('date', 'pool'), coverage='mining_daily', date_column='date'),
    Dataset('software_daily', 'software_daily_query', 'Daily node software',
            'Canonical blocks per self-reported coinbase software marker per completed UTC date. Markers are optional.',
            (('date', 'date', DAY), ('software', 'str', 'enum'), ('blocks', 'i64', COUNT), ('day_blocks', 'i64', COUNT)),
            ('date', 'software'), coverage='software_daily', date_column='date'),
    Dataset('utxo_daily', 'utxo_daily_query', 'Daily transparent UTXO set',
            'Transparent UTXO set at each UTC day end, split by output age in days (<30, 30-89, 90-179, 180-364, '
            '365-729, 730+), with spend statistics for that date.',
            (('date', 'date', DAY), ('utxos', 'i64', COUNT), ('unspent', 'i64', ZAT), ('age_lt_1m', 'i64', ZAT),
             ('age_1_3m', 'i64', ZAT), ('age_3_6m', 'i64', ZAT), ('age_6_12m', 'i64', ZAT), ('age_1_2y', 'i64', ZAT),
             ('age_gt_2y', 'i64', ZAT), ('spent_outputs', 'i64', COUNT), ('cdd', 'dec:4', 'ZEC-days'),
             ('avg_dormancy_days', 'dec:4', 'days'), ('realized_cap_usd', 'dec:2', 'USD'),
             ('avg_cost_basis_usd', 'dec:4', 'USD')),
            ('date',), coverage='utxo_daily', date_column='date'),
    Dataset('swap_daily', 'swap_daily_query', 'Daily cross-chain swaps',
            'Successful ZEC swaps per completed UTC date, venue, direction and counterparty, from tracked venues only. '
            'Groups under 5 swaps are folded into other. zec and usd are rounded sums, NULL when under 5 swaps carry '
            'the value.',
            (('date', 'date', DAY), ('venue', 'str', 'enum'), ('direction', 'str', 'enum'), ('chain', 'str', 'label'),
             ('token', 'str', 'label'), ('swaps', 'i64', COUNT), ('zec', 'i64', 'whole ZEC'), ('usd', 'i64', 'whole USD'),
             ('missing_zec', 'i64', COUNT), ('missing_usd', 'i64', COUNT)),
            ('date', 'venue', 'direction', 'chain', 'token'), coverage='swap_daily', date_column='date',
            date_window_start='2025-01-01', date_window_days=90),
    Dataset('block_timing', 'block_timing_query', 'Block first-seen timing',
            'Earliest ZecBlock receipt of each canonical block its collectors received. lag_seconds is first_seen minus '
            'the miner-written header time, so it mixes miner clock offset with propagation to ZecBlock. Blocks neither '
            'collector saw are absent, not zero.',
            (('height', 'i64', 'block'), ('hash', 'str', HASH), ('timestamp', 'i64', UNIX), ('miner', 'str', ADDR),
             ('first_seen', 'dec:3', UNIX), ('lag_seconds', 'dec:3', 'seconds'), ('observed_by', 'str', 'enum')),
            ('height',), bucket=50_000, coverage='block_timing', delayed=True),
    Dataset('reorgs', 'reorgs_query', 'Chain reorganisations',
            'Each chain reorganisation the ZecBlock indexer detected and rolled back. fork_height is the first '
            'rolled-back height and depth is how many blocks were replaced.',
            (('reorg_id', 'i64', 'id'), ('fork_height', 'i64', 'block'), ('depth', 'i64', 'blocks'),
             ('reported_orphans', 'i64', COUNT), ('orphans', 'i64', COUNT), ('detected_at', 'i64', UNIX)),
            ('reorg_id',), coverage='reorgs', time_column='detected_at', delayed=True),
    Dataset('orphaned_blocks', 'orphaned_blocks_query', 'Orphaned blocks',
            'Each block replaced during a detected reorg. canonical_now is true when a later reorg restored the hash '
            'to the canonical chain.',
            (('height', 'i64', 'block'), ('hash', 'str', HASH), ('canonical_hash', 'str', HASH), ('timestamp', 'i64', UNIX),
             ('miner', 'str', ADDR), ('transactions', 'i64', COUNT), ('bytes', 'i64', 'bytes'), ('reorg_id', 'i64', 'id'),
             ('detected_at', 'i64', UNIX), ('canonical_now', 'bool', 'flag')),
            ('hash', 'reorg_id'), coverage='orphaned_blocks', time_column='detected_at', delayed=True),
)
