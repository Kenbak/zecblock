#!/usr/bin/env python3
"""Export ZecBlock public datasets as Parquet and publish them to Hugging Face.

`export` reads only the analytics_public views and needs no network or token.
`publish` needs a token and no database. Keeping them apart lets each run with
only the access it needs.

A bundle is staged in full and swapped in only after every check passes, so a
failed run leaves the previous bundle untouched and publishes nothing.
"""
import argparse
import datetime as dt
import decimal
import hashlib
import json
import os
import pathlib
import shutil
import sys
import tempfile
import time
from dataclasses import dataclass
from typing import Optional

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from catalogue import DATASETS

FINALITY_DEPTH = 100
DEFAULT_DELAY_DAYS = 30
# Upper bound on blocks per day after the 25-second block target, with margin.
BLOCKS_PER_DAY_BOUND = 4_000
FETCH_SIZE = 20_000
HF_LICENSE = 'cc-by-4.0'
SITE = 'https://zecblock.com'


class ExportError(RuntimeError):
    pass


class Inconsistent(ExportError):
    """A read did not reconcile; usually a transient coverage or replication state."""


@dataclass(frozen=True)
class Options:
    delay_days: int = DEFAULT_DELAY_DAYS
    full: bool = False
    source_commit: Optional[str] = None
    ready_wait_seconds: float = 300
    retry_seconds: float = 15
    attempts: int = 3
    # Test hook: smaller buckets exercise partitioning without millions of rows.
    bucket_override: Optional[int] = None


def arrow_type(code):
    if code.startswith('dec:'):
        return pa.decimal128(38, int(code[4:]))
    return {'i64': pa.int64(), 'bool': pa.bool_(), 'str': pa.string(), 'date': pa.date32()}[code]


def schema_for(ds):
    return pa.schema([pa.field(name, arrow_type(code)) for name, code, _ in ds.columns])


def coerce(value, code, label):
    """Return a value safe for its Arrow type, or fail. Never rounds or guesses."""
    if value is None:
        return None
    if code == 'i64':
        if isinstance(value, bool) or not isinstance(value, (int, decimal.Decimal)):
            raise ExportError(f'{label}: expected integer, got {type(value).__name__}')
        if isinstance(value, decimal.Decimal) and value != value.to_integral_value():
            raise ExportError(f'{label}: non-integer value')
        return int(value)
    if code.startswith('dec:'):
        if isinstance(value, bool) or not isinstance(value, (int, decimal.Decimal)):
            raise ExportError(f'{label}: expected exact decimal, got {type(value).__name__}')
        scale = int(code[4:])
        exact = decimal.Decimal(value)
        quantized = exact.quantize(decimal.Decimal(1).scaleb(-scale))
        if quantized != exact:
            raise ExportError(f'{label}: more than {scale} decimal places')
        return quantized
    expected = {'bool': bool, 'str': str}.get(code)
    if expected and not isinstance(value, expected):
        raise ExportError(f'{label}: expected {code}, got {type(value).__name__}')
    if code == 'date' and (isinstance(value, dt.datetime) or not isinstance(value, dt.date)):
        raise ExportError(f'{label}: expected date, got {type(value).__name__}')
    return value


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def utc_day_start(day):
    return int(dt.datetime(day.year, day.month, day.day, tzinfo=dt.timezone.utc).timestamp())


def connect(dsn):
    import psycopg2
    conn = psycopg2.connect(dsn)
    conn.set_session(readonly=True, autocommit=False)
    with conn.cursor() as cur:
        # The reader role defaults suit short interactive queries, not bulk reads.
        cur.execute("SET statement_timeout='120s'; SET idle_in_transaction_session_timeout='120s'")
    conn.commit()
    return conn


def one(conn, sql, params=()):
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchone()
    finally:
        conn.rollback()


def read_coverage(conn):
    row = one(conn, 'SELECT ready,covered_from,covered_through,tip_hash,flow_completeness '
                    'FROM analytics_public.coverage')
    if row is None:
        raise ExportError('analytics coverage has no row')
    return dict(zip(('ready', 'covered_from', 'covered_through', 'tip_hash', 'flow_completeness'), row))


def is_ready(conn, coverage_key):
    if not read_coverage(conn)['ready']:
        return False
    if coverage_key is None:
        return True
    row = one(conn, 'SELECT ready FROM analytics_public.dataset_coverage WHERE dataset=%s', (coverage_key,))
    return bool(row and row[0])


