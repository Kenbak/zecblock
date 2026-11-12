"""Actual helper execution with disposable paths and mocked systemd/HTTP only."""
import contextlib
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parents[1] / 'pilot/upgrade-live-release.py'
OLD, NEW, PAUSED, ADVANCED, FRESH = '1' * 40, '2' * 40, 'a' * 64, 'd' * 64, 'b' * 64


class Fixture:
    def __init__(self, *, ready=True, load=True, assets=True, advance=False, prune=False,
                 compact=True, source_blocked=False, compact_load=True,
                 timer_state='inactive', old_publisher_pid='0'):
        self.temp = tempfile.TemporaryDirectory(prefix='pir-live-release-offline-')
        base = Path(self.temp.name).resolve()
        spec = importlib.util.spec_from_file_location('tested_live_release_upgrade', SCRIPT)
        self.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.m)
        m, u = self.m, self.m.u
        for name, child in [('ROOT', 'pilot'), ('LIVE_STATE', 'live'), ('OLD_STATE', 'rolling'),
                            ('SOURCE_STATE', 'source'), ('UNITS', 'units')]:
            setattr(u, name, base / child)
        u.CONFIG = base / 'config/live.json'
        previous = u.ROOT / 'releases' / OLD
        previous.mkdir(parents=True)
        (u.ROOT / 'current').symlink_to(previous)
        u.UNITS.mkdir()
        files = {'prototype/private-tx/pilot/' + name: ('owned ' + name).encode() for name in m.OWNED}
        for name in (*m.ASSETS, m.NATIVE):
            files[name] = b'old runtime ' + name.encode()
        self.write_release(previous, OLD, files)
        for name in m.OWNED:
            (u.UNITS / name).write_bytes(files['prototype/private-tx/pilot/' + name])
        drop = u.UNITS / (m.QUERY + '.d')
        drop.mkdir()
        (drop / 'live.conf').write_text(u.DROP_TEXT)
        u.CONFIG.parent.mkdir()
        u.CONFIG.write_text(json.dumps({'schema': 'zecblock-private-live-config-v1', 'startHeight': 10,
                                       'maxBlocks': 128, 'maxRecords': 2048, 'intervalMs': 1000}))
        for name in (*m.ASSETS, m.NATIVE):
            files[name] = b'new runtime ' + name.encode()
        files['provenance.json'] = self.provenance(NEW, files)
        self.archive = base / 'release.tar.gz'
        with tarfile.open(self.archive, 'w:gz') as packed:
            for name, raw in files.items():
                member = tarfile.TarInfo(name)
                member.size = len(raw)
                packed.addfile(member, io.BytesIO(raw))
        self.sha = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.publication(PAUSED, chunks=64)
        u.OLD_STATE.mkdir()
        (u.OLD_STATE / 'untouched').write_text('rolling state sentinel')
        u.SOURCE_STATE.mkdir()
        guard = {'schema': 'zecblock-private-source-guard-v1', 'state': 'ready',
                 'captureState': 'ready',
                 'observedAt': datetime.now(timezone.utc).isoformat(), 'fingerprint': 'c' * 64,
                 'startHeight': 10, 'blocks': [{'height': h, 'hash': f'{h:064x}'} for h in range(10, 16)]}
        (u.SOURCE_STATE / 'guard.json').write_text(json.dumps(guard))
        (u.SOURCE_STATE / 'latest.json').write_text(json.dumps({'fingerprint': 'c' * 64}))
        self.ready, self.load, self.assets, self.advance, self.prune = ready, load, assets, advance, prune
        self.compact, self.source_blocked = compact, source_blocked
        self.compact_load = compact_load
        self.timer_state, self.old_publisher_pid = timer_state, old_publisher_pid
        self.events, self.clock, self.wait = [], 0, []
        self.publisher = True
        self.active_id = PAUSED
        self.frozen_id = PAUSED

    @staticmethod
    def provenance(commit, files):
        return json.dumps({'commit': commit, 'files': {name: {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
                                                     for name, raw in files.items()}}).encode()

    def write_release(self, path, commit, files):
        for name, raw in files.items():
            target = path / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
        (path / 'provenance.json').write_bytes(self.provenance(commit, files))

    @staticmethod
    def tree(directory):
        return {str(p.relative_to(directory)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in directory.rglob('*') if p.is_file()}

    def publication(self, identifier, *, chunks=3, compact=False):
        u = self.m.u
        directory = u.LIVE_STATE / 'publications' / identifier
        directory.mkdir(parents=True, exist_ok=True)
        for name in ('database.bin', 'public.bin', 'source.json', 'expected.json'):
            (directory / name).write_bytes(('immutable ' + name + identifier).encode())
        manifest = {'schema': 'zecblock-private-tx-full-v1', 'publicationId': identifier, 'chunkCount': chunks,
                    'databaseSha256': u.digest(directory / 'database.bin'), 'publicSha256': u.digest(directory / 'public.bin'),
                    'snapshot': {'height': 15, 'hash': f'{15:064x}'},
                    'coverage': {'startHeight': 10, 'endHeight': 15, 'complete': True,
                                 'blocks': [{'height': h, 'hash': f'{h:064x}'} for h in range(10, 16)]}}
        if compact:
            manifest.update(packing='compact-v1', coverRow=2047)
        (directory / 'manifest.json').write_text(json.dumps(manifest))
        (u.LIVE_STATE / 'current.json').write_text(json.dumps({'publicationId': identifier, 'directory': identifier}))
        (u.LIVE_STATE / 'publisher-status.json').write_text(json.dumps({'state': 'ready', 'publicationId': identifier}))
        self.active_id = identifier

    def fields(self, args, **options):
        m, u = self.m, self.m.u
        self.assert_command(args[0:2] == ['systemctl', 'show'])
        name, prop = args[2:]
        if name.startswith('zecblock-pir-pilot-loadcheck-'):
            return 'LoadState=not-found\n'
        self.assert_command(name in m.OWNED)
        if prop == '--property=FragmentPath,DropInPaths':
            drop = str(u.UNITS / (m.QUERY + '.d/live.conf')) if name == m.QUERY else ''
            return f'FragmentPath={u.UNITS / name}\nDropInPaths={drop}\n'
        if name == u.TIMER:
            self.assert_command(prop == '--property=ActiveState')
            return f'ActiveState={self.timer_state}\n'
        self.assert_command(prop == '--property=ActiveState,MainPID')
        if name == u.PUBLISH:
            return f'ActiveState=inactive\nMainPID={self.old_publisher_pid}\n'
        if name == m.PUBLISH and self.wait:
            state, pid = self.wait.pop(0)
            self.events.append(('publisher-state', state, pid))
            if pid == '0' and self.advance and (u.ROOT / 'current').resolve().name == OLD:
                self.publication(ADVANCED, chunks=64)
                self.frozen_id = ADVANCED
            return f'ActiveState={state}\nMainPID={pid}\n'
        active = self.publisher if name == m.PUBLISH else True
        return f'ActiveState={"active" if active else "inactive"}\nMainPID={123 if active else 0}\n'

    @staticmethod
    def assert_command(condition):
        if not condition:
            raise AssertionError('Unexpected or unrelated host operation')

    def command(self, args, **options):
        m, u = self.m, self.m.u
        if args[0] == 'systemd-run':
            self.assert_command(options['input'] == b'' and '--property=Slice=zecblock-pir-pilot.slice' in args
                                and '--property=User=zecblock-pir-pilot' in args
                                and '--property=MemoryMax=2147483648' in args
                                and '--property=SystemCallFilter=~connect' in args
                                and '--property=RuntimeMaxSec=60' in args)
            self.events.append(('native-load', Path(args[-1]).name))
            if not self.load or (Path(args[-1]).name == FRESH and not self.compact_load):
                raise subprocess.CalledProcessError(1, args)
            return subprocess.CompletedProcess(args, 0, stderr=b'Fixture evaluator ready\n')
        self.assert_command(args[0] == 'systemctl')
        action, name = args[1:]
        if name.startswith('zecblock-pir-pilot-loadcheck-'):
            self.assert_command(action == 'stop')
            return subprocess.CompletedProcess(args, 0)
        self.assert_command(name in (m.QUERY, m.PUBLISH) and action in ('start', 'stop', 'restart'))
        self.events.append((action, name))
        if name == m.PUBLISH:
            self.publisher = action == 'start'
            if action == 'stop':
                self.wait = [('deactivating', '123'), ('inactive', '0')]
            elif (u.ROOT / 'current').resolve().name == NEW:
                self.publication(FRESH, compact=self.compact)
                if self.source_blocked:
                    path = u.SOURCE_STATE / 'guard.json'
                    guard = json.loads(path.read_text()); guard['captureState'] = 'capacity-blocked'
                    path.write_text(json.dumps(guard))
                if self.prune:
                    old = u.LIVE_STATE / 'publications' / self.frozen_id
                    if old.exists():
                        shutil.rmtree(old)
                if not self.ready:
                    (u.LIVE_STATE / 'publisher-status.json').write_text('{"state":"capacity-blocked"}')
        elif action == 'restart':
            selected = (u.ROOT / 'current').resolve().name
            pointer = json.loads((u.LIVE_STATE / 'current.json').read_text())
            self.events.append(('query-release', selected, pointer['publicationId']))
            if selected == OLD and pointer['publicationId'] not in (PAUSED, ADVANCED):
                raise AssertionError('Legacy query must not restart with compact state')
        return subprocess.CompletedProcess(args, 0)

    def execute(self, verify_only=False):
        m, u = self.m, self.m.u
        arguments = [str(self.archive), self.sha, NEW, OLD] + (['--verify-only'] if verify_only else [])
        output = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch('os.geteuid', return_value=0))
            stack.enter_context(mock.patch('os.chown'))
            stack.enter_context(mock.patch('subprocess.check_output', side_effect=self.fields))
            stack.enter_context(mock.patch('subprocess.run', side_effect=self.command))
            stack.enter_context(mock.patch('time.monotonic', side_effect=lambda: self.clock))
            stack.enter_context(mock.patch('time.sleep', side_effect=lambda delay: setattr(self, 'clock', self.clock + delay)))
            stack.enter_context(mock.patch.object(u, 'probe_health', return_value={'publicationId': FRESH}))
            stack.enter_context(mock.patch.object(m, 'probe_asset', side_effect=None if self.assets else RuntimeError('asset mismatch')))
            stack.enter_context(contextlib.redirect_stdout(output))
            m.main(arguments)
        return json.loads(output.getvalue())


class LiveRelease(unittest.TestCase):
    def fixture(self, **options):
        box = Fixture(**options)
        self.addCleanup(box.temp.cleanup)
        return box

    def test_verify_only_does_not_mutate_files_or_services(self):
        box = self.fixture()
        before = box.tree(Path(box.temp.name))
        self.assertTrue(box.execute(True)['verifiedOnly'])
        self.assertEqual(box.tree(Path(box.temp.name)), before)
        self.assertEqual(box.events, [])

    def test_inactive_timer_without_main_pid_is_valid(self):
        box = self.fixture()
        self.assertEqual(box.fields(['systemctl', 'show', box.m.u.TIMER, '--property=ActiveState']),
                         'ActiveState=inactive\n')
        self.assertTrue(box.execute(True)['verifiedOnly'])
        self.assertEqual(box.events, [])

    def test_active_timer_or_old_publisher_pid_refuse_before_mutation(self):
        for options in ({'timer_state': 'active'}, {'old_publisher_pid': '321'}):
            with self.subTest(options=options):
                box = self.fixture(**options)
                with self.assertRaisesRegex(RuntimeError, 'must remain stopped'):
                    box.execute()
                self.assertEqual(box.events, [])

    def test_success_waits_and_validates_final_legacy_64_chunk_view_then_compact(self):
        box = self.fixture(advance=True)
        u = box.m.u
        preserved = {str(p): box.tree(p) for p in (u.OLD_STATE, u.SOURCE_STATE, u.UNITS, u.CONFIG.parent)}
        result = box.execute()
        self.assertEqual(result['pausedPublicationId'], ADVANCED)
        self.assertEqual(result['livePublicationId'], FRESH)
        self.assertEqual((u.ROOT / 'current').resolve().name, NEW)
        self.assertTrue(box.publisher)
        self.assertLess(box.events.index(('publisher-state', 'inactive', '0')), box.events.index(('native-load', ADVANCED)))
        for path, facts in preserved.items():
            self.assertEqual(box.tree(Path(path)), facts)

    def test_readiness_failure_restores_pruned_legacy_generation_pointer_and_publisher(self):
        box = self.fixture(ready=False, advance=True, prune=True)
        with self.assertRaisesRegex(RuntimeError, 'Live release readiness failed'):
            box.execute()
        self.assertEqual((box.m.u.ROOT / 'current').resolve().name, OLD)
        pointer, _, _ = box.m.u.publication(box.m.u.LIVE_STATE)
        self.assertEqual(pointer['publicationId'], ADVANCED)
        self.assertTrue(box.publisher)
        self.assertIn(('query-release', OLD, ADVANCED), box.events)

    def test_native_incompatibility_restores_publisher_without_switch(self):
        box = self.fixture(load=False)
        with self.assertRaises(subprocess.CalledProcessError):
            box.execute()
        self.assertEqual((box.m.u.ROOT / 'current').resolve().name, OLD)
        self.assertTrue(box.publisher)
        self.assertFalse(any(event[0] == 'query-release' for event in box.events))

    def test_asset_mismatch_rolls_back_even_when_health_and_publication_are_ready(self):
        box = self.fixture(assets=False)
        with self.assertRaisesRegex(RuntimeError, 'Live release readiness failed'):
            box.execute()
        self.assertIn(('query-release', OLD, PAUSED), box.events)

    def test_new_legacy_republication_does_not_satisfy_compact_readiness(self):
        box = self.fixture(compact=False)
        with self.assertRaisesRegex(RuntimeError, 'Live release readiness failed'):
            box.execute()
        self.assertIn(('query-release', OLD, PAUSED), box.events)

    def test_source_capacity_block_cannot_be_accepted_as_live_success(self):
        box = self.fixture(source_blocked=True)
        with self.assertRaisesRegex(RuntimeError, 'Live release readiness failed'):
            box.execute()
        self.assertIn(('query-release', OLD, PAUSED), box.events)

    def test_bad_compact_native_constructor_rolls_back_despite_healthy_http(self):
        box = self.fixture(compact_load=False, prune=True)
        with self.assertRaises(subprocess.CalledProcessError):
            box.execute()
        self.assertIn(('query-release', OLD, PAUSED), box.events)
        self.assertTrue(box.publisher)

    def test_unit_dropin_config_and_archive_drift_fail_before_service_changes(self):
        for kind in ('unit', 'dropin', 'config', 'archive'):
            with self.subTest(kind=kind):
                box = self.fixture()
                u = box.m.u
                if kind == 'unit':
                    (u.UNITS / box.m.SOURCE).write_text('operator change')
                elif kind == 'dropin':
                    (u.UNITS / (box.m.QUERY + '.d/live.conf')).write_bytes(u.DROP_TEXT.encode().replace(b'\n', b'\r\n'))
                elif kind == 'config':
                    value = json.loads(u.CONFIG.read_text()); value['intervalMs'] = 3000
                    u.CONFIG.write_text(json.dumps(value))
                else:
                    box.sha = '0' * 64
                with self.assertRaises(RuntimeError):
                    box.execute()
                self.assertEqual(box.events, [])

    def test_source_stale_rejects_preflight_without_mutation(self):
        box = self.fixture()
        path = box.m.u.SOURCE_STATE / 'guard.json'
        guard = json.loads(path.read_text()); guard['observedAt'] = '2026-01-01T00:00:00Z'
        path.write_text(json.dumps(guard))
        with self.assertRaisesRegex(RuntimeError, 'freshness'):
            box.execute()
        self.assertEqual(box.events, [])

    def test_already_reorged_legacy_view_is_not_admitted_as_rollback_ready(self):
        box = self.fixture()
        path = box.m.u.SOURCE_STATE / 'guard.json'
        guard = json.loads(path.read_text()); guard['blocks'][0]['hash'] = 'f' * 64
        path.write_text(json.dumps(guard))
        with self.assertRaisesRegex(RuntimeError, 'canonical membership'):
            box.execute()
        self.assertEqual(box.events, [])


if __name__ == '__main__':
    unittest.main()
