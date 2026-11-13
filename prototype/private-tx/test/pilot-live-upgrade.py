"""Offline execution of the live migration against temporary owned paths only."""
import contextlib
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import types
import unittest
from unittest import mock

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parents[1] / 'pilot/upgrade-live.py'
OLD, NEW, SEED, FRESH = '1' * 40, '2' * 40, 'a' * 64, 'b' * 64


class Fixture:
    def __init__(self, *, ready=True, source_stall=False, fail_start=None, advance_seed=False, timer=True):
        self.temp = tempfile.TemporaryDirectory(prefix='pir-live-upgrade-offline-')
        base = Path(self.temp.name).resolve()
        spec = importlib.util.spec_from_file_location('tested_live_upgrade', SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        m = self.module
        for name, child in [('ROOT', 'pilot'), ('OLD_STATE', 'old'), ('LIVE_STATE', 'live'),
                            ('SOURCE_STATE', 'source'), ('UNITS', 'units')]:
            setattr(m, name, base / child)
        m.CONFIG = base / 'config/live.json'
        self.previous = m.ROOT / 'releases' / OLD
        self.previous.mkdir(parents=True)
        (m.ROOT / 'current').symlink_to(self.previous)
        m.UNITS.mkdir()
        old_files = {'prototype/private-tx/pilot/' + name: ('owned ' + name + '\n').encode() for name in m.OLD_UNITS}
        old_files['prototype/private-tx/server.mjs'] = b'previous server\n'
        self.write_release(self.previous, OLD, old_files)
        for name in m.OLD_UNITS:
            (m.UNITS / name).write_bytes(old_files['prototype/private-tx/pilot/' + name])
        new_files = dict(old_files)
        new_files['prototype/private-tx/server.mjs'] = b'new server\n'
        for name in m.NEW_UNITS:
            new_files['prototype/private-tx/pilot/' + name] = ('new owned ' + name + '\n').encode()
        new_files['provenance.json'] = self.provenance(NEW, new_files)
        self.archive = base / 'release.tar.gz'
        with tarfile.open(self.archive, 'w:gz') as packed:
            for name, data in new_files.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                packed.addfile(member, io.BytesIO(data))
        self.sha = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.write_publication(m.OLD_STATE, SEED, 10, 11, 13)
        self.ready, self.source_stall, self.fail_start = ready, source_stall, fail_start
        self.advance_seed, self.timer = advance_seed, timer
        self.states = [('activating', '321'), ('deactivating', '321'), ('inactive', '0')]
        self.active = set()
        self.clock, self.source_delay = 0, 2
        self.events = []
        self.old_frozen = None

    @staticmethod
    def provenance(commit, files):
        return json.dumps({'commit': commit, 'files': {name: {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
                                                     for name, data in files.items()}}).encode()

    def write_release(self, directory, commit, files):
        for name, data in files.items():
            path = directory / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        (directory / 'provenance.json').write_bytes(self.provenance(commit, files))

    @staticmethod
    def tree(directory):
        return {str(path.relative_to(directory)): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in directory.rglob('*') if path.is_file()}

    def write_publication(self, state, identifier, floor, end, snapshot):
        directory = state / 'publications' / identifier
        directory.mkdir(parents=True, exist_ok=True)
        for name in ['database.bin', 'public.bin', 'source.json', 'expected.json']:
            (directory / name).write_bytes(('fixture ' + name).encode())
        manifest = {'schema': 'zecblock-private-tx-full-v1', 'publicationId': identifier, 'chunkCount': 3,
                    'databaseSha256': hashlib.sha256((directory / 'database.bin').read_bytes()).hexdigest(),
                    'publicSha256': hashlib.sha256((directory / 'public.bin').read_bytes()).hexdigest(),
                    'snapshot': {'height': snapshot, 'hash': f'{snapshot:064x}', 'publishedAt': datetime.now(timezone.utc).isoformat()},
                    'coverage': {'startHeight': floor, 'endHeight': end, 'complete': True,
                                 'blocks': [{'height': h, 'hash': f'{h:064x}'} for h in range(floor, end + 1)]}}
        (directory / 'manifest.json').write_text(json.dumps(manifest))
        (state / 'current.json').write_text(json.dumps({'publicationId': identifier, 'directory': identifier}))
        (state / 'publisher-status.json').write_text(json.dumps({'state': 'ready', 'publicationId': identifier}))

    def fields(self, args, **options):
        m = self.module
        if len(args) != 4 or args[:2] != ['systemctl', 'show'] or args[2] not in m.OLD_UNITS:
            raise AssertionError('No unrelated command permitted: ' + repr(args))
        name, properties = args[2:]
        if properties == '--property=FragmentPath,DropInPaths':
            return f'FragmentPath={m.UNITS / name}\nDropInPaths=\n'
        if name != m.PUBLISH or properties != '--property=ActiveState,MainPID':
            raise AssertionError('Unexpected metadata query')
        state, pid = self.states.pop(0) if len(self.states) > 1 else self.states[0]
        self.events.append(('publisher-state', state, pid))
        if state == 'inactive' and self.old_frozen is None:
            if self.advance_seed:
                self.write_publication(m.OLD_STATE, 'd' * 64, 20, 21, 23)
            self.old_frozen = self.tree(m.OLD_STATE)
        return f'ActiveState={state}\nMainPID={pid}\n'

    def command(self, args, **options):
        m = self.module
        if args[:2] == ['systemd-analyze', 'verify']:
            return subprocess.CompletedProcess(args, 0)
        if args[0] != 'systemctl':
            raise AssertionError('No external command permitted: ' + repr(args))
        operation, *names = args[1:]
        self.events.append((operation, *names))
        if operation == 'is-active':
            name = names[-1]
            active = self.timer if name == m.TIMER else name in self.active
            return subprocess.CompletedProcess(args, 0 if active else 3)
        if operation == 'daemon-reload':
            if names:
                raise AssertionError('Invalid manager reload')
        elif operation in ['start', 'stop', 'restart']:
            if len(names) != 1 or names[0] not in (*m.OLD_UNITS, *m.NEW_UNITS):
                raise AssertionError('No production service operation permitted')
            name = names[0]
            if name == m.TIMER:
                self.timer = operation == 'start'
            elif operation == 'stop':
                self.active.discard(name)
            elif operation == 'start':
                if self.fail_start == name:
                    raise subprocess.CalledProcessError(1, args)
                self.active.add(name)
                if name == m.NEW_UNITS[1]:
                    floor = json.loads(m.CONFIG.read_text())['startHeight']
                    self.write_publication(m.LIVE_STATE, FRESH, floor, floor + 4, floor + 4)
                    if not self.ready:
                        (m.LIVE_STATE / 'publisher-status.json').write_text('{"state":"unavailable"}')
            elif name == m.QUERY and (m.ROOT / 'current').resolve().name == NEW:
                if not (m.SOURCE_STATE / 'guard.json').is_file():
                    raise AssertionError('Query restarted before its source guard exists')
                self.events.append(('query-release', NEW))
            elif name == m.QUERY:
                self.events.append(('query-release', OLD))
        else:
            raise AssertionError('Unexpected service operation: ' + repr(args))
        return subprocess.CompletedProcess(args, 0)

    def sleep(self, delay):
        self.clock += delay
        m = self.module
        if m.NEW_UNITS[0] in self.active and not self.source_stall:
            self.source_delay -= 1
            if self.source_delay == 0:
                floor = json.loads(m.CONFIG.read_text())['startHeight']
                guard = {'schema': 'zecblock-private-source-guard-v1', 'state': 'ready',
                         'observedAt': datetime.now(timezone.utc).isoformat(), 'fingerprint': 'c' * 64,
                         'startHeight': floor, 'tip': {'height': floor + 4, 'hash': f'{floor + 4:064x}'},
                         'blocks': [{'height': h, 'hash': f'{h:064x}'} for h in range(floor, floor + 5)]}
                (m.SOURCE_STATE / 'guard.json').write_text(json.dumps(guard))
                (m.SOURCE_STATE / 'latest.json').write_text(json.dumps({'fingerprint': 'c' * 64}))
                self.events.append(('source-guard-ready',))

    def execute(self, verify_only=False):
        m = self.module
        arguments = [str(self.archive), self.sha, NEW, OLD] + (['--verify-only'] if verify_only else [])
        output = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch('os.geteuid', return_value=0))
            stack.enter_context(mock.patch('os.chown'))
            stack.enter_context(mock.patch('pwd.getpwnam', side_effect=lambda name: types.SimpleNamespace(pw_uid=108 if name == 'postgres' else 999)))
            stack.enter_context(mock.patch('grp.getgrnam', return_value=types.SimpleNamespace(gr_gid=999)))
            stack.enter_context(mock.patch('subprocess.check_output', side_effect=self.fields))
            stack.enter_context(mock.patch('subprocess.run', side_effect=self.command))
            stack.enter_context(mock.patch('time.monotonic', side_effect=lambda: self.clock))
            stack.enter_context(mock.patch('time.sleep', side_effect=self.sleep))
            stack.enter_context(mock.patch.object(m, 'probe_health', return_value={'publicationId': FRESH}))
            stack.enter_context(contextlib.redirect_stdout(output))
            m.main(arguments)
        return json.loads(output.getvalue())


class LiveMigration(unittest.TestCase):
    def fixture(self, **options):
        item = Fixture(**options)
        self.addCleanup(item.temp.cleanup)
        return item

    def test_verify_only_has_no_service_or_filesystem_changes(self):
        box = self.fixture()
        before = box.tree(Path(box.temp.name))
        result = box.execute(verify_only=True)
        self.assertTrue(result['verifiedOnly'])
        self.assertEqual(box.tree(Path(box.temp.name)), before)
        self.assertEqual(box.events, [])

    def test_success_freezes_seed_after_wait_and_leaves_old_state_untouched(self):
        box = self.fixture(advance_seed=True)
        result = box.execute()
        m = box.module
        self.assertEqual(result['startHeight'], 20)
        self.assertEqual(result['seedPublicationId'], 'd' * 64)
        self.assertEqual(result['livePublicationId'], FRESH)
        self.assertEqual(box.tree(m.OLD_STATE), box.old_frozen)
        self.assertEqual((m.ROOT / 'current').resolve().name, NEW)
        self.assertFalse(box.timer)
        self.assertEqual(box.active, set(m.NEW_UNITS))
        self.assertLess(box.events.index(('source-guard-ready',)), box.events.index(('query-release', NEW)))
        self.assertEqual((m.SOURCE_STATE.stat().st_mode & 0o777), 0o750)
        self.assertEqual((m.CONFIG.stat().st_mode & 0o777), 0o644)
        self.assertEqual((m.CONFIG.parent.stat().st_mode & 0o777), 0o755)
        self.assertEqual((m.UNITS / (m.QUERY + '.d')).stat().st_mode & 0o777, 0o755)

    def test_readiness_failure_restores_old_units_pointer_timer_and_preserves_diagnostics(self):
        box = self.fixture(ready=False)
        with self.assertRaisesRegex(RuntimeError, 'Live pilot readiness failed'):
            box.execute()
        m = box.module
        self.assertEqual((m.ROOT / 'current').resolve().name, OLD)
        self.assertEqual(box.tree(m.OLD_STATE), box.old_frozen)
        self.assertTrue(box.timer)
        self.assertFalse(box.active)
        for name in m.NEW_UNITS:
            self.assertFalse((m.UNITS / name).exists())
        self.assertFalse((m.UNITS / (m.QUERY + '.d')).exists())
        self.assertFalse(m.CONFIG.exists())
        self.assertTrue(m.LIVE_STATE.is_dir() and m.SOURCE_STATE.is_dir())
        self.assertIn(('query-release', OLD), box.events)

    def test_source_guard_must_be_ready_before_query_restart(self):
        box = self.fixture(source_stall=True, timer=False)
        with self.assertRaisesRegex(RuntimeError, 'Live source readiness failed'):
            box.execute()
        self.assertNotIn(('query-release', NEW), box.events)
        self.assertEqual((box.module.ROOT / 'current').resolve().name, OLD)
        self.assertFalse(box.timer, 'Rollback must not start a previously inactive timer.')

    def test_new_unit_start_failure_rolls_back_only_owned_changes(self):
        box = self.fixture()
        box.fail_start = box.module.NEW_UNITS[1]
        with self.assertRaises(subprocess.CalledProcessError):
            box.execute()
        self.assertEqual((box.module.ROOT / 'current').resolve().name, OLD)
        self.assertTrue(box.timer)
        self.assertFalse(box.active)
        self.assertEqual(box.tree(box.module.OLD_STATE), box.old_frozen)

    def test_unit_drift_and_archive_hash_fail_before_service_mutation(self):
        for fault in ['unit', 'archive']:
            with self.subTest(fault=fault):
                box = self.fixture()
                if fault == 'unit':
                    (box.module.UNITS / box.module.QUERY).write_text('operator change')
                else:
                    box.sha = '0' * 64
                before = box.tree(box.module.OLD_STATE)
                with self.assertRaisesRegex(RuntimeError, 'drift|hash mismatch'):
                    box.execute()
                self.assertEqual(box.events, [])
                self.assertEqual(box.tree(box.module.OLD_STATE), before)
                self.assertFalse(box.module.LIVE_STATE.exists())

    def test_existing_dropin_is_not_removed_or_overwritten(self):
        box = self.fixture()
        directory = box.module.UNITS / (box.module.QUERY + '.d')
        directory.mkdir()
        existing = directory / 'operator.conf'
        existing.write_text('operator override')
        with self.assertRaisesRegex(RuntimeError, 'drop-ins'):
            box.execute()
        self.assertEqual(existing.read_text(), 'operator override')
        self.assertEqual(box.events, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
