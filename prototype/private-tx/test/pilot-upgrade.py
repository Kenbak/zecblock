"""Run the actual pilot upgrader offline, with no privilege/systemd/network access."""
import contextlib
import hashlib
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


PILOT = Path(__file__).resolve().parents[1] / 'pilot'
SOURCE = Path(os.environ.get('PRIVATE_TX_UPGRADE_TEST_SOURCE', PILOT / 'upgrade.py')).read_text()
OLD, NEW, PUBLICATION = '1' * 40, '2' * 40, 'a' * 64
QUERY = 'zecblock-pir-pilot.service'
PUBLISH = 'zecblock-pir-pilot-publish.service'
TIMER = 'zecblock-pir-pilot-publish.timer'
UNITS = ['zecblock-pir-pilot.slice', QUERY, PUBLISH, TIMER]


class Sandbox:
    def __init__(self, *, states=None, timer_active=True, ready_status=200, ready_outcomes=None, on_idle=None):
        self.temp = tempfile.TemporaryDirectory(prefix='pir-upgrade-offline-')
        base = Path(self.temp.name).resolve()
        self.root, self.state, self.units = base / 'pilot', base / 'state', base / 'units'
        self.previous = self.root / 'releases' / OLD
        self.previous.mkdir(parents=True)
        (self.previous / 'provenance.json').write_text(json.dumps({'commit': OLD}))
        self.current = self.root / 'current'
        self.current.symlink_to(self.previous)
        self.publication = self.state / 'publications' / PUBLICATION
        self.publication.mkdir(parents=True)
        self.write_manifest(8)
        (self.state / 'current.json').write_text(json.dumps({'publicationId': PUBLICATION, 'directory': PUBLICATION}))
        self.units.mkdir()
        files = {f'prototype/private-tx/pilot/{name}': f'unit={name}\n'.encode() for name in UNITS}
        for name in UNITS:
            (self.units / name).write_bytes(files[f'prototype/private-tx/pilot/{name}'])
        files['prototype/pir-browser/target/release/zecblock-pir-fixture'] = b'offline test artifact'
        provenance = {'commit': NEW, 'files': {name: {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()} for name, data in files.items()}}
        files['provenance.json'] = json.dumps(provenance).encode()
        self.archive = base / 'release.tar.gz'
        with tarfile.open(self.archive, 'w:gz') as packed:
            for name, data in files.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                packed.addfile(member, io.BytesIO(data))
        self.sha = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.states = list(states or [('inactive', '0')])
        self.timer_active = timer_active
        self.ready_status, self.on_idle = ready_status, on_idle
        self.ready_outcomes = list(ready_outcomes or [])
        self.idle_reported = False
        self.clock = 0
        self.events = []

    def close(self):
        self.temp.cleanup()

    def write_manifest(self, count):
        (self.publication / 'manifest.json').write_text(json.dumps({'chunkCount': count}))

    def run_command(self, args, **options):
        if not args or args[0] != 'systemctl':
            raise AssertionError(f'No external command is permitted: {args}')
        call = tuple(args[1:])
        self.events.append((call, self.current.resolve().name))
        if call == ('is-active', '--quiet', TIMER):
            return subprocess.CompletedProcess(args, 0 if self.timer_active else 3)
        if call == ('is-active', '--quiet', PUBLISH):
            # Model the original bug: a running Type=oneshot is "activating",
            # for which is-active returns nonzero despite a nonzero MainPID.
            return subprocess.CompletedProcess(args, 0 if self.states[0][0] == 'active' else 3)
        if call == ('stop', TIMER):
            self.timer_active = False
        elif call == ('start', TIMER):
            self.timer_active = True
        elif call not in [('restart', QUERY), ('is-active', '--quiet', QUERY)]:
            raise AssertionError(f'Unexpected service operation: {args}')
        return subprocess.CompletedProcess(args, 0)

    def show_publisher(self, args, **options):
        if args != ['systemctl', 'show', PUBLISH, '--property=ActiveState,MainPID']:
            raise AssertionError(f'No external query is permitted: {args}')
        state, pid = self.states.pop(0) if len(self.states) > 1 else self.states[0]
        self.events.append((('publisher-state', state, pid), self.current.resolve().name))
        if state in ['inactive', 'failed'] and pid == '0' and not self.idle_reported:
            self.idle_reported = True
            if self.on_idle:
                self.on_idle(self)
        return f'ActiveState={state}\nMainPID={pid}\n'

    def sleep(self, seconds):
        self.clock += seconds

    def health(self, url, **options):
        if url != 'http://127.0.0.1:4319/health' or options.get('timeout') != 2:
            raise AssertionError(f'No network request is permitted: {url}')
        self.events.append((('readiness', str(self.ready_status)), self.current.resolve().name))
        if self.ready_outcomes:
            outcome = self.ready_outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return contextlib.nullcontext(types.SimpleNamespace(status=outcome))
        return contextlib.nullcontext(types.SimpleNamespace(status=self.ready_status))

    def execute(self):
        source = SOURCE
        replacements = {
            "Path('/opt/zecblock-pir-pilot')": f'Path({str(self.root)!r})',
            "Path('/var/lib/zecblock-pir-pilot')": f'Path({str(self.state)!r})',
            "Path('/etc/systemd/system')": f'Path({str(self.units)!r})',
        }
        for original, replacement in replacements.items():
            if source.count(original) != 1:
                raise AssertionError('Update the offline path boundary before running changed installer code: ' + original)
            source = source.replace(original, replacement)
        output = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(sys, 'argv', [str(PILOT / 'upgrade.py'), str(self.archive), self.sha, NEW, OLD]))
            stack.enter_context(mock.patch('os.geteuid', return_value=0))
            stack.enter_context(mock.patch('os.chown'))
            stack.enter_context(mock.patch('subprocess.run', side_effect=self.run_command))
            stack.enter_context(mock.patch('subprocess.check_output', side_effect=self.show_publisher))
            stack.enter_context(mock.patch('time.monotonic', side_effect=lambda: self.clock))
            stack.enter_context(mock.patch('time.sleep', side_effect=self.sleep))
            stack.enter_context(mock.patch('urllib.request.urlopen', side_effect=self.health))
            stack.enter_context(contextlib.redirect_stdout(output))
            exec(compile(source, str(PILOT / 'upgrade.py'), 'exec'), {'__name__': '__main__'})
        return json.loads(output.getvalue())

    def service_calls(self, operation):
        return [(call, target) for call, target in self.events if call[0] == operation]


