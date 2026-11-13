"""Exercise the exporter against a real, disposable PostgreSQL.

OPEN_DATA_PG_BIN=/absolute/pg/bin python3 -m unittest server/open-data/test_open_data.py
"""
import datetime as dt
import decimal
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import types
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import pyarrow.parquet as pq  # noqa: E402

import open_data  # noqa: E402
from catalogue import DATASETS  # noqa: E402

BY_ID = {ds.id: ds for ds in DATASETS}
PG_TYPES = {'i64': 'bigint', 'str': 'text', 'bool': 'boolean', 'date': 'date'}
T0 = int(dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc).timestamp())
TIP = 7_000
DAY = 86_400
BUCKET = 1_000
OPTIONS = open_data.Options(delay_days=2, ready_wait_seconds=0, retry_seconds=0, attempts=2, bucket_override=BUCKET)


def pg_type(code):
    return f'numeric(38,{code[4:]})' if code.startswith('dec:') else PG_TYPES[code]


def block_time(height):
    return T0 + 75 * height


def generic_value(code, name, index):
    if name == 'date':
        return dt.date(2026, 1, 1) + dt.timedelta(days=index)
    if name == 'detected_at':
        return T0 + index * DAY
    if code == 'i64':
        return index + 1
    if code == 'bool':
        return True
    if code == 'str':
        return f'{name}-{index}'
    return decimal.Decimal(1).scaleb(-int(code[4:]))