def wait_ready(conn, coverage_key, options):
    deadline = time.monotonic() + options.ready_wait_seconds
    while not is_ready(conn, coverage_key):
        if time.monotonic() >= deadline:
            raise ExportError(f'coverage not ready: {coverage_key or "core"}')
        time.sleep(min(10, options.ready_wait_seconds))


def first_height_at(conn, timestamp, tip, window):
    low = max(0, tip - window)
    row = one(conn, 'SELECT min(height) FROM analytics_public.blocks_query '
                    'WHERE height BETWEEN %s AND %s AND "timestamp">=%s', (low, tip, timestamp))
    if row[0] is None:
        raise ExportError('no block found at or after the cutoff time')
    if low > 0 and row[0] == low:
        raise ExportError('cutoff search window is too small')
    return row[0]


def compute_snapshot(conn, coverage, options):
    """Pick the last completed UTC date whose blocks are all past finality depth."""
    tip = coverage['covered_through']
    final_height = tip - FINALITY_DEPTH
    row = one(conn, 'SELECT "timestamp" FROM analytics_public.blocks_query WHERE height=%s', (final_height,))
    if row is None:
        raise ExportError('finality block is missing')
    through_date = dt.datetime.fromtimestamp(row[0], dt.timezone.utc).date() - dt.timedelta(days=1)
    next_start = utc_day_start(through_date + dt.timedelta(days=1))
    through_height = first_height_at(conn, next_start, tip, 10 * BLOCKS_PER_DAY_BOUND) - 1
    block = one(conn, 'SELECT hash,"timestamp" FROM analytics_public.blocks_query WHERE height=%s', (through_height,))
    if block is None:
        raise ExportError('cutoff block is missing')
    delayed_date = through_date - dt.timedelta(days=options.delay_days)
    delayed_end = utc_day_start(delayed_date + dt.timedelta(days=1))
    delayed_height = first_height_at(conn, delayed_end, tip,
                                     (options.delay_days + 10) * BLOCKS_PER_DAY_BOUND) - 1
    return {
        'through_date': through_date.isoformat(),
        'through_height': through_height,
        'through_block_hash': block[0],
        'through_block_time': block[1],
        'chain_tip_height_at_export': tip,
        'finality_depth': FINALITY_DEPTH,
        'delay_days': options.delay_days,
        'delayed_through_date': delayed_date.isoformat(),
        'delayed_through_height': delayed_height,
        'delayed_through_time_exclusive': delayed_end,
    }


def build_windows(ds, snapshot):
    """Return [(sql, params)] read windows bounding a single-file table to the snapshot.

    Tables with date_window_days are read in disjoint date ranges, because their
    views would otherwise exceed the reader role's temporary-file limit.
    """
    if ds.time_column:
        if not ds.delayed:
            raise ExportError(f'{ds.id}: time bound requires the delayed cutoff')
        return [(f'"{ds.time_column}"<%s', (snapshot['delayed_through_time_exclusive'],))]
    column = ds.date_column
    day = dt.date.fromisoformat(snapshot['delayed_through_date'] if ds.delayed else snapshot['through_date'])
    if not ds.date_window_days:
        return [(f'"{column}"<=%s', (day,))]
    start = dt.date.fromisoformat(ds.date_window_start)
    windows = [(f'"{column}"<%s', (start,))]
    while start <= day:
        end = start + dt.timedelta(days=ds.date_window_days)
        windows.append((f'"{column}">=%s AND "{column}"<%s AND "{column}"<=%s', (start, end, day)))
        start = end
    return windows


def fetch_table(conn, ds, windows):
    columns = ','.join(f'"{name}"' for name in ds.names)
    values = [[] for _ in ds.columns]
    codes = [(code, f'{ds.id}.{name}') for name, code, _ in ds.columns]
    for where, params in windows:
        sql = f'SELECT {columns} FROM analytics_public.{ds.view} WHERE {where}'
        try:
            with conn.cursor(name='open_data_export') as cur:
                cur.itersize = FETCH_SIZE
                cur.execute(sql, params)
                for row in cur:
                    for index, cell in enumerate(row):
                        code, label = codes[index]
                        values[index].append(coerce(cell, code, label))
        finally:
            conn.rollback()
    schema = schema_for(ds)
    return pa.table([pa.array(column, type=schema.field(i).type) for i, column in enumerate(values)], schema=schema)


def count_rows(conn, ds, windows):
    return sum(one(conn, f'SELECT count(*) FROM analytics_public.{ds.view} WHERE {where}', params)[0]
               for where, params in windows)