class UpgradeGuards(unittest.TestCase):
    def sandbox(self, **options):
        sandbox = Sandbox(**options)
        self.addCleanup(sandbox.close)
        return sandbox

    def test_activating_and_deactivating_oneshot_finishes_before_switch(self):
        box = self.sandbox(states=[('activating', '321'), ('deactivating', '321'), ('inactive', '0')])
        result = box.execute()
        states = [(call, target) for call, target in box.events if call[0] == 'publisher-state']
        self.assertEqual(states, [(('publisher-state', state, pid), OLD) for state, pid in [('activating', '321'), ('deactivating', '321'), ('inactive', '0')]],
                         'A running oneshot must be observed until it is idle before switching the release.')
        self.assertEqual(box.clock, 2)
        idle_index = box.events.index((('publisher-state', 'inactive', '0'), OLD))
        self.assertGreater(box.events.index((('restart', QUERY), NEW)), idle_index)
        self.assertEqual(box.current.resolve().name, NEW)
        self.assertEqual(result['upgradedCommit'], NEW)
        self.assertTrue(box.timer_active)

    def test_publication_advanced_while_waiting_is_checked_again(self):
        box = self.sandbox(states=[('activating', '321'), ('inactive', '0')], on_idle=lambda item: item.write_manifest(65))
        with self.assertRaisesRegex(RuntimeError, 'batch admission'):
            box.execute()
        self.assertEqual(box.current.resolve().name, OLD)
        self.assertEqual(box.service_calls('restart'), [])
        self.assertTrue(box.timer_active)

    def test_publication_pointer_changed_while_waiting_is_checked_again(self):
        def invalidate_pointer(box):
            (box.state / 'current.json').write_text(json.dumps({'publicationId': PUBLICATION, 'directory': '../outside'}))
        box = self.sandbox(states=[('activating', '321'), ('inactive', '0')], on_idle=invalidate_pointer)
        with self.assertRaisesRegex(RuntimeError, 'publication pointer'):
            box.execute()
        self.assertEqual(box.current.resolve().name, OLD)
        self.assertEqual(box.service_calls('restart'), [])
        self.assertTrue(box.timer_active)

    def test_readiness_failure_rolls_back_previous_release_and_restores_timer(self):
        box = self.sandbox(ready_status=503)
        with self.assertRaisesRegex(RuntimeError, 'readiness failed'):
            box.execute()
        self.assertEqual(box.service_calls('restart'), [(('restart', QUERY), NEW), (('restart', QUERY), OLD)])
        self.assertEqual(box.current.resolve(), box.previous)
        self.assertTrue(box.previous.is_dir())
        self.assertFalse((box.root / '.upgrade-current').exists())
        self.assertTrue(box.timer_active)

    def test_listener_startup_race_waits_without_rolling_back_valid_release(self):
        box = self.sandbox(ready_outcomes=[ConnectionRefusedError('listener not open'), 503, 200])
        result = box.execute()
        self.assertEqual(box.service_calls('restart'), [(('restart', QUERY), NEW)])
        self.assertEqual(box.current.resolve().name, NEW)
        self.assertEqual(result['upgradedCommit'], NEW)
        self.assertEqual(len(box.service_calls('readiness')), 3)
        self.assertTrue(box.timer_active)

    def test_unit_drift_aborts_before_any_service_operation(self):
        box = self.sandbox()
        changed = box.units / QUERY
        changed.write_bytes(b'locally changed unit\n')
        with self.assertRaisesRegex(SystemExit, 'cannot change unit definitions'):
            box.execute()
        self.assertEqual(box.events, [])
        self.assertEqual(box.current.resolve(), box.previous)
        self.assertEqual(changed.read_bytes(), b'locally changed unit\n')

    def test_publisher_timeout_keeps_old_release_and_restores_timer(self):
        box = self.sandbox(states=[('activating', '321')])
        with self.assertRaisesRegex(RuntimeError, 'did not finish'):
            box.execute()
        self.assertEqual(box.current.resolve(), box.previous)
        self.assertEqual(box.service_calls('restart'), [])
        self.assertTrue(box.timer_active)

    def test_initially_inactive_timer_is_not_started_by_upgrade(self):
        box = self.sandbox(timer_active=False)
        result = box.execute()
        self.assertFalse(result['pilotTimerRestored'])
        self.assertFalse(box.timer_active)
        self.assertEqual(box.service_calls('start'), [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