@unittest.skipUnless(os.environ.get('OPEN_DATA_PG_BIN'), 'set OPEN_DATA_PG_BIN for the real PostgreSQL proof')
class ExportTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bin = pathlib.Path(os.environ['OPEN_DATA_PG_BIN'])
        cls.root = pathlib.Path(tempfile.mkdtemp(prefix='od-'))
        cls.data = cls.root / 'pg'
        subprocess.run([cls.bin / 'initdb', '-D', cls.data, '-U', 'fixture', '-A', 'trust', '--no-locale', '-E', 'UTF8'],
                       check=True, capture_output=True)
        with (cls.data / 'postgresql.conf').open('a') as handle:
            handle.write(f"\nlisten_addresses=''\nunix_socket_directories='{cls.root}'\n")
        subprocess.run([cls.bin / 'pg_ctl', '-D', cls.data, '-l', cls.root / 'log', '-w', 'start'],
                       check=True, capture_output=True)
        cls.conn = open_data.connect(f'host={cls.root} dbname=postgres user=fixture')
        import psycopg2
        cls.admin = psycopg2.connect(f'host={cls.root} dbname=postgres user=fixture')
        cls.admin.autocommit = True

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()
        cls.admin.close()
        subprocess.run([cls.bin / 'pg_ctl', '-D', cls.data, '-m', 'immediate', 'stop'], check=True, capture_output=True)
        shutil.rmtree(cls.root)

    def sql(self, text, params=()):
        with self.admin.cursor() as cur:
            cur.execute(text, params)

    def many(self, ds, rows):
        columns = ','.join(f'"{name}"' for name in ds.names)
        holders = ','.join(['%s'] * len(ds.names))
        with self.admin.cursor() as cur:
            cur.executemany(f'INSERT INTO analytics_public.{ds.view}({columns}) VALUES({holders})', rows)

    def setUp(self):
        self.sql('DROP SCHEMA IF EXISTS analytics_public CASCADE; CREATE SCHEMA analytics_public')
        self.sql('CREATE TABLE analytics_public.coverage(ready boolean,covered_from bigint,covered_through bigint,'
                 'tip_hash text,flow_completeness text)')
        self.sql("INSERT INTO analytics_public.coverage VALUES(true,0,%s,'tip','fixture')", (TIP,))
        self.sql('CREATE TABLE analytics_public.dataset_coverage(dataset text,ready boolean)')
        for ds in DATASETS:
            columns = ','.join(f'"{name}" {pg_type(code)}' for name, code, _ in ds.columns)
            self.sql(f'CREATE TABLE analytics_public.{ds.view}({columns})')
            if ds.coverage:
                self.sql('INSERT INTO analytics_public.dataset_coverage VALUES(%s,true)', (ds.coverage,))
        heights = range(TIP + 1)
        self.many(BY_ID['blocks'], [(h, f'b{h}', block_time(h), 't1', 2, 100, 1000) for h in heights])
        self.many(BY_ID['transactions'], [(f'tx{h}', h, block_time(h), 't1', True, True, False, False, 10, None if h == 5 else 7)
                                          for h in heights])
        self.many(BY_ID['flows'], [(f'tx{h}', h, block_time(h), 'shield', 'orchard', 2_100_000_000_000_000)
                                   for h in range(0, TIP, 10)])
        self.many(BY_ID['issuance'], [(h, f'b{h}', block_time(h), 625000000, 500000000, 0, 0, 125000000, None, 1000)
                                      for h in heights])
        self.many(BY_ID['block_timing'], [(h, f'b{h}', block_time(h), 't1', decimal.Decimal(block_time(h)) + decimal.Decimal('1.234'),
                                           decimal.Decimal('1.234'), 'node-block-stream') for h in heights])
        for ds in DATASETS:
            if ds.bucket is None:
                self.many(ds, [tuple(generic_value(code, name, index) for name, code, _ in ds.columns)
                               for index in range(7)])
        self.out = pathlib.Path(tempfile.mkdtemp(prefix='od-out-'))
        self.addCleanup(shutil.rmtree, self.out, True)

    def export(self, options=OPTIONS):
        return open_data.run_export(self.conn, self.out, options)

    def read(self, table):
        return pq.read_table(self.out / 'current' / 'data' / table).to_pydict()

    def test_publishes_only_finalized_completed_days_with_exact_values(self):
        manifest = self.export()
        snapshot = manifest['snapshot']
        # Height 6900 falls on Jan 6, so Jan 5 is the last fully final date.
        self.assertEqual(snapshot['through_date'], '2026-01-05')
        self.assertEqual(snapshot['through_height'], 5 * DAY // 75 - 1)
        self.assertEqual(snapshot['through_block_hash'], f"b{snapshot['through_height']}")
        blocks = self.read('blocks')
        self.assertEqual(blocks['height'], list(range(snapshot['through_height'] + 1)))
        self.assertEqual(manifest['datasets']['transactions']['rows'], snapshot['through_height'] + 1)
        transactions = self.read('transactions')
        self.assertIsNone(transactions['fees'][transactions['txid'].index('tx5')])
        self.assertEqual(self.read('flows')['amount'][0], 2_100_000_000_000_000)
        daily = self.read('daily')
        self.assertEqual(max(daily['date']), dt.date(2026, 1, 5))

    def test_observation_tables_lag_the_snapshot(self):
        manifest = self.export()
        snapshot = manifest['snapshot']
        self.assertEqual(snapshot['delayed_through_date'], '2026-01-03')
        timing = self.read('block_timing')
        self.assertEqual(max(timing['height']), snapshot['delayed_through_height'])
        self.assertLess(max(timing['height']), snapshot['through_height'])
        self.assertEqual(timing['first_seen'][0], decimal.Decimal(T0) + decimal.Decimal('1.234'))
        self.assertLess(max(self.read('reorgs')['detected_at']), T0 + 3 * DAY)

    def test_sensitive_tables_are_never_exported(self):
        self.export()
        names = {path.name for path in (self.out / 'current' / 'data').iterdir()}
        self.assertEqual(names, set(BY_ID))
        self.assertTrue(names.isdisjoint({'addresses', 'address_activity', 'labels', 'swaps'}))

    def test_card_declares_every_config_and_license(self):
        manifest = self.export()
        card = (self.out / 'current' / 'README.md').read_text()
        self.assertTrue(card.startswith('---\nlicense: cc-by-4.0\n'))
        for ds in DATASETS:
            self.assertIn(f'config_name: {ds.id}\n    data_files: "data/{ds.id}/*.parquet"', card)
        self.assertIn(manifest['snapshot']['through_block_hash'], card)
        from huggingface_hub import DatasetCard
        parsed = DatasetCard(card).data.to_dict()
        self.assertEqual(parsed['license'], 'cc-by-4.0')
        self.assertEqual([item['config_name'] for item in parsed['configs']], [ds.id for ds in DATASETS])

    def assert_failure_keeps_previous(self, message):
        before = (self.out / 'current' / 'manifest.json').read_bytes()
        with self.assertRaisesRegex(open_data.ExportError, message):
            self.export()
        self.assertEqual((self.out / 'current' / 'manifest.json').read_bytes(), before)
        self.assertEqual([path.name for path in self.out.iterdir()], ['current'])

    def test_not_ready_coverage_refuses_and_keeps_previous_bundle(self):
        self.export()
        self.sql('UPDATE analytics_public.coverage SET ready=false')
        self.assert_failure_keeps_previous('not ready')

    def test_one_dataset_not_ready_refuses_the_whole_bundle(self):
        self.export()
        self.sql("UPDATE analytics_public.dataset_coverage SET ready=false WHERE dataset='swap_daily'")
        self.assert_failure_keeps_previous('swap_daily')

    def test_transactions_must_reconcile_with_blocks(self):
        self.sql('DELETE FROM analytics_public.transactions_query WHERE height=3')
        with self.assertRaisesRegex(open_data.ExportError, 'reconcile'):
            self.export()
        self.assertFalse((self.out / 'current').exists())

    def test_missing_block_is_refused(self):
        self.sql('DELETE FROM analytics_public.blocks_query WHERE height=3')
        with self.assertRaisesRegex(open_data.ExportError, 'blocks: 999 rows'):
            self.export()

    def test_duplicate_keys_are_refused(self):
        self.sql("INSERT INTO analytics_public.daily_query SELECT * FROM analytics_public.daily_query WHERE date='2026-01-01'")
        with self.assertRaisesRegex(open_data.ExportError, 'daily: duplicate'):
            self.export()

    def test_fractional_zatoshis_are_refused_not_rounded(self):
        with self.assertRaisesRegex(open_data.ExportError, 'non-integer'):
            open_data.coerce(decimal.Decimal('1.5'), 'i64', 'x')
        with self.assertRaisesRegex(open_data.ExportError, 'decimal places'):
            open_data.coerce(decimal.Decimal('1.2345'), 'dec:3', 'x')
        self.assertEqual(open_data.coerce(decimal.Decimal('21000000'), 'i64', 'x'), 21_000_000)

    def test_second_run_reuses_complete_buckets_and_rebuilds_repaired_ones(self):
        self.export()
        current = self.out / 'current' / 'data' / 'blocks'
        complete = current / 'height-00000000-00000999.parquet'
        flows = self.out / 'current' / 'data' / 'flows' / 'height-00000000-00000999.parquet'
        block_inode, flow_inode = complete.stat().st_ino, flows.stat().st_ino
        self.sql("INSERT INTO analytics_public.flows_query VALUES('late',11,%s,'deshield','sapling',5)", (block_time(11),))
        manifest = self.export()
        self.assertEqual(complete.stat().st_ino, block_inode)
        self.assertNotEqual(flows.stat().st_ino, flow_inode)
        self.assertIn('late', pq.read_table(flows).to_pydict()['txid'])
        open_data.verify_bundle(self.out / 'current')
        self.assertEqual(manifest['schema_version'], 1)


class FakeApi:
    def __init__(self, remote=None, missing=False):
        self.remote, self.missing, self.uploads = remote, missing, []

    def repo_info(self, repo_id, repo_type):
        if self.missing:
            from huggingface_hub.errors import RepositoryNotFoundError
            raise RepositoryNotFoundError('missing', response=types.SimpleNamespace(headers={}, status_code=404, url='x', request=None))

    def hf_hub_download(self, repo_id, filename, repo_type, revision, cache_dir):
        path = pathlib.Path(cache_dir) / filename
        if self.remote is None:
            from huggingface_hub.errors import EntryNotFoundError
            raise EntryNotFoundError('none')
        path.write_text(json.dumps(self.remote))
        return str(path)

    def upload_folder(self, repo_id, repo_type, folder_path, commit_message, delete_patterns):
        self.uploads.append((repo_id, delete_patterns))
        self.remote = json.loads((pathlib.Path(folder_path) / 'manifest.json').read_text())
        return types.SimpleNamespace(oid='abc')


class PublishTest(unittest.TestCase):
    def setUp(self):
        self.bundle = pathlib.Path(tempfile.mkdtemp(prefix='od-bundle-'))
        self.addCleanup(shutil.rmtree, self.bundle, True)
        import pyarrow as pa
        path = self.bundle / 'data' / 'daily' / 'daily.parquet'
        path.parent.mkdir(parents=True)
        pq.write_table(pa.table({'a': [1, 2]}), path)
        self.manifest = {'snapshot': {'through_height': 100}, 'datasets': {'daily': {'version': 1, 'rows': 2, 'files': [
            {'path': 'data/daily/daily.parquet', 'sha256': open_data.sha256_file(path), 'bytes': path.stat().st_size,
             'rows': 2, 'through': None}]}}}
        self.manifest['content_id'] = open_data.content_id(self.manifest)
        (self.bundle / 'README.md').write_text('card')
        (self.bundle / 'manifest.json').write_text(json.dumps(self.manifest))

    def test_uploads_and_verifies(self):
        api = FakeApi()
        self.assertEqual(open_data.run_publish(self.bundle, 'zecblock/zcash-mainnet', api), 'abc')
        self.assertEqual(api.uploads, [('zecblock/zcash-mainnet', ['data/**'])])

    def test_same_content_is_not_reuploaded(self):
        api = FakeApi(remote=self.manifest)
        self.assertEqual(open_data.run_publish(self.bundle, 'r/x', api), 'unchanged')
        self.assertEqual(api.uploads, [])

    def test_refuses_to_move_remote_backwards(self):
        api = FakeApi(remote={'content_id': 'other', 'snapshot': {'through_height': 101}})
        with self.assertRaisesRegex(open_data.ExportError, 'newer'):
            open_data.run_publish(self.bundle, 'r/x', api)

    def test_tampered_file_is_refused(self):
        with (self.bundle / 'data' / 'daily' / 'daily.parquet').open('ab') as handle:
            handle.write(b'x')
        api = FakeApi()
        with self.assertRaisesRegex(open_data.ExportError, 'checksum'):
            open_data.run_publish(self.bundle, 'r/x', api)
        self.assertEqual(api.uploads, [])

    def test_stray_file_is_refused(self):
        (self.bundle / 'data' / 'secrets.env').write_text('x')
        with self.assertRaisesRegex(open_data.ExportError, 'unexpected'):
            open_data.run_publish(self.bundle, 'r/x', FakeApi())

    def test_missing_repo_is_a_clear_error_and_never_created(self):
        api = FakeApi(missing=True)
        with self.assertRaisesRegex(open_data.ExportError, 'does not exist'):
            open_data.run_publish(self.bundle, 'r/x', api)
        self.assertEqual(api.uploads, [])


if __name__ == '__main__':
    unittest.main()