def validate_table(table, ds, windows, conn, span):
    expected = count_rows(conn, ds, windows)
    if table.num_rows != expected:
        raise Inconsistent(f'{ds.id}: read {table.num_rows} rows, count says {expected}')
    if span and ds.one_per_height and table.num_rows != span[1] - span[0] + 1:
        raise Inconsistent(f'{ds.id}: {table.num_rows} rows for heights {span[0]}-{span[1]}')
    if span and ds.reconcile_transactions:
        row = one(conn, 'SELECT count(*),sum(transactions) FROM analytics_public.blocks_query '
                        'WHERE height BETWEEN %s AND %s', span)
        if row[1] is None or table.num_rows != int(row[1]) - row[0]:
            raise Inconsistent(f'{ds.id}: {table.num_rows} rows do not reconcile with block totals '
                               f'for heights {span[0]}-{span[1]}')
    for name in ds.key:
        if ds.unique and name not in ds.nullable_keys and table.column(name).null_count:
            raise ExportError(f'{ds.id}: NULL in key column {name}')
    if ds.unique and table.num_rows:
        if table.group_by(list(ds.key)).aggregate([]).num_rows != table.num_rows:
            raise ExportError(f'{ds.id}: duplicate key rows')


def write_parquet(table, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, path, compression='zstd', compression_level=9,
                   row_group_size=100_000, write_statistics=True)


def export_part(conn, ds, windows, path, span, options):
    """Read, validate and write one file. Returns its row count."""
    last_error = None
    for attempt in range(options.attempts):
        if attempt:
            time.sleep(options.retry_seconds)
        wait_ready(conn, ds.coverage, options)
        table = fetch_table(conn, ds, windows)
        try:
            validate_table(table, ds, windows, conn, span)
        except Inconsistent as error:
            last_error = error
            continue
        if table.num_rows:
            # Sorted client-side: the reader role has tiny sort memory by design.
            write_parquet(table.sort_by([(name, 'ascending') for name in ds.key]), path)
        return table.num_rows
    raise last_error


def file_entry(root, path, rows, through):
    return {'path': path.relative_to(root).as_posix(), 'sha256': sha256_file(path),
            'bytes': path.stat().st_size, 'rows': rows, 'through': through}


def height_bounds(ds, snapshot):
    return snapshot['delayed_through_height'] if ds.delayed else snapshot['through_height']


def bucket_paths(ds, limit, options):
    size = options.bucket_override or ds.bucket
    for start in range(0, limit + 1, size):
        full_end = start + size - 1
        yield start, min(full_end, limit), full_end, f'data/{ds.id}/height-{start:08d}-{full_end:08d}.parquet'


def reusable(prior, ds, relative, full_end, current_dir, options):
    if options.full or not prior:
        return None
    prior_ds = prior['datasets'].get(ds.id)
    if not prior_ds or prior_ds['version'] != ds.version:
        return None
    entry = next((item for item in prior_ds['files'] if item['path'] == relative), None)
    if not entry or entry['through'] != full_end or not (current_dir / relative).is_file():
        return None
    return entry


def export_dataset(conn, ds, staging, current_dir, prior, snapshot, options):
    wait_ready(conn, ds.coverage, options)
    files = []
    if ds.bucket:
        for start, end, full_end, relative in bucket_paths(ds, height_bounds(ds, snapshot), options):
            windows = [('height BETWEEN %s AND %s', (start, end))]
            path = staging / relative
            entry = reusable(prior, ds, relative, full_end, current_dir, options)
            # A changed row count means history was repaired; rebuild that bucket.
            if entry and count_rows(conn, ds, windows) == entry['rows'] \
                    and sha256_file(current_dir / relative) == entry['sha256']:
                path.parent.mkdir(parents=True, exist_ok=True)
                os.link(current_dir / relative, path)
                files.append(entry)
                continue
            rows = export_part(conn, ds, windows, path, (start, end), options)
            if rows:
                files.append(file_entry(staging, path, rows, end))
    else:
        path = staging / f'data/{ds.id}/{ds.id}.parquet'
        rows = export_part(conn, ds, build_windows(ds, snapshot), path, None, options)
        if not rows:
            raise ExportError(f'{ds.id}: no rows in the snapshot')
        files.append(file_entry(staging, path, rows, None))
    if not is_ready(conn, ds.coverage):
        raise ExportError(f'coverage changed during export: {ds.id}')
    print(f'{ds.id}: {sum(item["rows"] for item in files)} rows in {len(files)} files', file=sys.stderr, flush=True)
    return {'version': ds.version, 'title': ds.title, 'rows': sum(item['rows'] for item in files), 'files': files}


