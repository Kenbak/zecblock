"""Fake-host execution of the owned archive migration; no host systemd/DB calls."""
import contextlib
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import types
import unittest
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('live_fixture', HERE / 'pilot-live-release-upgrade.py')
base = importlib.util.module_from_spec(spec); spec.loader.exec_module(base)
OLD, NEW = base.OLD, base.NEW


class Fixture(base.Fixture):
    def __init__(self, *, failure=None, archive_prefix=''):
        super().__init__()
        self.original_module = self.m
        spec = importlib.util.spec_from_file_location('tested_archive_upgrade', HERE.parent / 'pilot/upgrade-archive.py')
        self.m = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.m)
        m, u = self.m, self.m.u
        for name in ('ROOT', 'LIVE_STATE', 'OLD_STATE', 'SOURCE_STATE', 'UNITS', 'CONFIG'):
            setattr(u, name, getattr(self.original_module.u, name))
        root = Path(self.temp.name).resolve()
        m.ARCHIVE_STATE, m.ARCHIVE_SOURCE, m.ARCHIVE_CONFIG = root / 'archive', root / 'archive-source', u.CONFIG.parent / 'archive.json'
        m.BOOTSTRAP_HEIGHT = 10
        m.CONFIG_VALUE = {'schema': 'zecblock-private-archive-config-v1', 'bootstrapHeight': 10, 'liveWindow': 16}
        directory = u.LIVE_STATE / 'publications' / base.PAUSED
        old = json.loads((directory / 'manifest.json').read_text())
        old['catalogue'] = [{'txid': f'{number:064x}'} for number in range(1, 394)]
        (directory / 'manifest.json').write_text(json.dumps(old))
        self.baseline = {entry['txid'] for entry in old['catalogue']}
        files = {str(path.relative_to(u.ROOT / 'releases' / OLD)): path.read_bytes()
                 for path in (u.ROOT / 'releases' / OLD).rglob('*') if path.is_file() and path.name != 'provenance.json'}
        for template in m.TEMPLATES.values():
            files['prototype/private-tx/pilot/' + template] = (HERE.parent / 'pilot' / template).read_bytes()
        for name in ('native-evaluator.mjs', 'collection.mjs', 'collection-server.mjs', 'state-files.mjs', 'pilot/archive-source.mjs', 'pilot/archive-watch.mjs', 'pilot/publish-archive.mjs'):
            files['prototype/private-tx/' + name] = b'closed runtime fixture\n'
        files['provenance.json'] = self.provenance(NEW, files)
        with tarfile.open(self.archive, 'w:gz') as packed:
            if archive_prefix:
                item = tarfile.TarInfo(archive_prefix); item.type = tarfile.DIRTYPE; packed.addfile(item)
                directories = {str(parent) for name in files for parent in Path(name).parents if str(parent) != '.'}
                for name in sorted(directories, key=lambda value: (len(Path(value).parts), value)):
                    item = tarfile.TarInfo(archive_prefix + name); item.type = tarfile.DIRTYPE; packed.addfile(item)
            for name, raw in files.items():
                item = tarfile.TarInfo(archive_prefix + name); item.size = len(raw); packed.addfile(item, io.BytesIO(raw))
        self.sha = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.failure = failure
        self.active = set(m.SERVICES)
        self.queues = {}
        self.events, self.clock = [], 0

    def fields(self, args, **options):
        m, u = self.m, self.m.u
        self.assert_command(args[:2] == ['systemctl', 'show'])
        name, prop = args[2:]
        if name.startswith('zecblock-pir-pilot-loadcheck-'):
            return 'LoadState=not-found\n'
        self.assert_command(name in m.v.OWNED)
        if prop == '--property=FragmentPath,DropInPaths':
            drop = str(u.UNITS / (m.QUERY + '.d/live.conf')) if name == m.QUERY else ''
            return f'FragmentPath={u.UNITS / name}\nDropInPaths={drop}\n'
        if name == u.TIMER:
            self.assert_command(prop == '--property=ActiveState')
            return 'ActiveState=inactive\n'
        if name == u.PUBLISH:
            return 'ActiveState=inactive\nMainPID=0\n'
        if self.queues.get(name):
            state, pid = self.queues[name].pop(0)
            self.events.append(('unit-state', name, state, pid))
        else:
            state, pid = ('active', '123') if name in self.active else ('inactive', '0')
        return f'ActiveState={state}\nMainPID={pid}\nUnitFileState=static\n'

    def make_collection(self):
        m = self.m
        segments, blocks = [], []
        database, public = bytes(16777216), bytes(45056)
        for index, (heights, txids) in enumerate([(list(range(10, 16)), sorted(self.baseline)), ([20, 21], [f'{500:064x}', f'{501:064x}'])]):
            identifier = f'{800 + index:064x}'
            directory = m.ARCHIVE_STATE / 'segments' / identifier
            directory.mkdir(parents=True, exist_ok=True)
            covered = [{'height': height, 'hash': f'{height:064x}', 'transactionCount': sum(1 for i in range(len(txids)) if heights[i % len(heights)] == height)} for height in heights]
            blocks += covered
            if self.failure == 'lost-record': txids = txids[1:]
            manifest = {'schema': 'zecblock-private-tx-full-v1', 'publicationId': identifier,
                        'recordCodec': 'legacy' if self.failure == 'codec' else 'json-context-zlib-v1',
                        'packing': 'compact-v1', 'coverRow': 2047, 'chunkCount': 1,
                        'coverage': {'blocks': covered}, 'snapshot': {'height': 18 if index == 0 else 21, 'hash': f'{18 if index == 0 else 21:064x}'},
                        'databaseSha256': hashlib.sha256(database).hexdigest(), 'publicSha256': hashlib.sha256(public).hexdigest(),
                        'catalogue': [{'txid': txid} for txid in txids]}
            for name, raw in [('database.bin', database), ('public.bin', public), ('manifest.json', json.dumps(manifest).encode())]:
                (directory / name).write_bytes(raw)
            segments.append({'publicationId': identifier, 'manifest': manifest})
        head = {'schema': 'zecblock-private-tx-collection-v1', 'network': 'mainnet', 'collectionId': 'b' * 64,
                'coverage': {'startHeight': 10, 'endHeight': 21, 'complete': False, 'blocks': blocks,
                             'ranges': [{'startHeight': 10, 'endHeight': 15}, {'startHeight': 20, 'endHeight': 21}]}, 'segments': segments}
        (m.ARCHIVE_STATE / 'collection.json').write_text(json.dumps(head)); (m.ARCHIVE_STATE / 'collection.json').chmod(0o640)
        (m.ARCHIVE_STATE / 'publisher-status.json').write_text(json.dumps({'state': 'ready', 'collectionId': head['collectionId']}))
        guard = {'schema': 'zecblock-private-source-guard-v1', 'state': 'ready', 'observedAt': datetime.now(timezone.utc).isoformat(),
                 'tip': {'height': 21, 'hash': f'{21:064x}'}, 'blocks': [*blocks, {'height': 18, 'hash': f'{18:064x}'}]}
        if self.failure == 'stale': guard['observedAt'] = '2026-01-01T00:00:00Z'
        if self.failure == 'canonical': guard['blocks'][0] = {**guard['blocks'][0], 'hash': 'f' * 64}
        if self.failure == 'anchor': guard['blocks'][-1]['hash'] = 'f' * 64
        (m.ARCHIVE_SOURCE / 'guard.json').write_text(json.dumps(guard))

    def command(self, args, **options):
        m, u = self.m, self.m.u
        if args[0] == 'systemd-run':
            self.events.append(('native', Path(args[-1]).name))
            if self.failure == 'native' and any('compact.service' in part for part in args):
                raise subprocess.CalledProcessError(1, args)
            return subprocess.CompletedProcess(args, 0, stderr=b'Fixture evaluator ready\n')
        if args[0] == '/usr/bin/node':
            return subprocess.CompletedProcess(args, 0, stdout=b'b' * 64)
        self.assert_command(args[0] == 'systemctl')
        action, *names = args[1:]
        if action == 'daemon-reload':
            self.assert_command(not names); self.events.append(('reload',)); return subprocess.CompletedProcess(args, 0)
        name, = names
        if name.startswith('zecblock-pir-pilot-loadcheck-'):
            self.assert_command(action == 'stop'); return subprocess.CompletedProcess(args, 0)
        self.assert_command(action in ('start', 'stop') and name in m.SERVICES)
        self.events.append((action, name))
        selected = (u.ROOT / 'current').resolve().name
        if action == 'stop':
            self.active.discard(name); self.queues[name] = [('deactivating', '123'), ('inactive', '0')]
        else:
            if self.failure == 'source-start' and selected == NEW and name == m.SOURCE:
                raise subprocess.CalledProcessError(1, args)
            self.active.add(name)
            if selected == NEW and name == m.PUBLISH:
                self.make_collection()
                self.events.append(('collection-ready',))
            if selected == NEW and name == m.QUERY:
                self.assert_command((m.ARCHIVE_STATE / 'collection.json').is_file())
                self.events.append(('query-release', NEW))
            if selected == OLD and name == m.QUERY:
                self.events.append(('query-release', OLD))
            if selected == OLD and name == m.SOURCE:
                path = u.SOURCE_STATE / 'guard.json'
                guard = json.loads(path.read_text()); guard['observedAt'] = datetime.now(timezone.utc).isoformat(); path.write_text(json.dumps(guard))
        return subprocess.CompletedProcess(args, 0)

    def health(self):
        selected = (self.m.u.ROOT / 'current').resolve().name
        return {'publicationId': ('c' if self.failure == 'query' else 'b') * 64 if selected == NEW else base.PAUSED}

    def execute(self, verify_only=False):
        m = self.m
        arguments = [str(self.archive), self.sha, NEW, OLD] + (['--verify-only'] if verify_only else [])
        output = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch('os.geteuid', return_value=0)); stack.enter_context(mock.patch('os.chown'))
            stack.enter_context(mock.patch('pwd.getpwnam', side_effect=lambda name: types.SimpleNamespace(pw_uid=333 if name == 'postgres' else 444)))
            stack.enter_context(mock.patch('grp.getgrnam', return_value=types.SimpleNamespace(gr_gid=444)))
            stack.enter_context(mock.patch('subprocess.check_output', side_effect=self.fields))
            stack.enter_context(mock.patch('subprocess.run', side_effect=self.command))
            stack.enter_context(mock.patch('time.monotonic', side_effect=lambda: self.clock))
            stack.enter_context(mock.patch('time.sleep', side_effect=lambda delay: setattr(self, 'clock', self.clock + delay)))
            stack.enter_context(mock.patch.object(m.u, 'probe_health', side_effect=self.health))
            stack.enter_context(mock.patch.object(m.v, 'probe_asset'))
            stack.enter_context(contextlib.redirect_stdout(output))
            m.main(arguments)
        return json.loads(output.getvalue())