def content_id(manifest):
    pairs = sorted((item['path'], item['sha256'])
                   for ds in manifest['datasets'].values() for item in ds['files'])
    payload = json.dumps({'snapshot': manifest['snapshot']['through_height'], 'files': pairs}, separators=(',', ':'))
    return hashlib.sha256(payload.encode()).hexdigest()


def render_card(manifest):
    snapshot = manifest['snapshot']
    lines = ['---', f'license: {HF_LICENSE}', 'pretty_name: ZecBlock Zcash Mainnet', 'tags:',
             '  - zcash', '  - blockchain', '  - cryptocurrency', '  - privacy', '  - time-series', 'configs:']
    for ds in DATASETS:
        lines += [f'  - config_name: {ds.id}', f'    data_files: "data/{ds.id}/*.parquet"']
    lines += ['---', '', '# ZecBlock Zcash Mainnet', '',
              f'Canonical Zcash mainnet data published by [ZecBlock]({SITE}), as Parquet.', '',
              '## Snapshot', '', '| | |', '|---|---|',
              f"| Complete through UTC date | {snapshot['through_date']} |",
              f"| Through block height | {snapshot['through_height']} |",
              f"| Block hash at that height | `{snapshot['through_block_hash']}` |",
              f"| Finality depth | {snapshot['finality_depth']} blocks |",
              f"| Observation tables through | {snapshot['delayed_through_date']} |", '',
              '`manifest.json` lists the SHA-256, size and row count of every file.', '',
              '## Load it', '', '```python', 'from datasets import load_dataset', '',
              'blocks = load_dataset("zecblock/zcash-mainnet", "blocks", split="train")', '```', '',
              '```sql', "SELECT * FROM 'hf://datasets/zecblock/zcash-mainnet/data/daily/*.parquet';", '```', '',
              '## Conventions', '',
              '- Amounts are integer zatoshis unless a column says otherwise. 100,000,000 zatoshis is 1 ZEC.',
              '- NULL means unknown or unavailable. It never means zero.',
              '- Encrypted shielded amounts are not observable and do not appear here.',
              '- Timestamps are Unix seconds UTC. Block header times are written by miners.',
              '- Balance columns are stocks. Never sum them across dates.', '',
              '## Tables', '', '| Table | Rows | Definition version |', '|---|---:|---:|']
    for ds in DATASETS:
        entry = manifest['datasets'][ds.id]
        lines.append(f"| `{ds.id}` | {entry['rows']:,} | {ds.version} |")
    for ds in DATASETS:
        lines += ['', f'### {ds.id}', '', ds.description, '']
        if ds.delayed:
            lines += [f"Published {snapshot['delay_days']} days behind the snapshot. Current data is on the "
                      f'[ZecBlock API]({SITE}/docs).', '']
        lines += ['| Column | Type | Unit |', '|---|---|---|']
        lines += [f'| `{name}` | {code} | {unit} |' for name, code, unit in ds.columns]
    lines += ['', '## License and citation', '',
              'Licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). '
              'Credit ZecBlock and link to the source when you use this data:', '',
              f"> ZecBlock, Zcash Mainnet dataset, through block {snapshot['through_height']}. {SITE}", '']
    return '\n'.join(lines)


def verify_bundle(folder):
    """Check a bundle is complete and untampered. Returns its manifest."""
    folder = pathlib.Path(folder)
    manifest = json.loads((folder / 'manifest.json').read_text())
    expected = {'manifest.json', 'README.md'}
    for ds in manifest['datasets'].values():
        for item in ds['files']:
            expected.add(item['path'])
            path = folder / item['path']
            if not path.is_file() or sha256_file(path) != item['sha256']:
                raise ExportError(f"checksum mismatch: {item['path']}")
            if pq.read_metadata(path).num_rows != item['rows']:
                raise ExportError(f"row count mismatch: {item['path']}")
    actual = {path.relative_to(folder).as_posix() for path in folder.rglob('*') if path.is_file()}
    if actual != expected:
        raise ExportError(f'unexpected or missing files: {sorted(actual ^ expected)[:5]}')
    if content_id(manifest) != manifest['content_id']:
        raise ExportError('manifest content id does not match its files')
    return manifest


def run_export(conn, out, options):
    out = pathlib.Path(out)
    out.mkdir(parents=True, exist_ok=True)
    current_dir = out / 'current'
    prior = json.loads((current_dir / 'manifest.json').read_text()) if (current_dir / 'manifest.json').exists() else None
    wait_ready(conn, None, options)
    coverage = read_coverage(conn)
    snapshot = compute_snapshot(conn, coverage, options)
    if prior and snapshot['through_height'] < prior['snapshot']['through_height']:
        raise ExportError('snapshot would move backwards')
    staging = pathlib.Path(tempfile.mkdtemp(prefix='.staging-', dir=out))
    try:
        datasets = {ds.id: export_dataset(conn, ds, staging, current_dir, prior, snapshot, options)
                    for ds in DATASETS}
        manifest = {
            'schema_version': 1, 'publisher': 'ZecBlock', 'source': SITE, 'network': 'mainnet',
            'license': 'CC-BY-4.0', 'generated_at': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
            'source_commit': options.source_commit, 'flow_completeness': coverage['flow_completeness'],
            'snapshot': snapshot, 'datasets': datasets,
        }
        manifest['content_id'] = content_id(manifest)
        (staging / 'README.md').write_text(render_card(manifest))
        (staging / 'manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
        verify_bundle(staging)
        staging.chmod(0o755)
        retired = out / '.retired'
        if retired.exists():
            shutil.rmtree(retired)
        if current_dir.exists():
            current_dir.rename(retired)
        staging.rename(current_dir)
        if retired.exists():
            shutil.rmtree(retired)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return manifest


def fetch_remote_manifest(api, repo, revision=None):
    from huggingface_hub.errors import EntryNotFoundError
    with tempfile.TemporaryDirectory() as cache:
        try:
            path = api.hf_hub_download(repo_id=repo, filename='manifest.json', repo_type='dataset',
                                       revision=revision, cache_dir=cache)
        except EntryNotFoundError:
            return None
        return json.loads(pathlib.Path(path).read_text())


def run_publish(bundle, repo, api):
    from huggingface_hub.errors import RepositoryNotFoundError
    manifest = verify_bundle(bundle)
    try:
        api.repo_info(repo_id=repo, repo_type='dataset')
    except RepositoryNotFoundError as error:
        raise ExportError(f'dataset repository {repo} does not exist or the token cannot see it') from error
    remote = fetch_remote_manifest(api, repo)
    if remote and remote.get('content_id') == manifest['content_id']:
        return 'unchanged'
    if remote and remote['snapshot']['through_height'] > manifest['snapshot']['through_height']:
        raise ExportError('remote dataset is newer than this bundle')
    through = manifest['snapshot']['through_height']
    commit = api.upload_folder(repo_id=repo, repo_type='dataset', folder_path=str(bundle),
                               commit_message=f'Snapshot through block {through}', delete_patterns=['data/**'])
    published = fetch_remote_manifest(api, repo, revision=commit.oid)
    if not published or published.get('content_id') != manifest['content_id']:
        raise ExportError('published manifest does not match the bundle')
    return commit.oid


def read_token():
    path = os.environ.get('HF_TOKEN_FILE')
    if not path and os.environ.get('CREDENTIALS_DIRECTORY'):
        path = os.path.join(os.environ['CREDENTIALS_DIRECTORY'], 'hf_token')
    if not path:
        raise ExportError('set HF_TOKEN_FILE or provide the hf_token systemd credential')
    token = pathlib.Path(path).read_text().strip()
    if not token:
        raise ExportError('token file is empty')
    return token


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest='command', required=True)
    export = commands.add_parser('export')
    export.add_argument('--out', required=True)
    export.add_argument('--delay-days', type=int, default=DEFAULT_DELAY_DAYS)
    export.add_argument('--full', action='store_true', help='rebuild every partition')
    export.add_argument('--source-commit')
    publish = commands.add_parser('publish')
    publish.add_argument('--bundle', required=True)
    publish.add_argument('--repo', default='zecblock/zcash-mainnet')
    args = parser.parse_args(argv)
    try:
        if args.command == 'export':
            dsn = os.environ.get('OPEN_DATA_DATABASE_URL')
            if not dsn:
                raise ExportError('set OPEN_DATA_DATABASE_URL')
            conn = connect(dsn)
            try:
                manifest = run_export(conn, args.out, Options(delay_days=args.delay_days, full=args.full,
                                                              source_commit=args.source_commit))
            finally:
                conn.close()
            print(json.dumps({'content_id': manifest['content_id'], 'snapshot': manifest['snapshot']}))
        else:
            from huggingface_hub import HfApi
            print(json.dumps({'result': run_publish(pathlib.Path(args.bundle), args.repo, HfApi(token=read_token()))}))
    except ExportError as error:
        print(f'open-data: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