class ArchiveUpgrade(unittest.TestCase):
    def fixture(self, **options):
        item = Fixture(**options); self.addCleanup(item.temp.cleanup); return item

    def test_verify_only_has_no_filesystem_or_service_changes(self):
        box = self.fixture(); before = box.tree(Path(box.temp.name))
        self.assertTrue(box.execute(True)['verifiedOnly'])
        self.assertEqual(box.tree(Path(box.temp.name)), before); self.assertEqual(box.events, [])

    def test_dot_prefixed_real_bundle_members_support_preflight_and_migration(self):
        for verify_only in (True, False):
            with self.subTest(verify_only=verify_only):
                box = self.fixture(archive_prefix='./')
                with tarfile.open(box.archive) as packed:
                    members = packed.getmembers()
                    self.assertTrue(all(member.name.startswith('./') or member.name in ('.', './') for member in members))
                    self.assertTrue(all(member.name.startswith('./') for member in members if member.isfile()))
                before = box.tree(Path(box.temp.name))
                result = box.execute(verify_only)
                if verify_only:
                    self.assertTrue(result['verifiedOnly'])
                    self.assertEqual(box.tree(Path(box.temp.name)), before); self.assertEqual(box.events, [])
                else:
                    self.assertEqual(result['originalRecordsRetained'], 393)
                    self.assertEqual((box.m.u.ROOT / 'current').resolve().name, NEW)

    def test_success_retains_393_with_explicit_gap_and_preserves_every_old_file(self):
        box = self.fixture(); m = box.m
        frozen = {str(path): box.tree(path) for path in (m.u.LIVE_STATE, m.u.OLD_STATE, m.u.SOURCE_STATE)}
        config = m.u.CONFIG.read_bytes(); result = box.execute()
        self.assertEqual(result['originalRecordsRetained'], 393); self.assertFalse(result['coverage']['complete'])
        self.assertEqual((m.u.ROOT / 'current').resolve().name, NEW)
        self.assertLess(box.events.index(('collection-ready',)), box.events.index(('query-release', NEW)))
        first_native = next(index for index, event in enumerate(box.events) if event[0] == 'native')
        for name in m.SERVICES:
            self.assertLess(box.events.index(('unit-state', name, 'inactive', '0')), first_native)
        self.assertEqual(box.active, set(m.SERVICES)); self.assertEqual(m.u.CONFIG.read_bytes(), config)
        for path, contents in frozen.items(): self.assertEqual(box.tree(Path(path)), contents)
        self.assertEqual(m.ARCHIVE_STATE.stat().st_mode & 0o777, 0o750)
        self.assertEqual(m.ARCHIVE_SOURCE.stat().st_mode & 0o777, 0o750)
        self.assertEqual((m.ARCHIVE_STATE / 'capture-request.json').stat().st_mode & 0o777, 0o640)
        self.assertEqual(json.loads(m.ARCHIVE_CONFIG.read_text()), m.CONFIG_VALUE)

    def test_missing_old_records_wrong_codec_or_stale_guard_roll_back_before_query_start(self):
        for failure in ('lost-record', 'codec', 'stale', 'canonical', 'anchor'):
            with self.subTest(failure=failure):
                box = self.fixture(failure=failure); before = box.tree(box.m.u.LIVE_STATE)
                with self.assertRaisesRegex(RuntimeError, 'readiness failed'):
                    box.execute()
                m = box.m
                self.assertNotIn(('query-release', NEW), box.events)
                self.assertIn(('query-release', OLD), box.events)
                self.assertEqual((m.u.ROOT / 'current').resolve().name, OLD)
                self.assertEqual(box.tree(m.u.LIVE_STATE), before)
                self.assertFalse(m.ARCHIVE_CONFIG.exists()); self.assertTrue(m.ARCHIVE_STATE.exists())
                self.assertTrue(json.loads((m.u.ROOT / ('archive-upgrade-' + NEW[:12]) / 'rollback.json').read_text())['verified'])
                for name in m.SERVICES: self.assertFalse((m.u.UNITS / (name + '.d/zz-archive.conf')).exists())

    def test_native_or_new_source_start_failure_recovers_only_old_pilot_services(self):
        for failure in ('native', 'source-start'):
            with self.subTest(failure=failure):
                box = self.fixture(failure=failure)
                with self.assertRaises(subprocess.CalledProcessError): box.execute()
                self.assertIn(('query-release', OLD), box.events)
                self.assertNotIn(('query-release', NEW), box.events)
                self.assertEqual(box.active, set(box.m.SERVICES))

    def test_query_health_failure_rolls_back_after_new_query_started(self):
        box = self.fixture(failure='query')
        with self.assertRaisesRegex(RuntimeError, 'Archive query readiness failed'): box.execute()
        self.assertIn(('query-release', NEW), box.events)
        self.assertIn(('query-release', OLD), box.events)
        receipt = box.m.u.ROOT / ('archive-upgrade-' + NEW[:12]) / 'rollback.json'
        self.assertTrue(json.loads(receipt.read_text())['verified'])

    def test_old_unit_drift_and_archive_hash_fail_before_any_service_or_release_change(self):
        for failure in ('unit', 'hash'):
            with self.subTest(failure=failure):
                box = self.fixture()
                if failure == 'unit': (box.m.u.UNITS / box.m.SOURCE).write_text('operator override')
                else: box.sha = '0' * 64
                with self.assertRaises(RuntimeError): box.execute()
                self.assertEqual(box.events, []); self.assertFalse((box.m.u.ROOT / 'releases' / NEW).exists())


if __name__ == '__main__':
    unittest.main()
