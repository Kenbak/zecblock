#!/usr/bin/env python3
import copy
import importlib.util
import pathlib
import unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('query_load', HERE / 'query-load.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
GIB = module.GIB
IDENTITY = '1234567890123456789'


def healthy():
    return {'unit_active': True, 'worker_active': True, 'cgroup_ok': True, 'main_pid': 42,
            'restarts': 0, 'memory_current': 17 * GIB, 'memory_high': 24 * GIB,
            'memory_max': 32 * GIB, 'memory_swap_max': GIB, 'host_available': 80 * GIB,
            'memory_events': dict(high=0, max=0, oom=0, oom_kill=0), 'psi_avg10': 0,
            'restart_policy': {'OOMPolicy': 'stop', 'KillMode': 'control-group', 'Restart': 'on-failure',
                               'RestartUSec': '5s', 'StartLimitIntervalUSec': '5min', 'StartLimitBurst': '3'},
            'worker_guard_configured': True,
            'db': {'database': 'ask_analytics', 'version': 160015, 'system_identifier': IDENTITY,
                   'in_recovery': False, 'shared_buffers': 16 * GIB, 'postmaster_started': 'pinned',
                   'ready': True, 'datasets_ready': True, 'subscriptions_ok': True, 'apply_active': True,
                   'errors_acknowledged': True, 'reader_active': 2}}


class Policy(unittest.TestCase):
    def test_healthy_passes_without_starting_a_workload(self):
        self.assertEqual(module.rejection(healthy(), IDENTITY), [])

    def test_each_boundary_fails_closed(self):
        for field, value in [('unit_active', False), ('worker_active', False), ('cgroup_ok', False),
                             ('memory_current', 20 * GIB), ('memory_max', 33 * GIB),
                             ('memory_swap_max', 2 * GIB), ('memory_high', 16 * GIB),
                             ('host_available', 15 * GIB), ('psi_avg10', 5),
                             ('worker_guard_configured', False)]:
            with self.subTest(field=field):
                sample = healthy()
                sample[field] = value
                self.assertTrue(module.rejection(sample, IDENTITY))
        no_restart = healthy()
        no_restart['restart_policy']['Restart'] = 'no'
        self.assertIn('restart_policy', module.rejection(no_restart, IDENTITY))
        for field, value in [('system_identifier', 'wrong'), ('database', 'writer'),
                             ('in_recovery', True), ('version', 170000), ('ready', False),
                             ('datasets_ready', False), ('datasets_ready', 6), ('subscriptions_ok', False), ('apply_active', False),
                             ('errors_acknowledged', False), ('reader_active', 3)]:
            with self.subTest(field=field):
                sample = healthy()
                sample['db'][field] = value
                self.assertTrue(module.rejection(sample, IDENTITY))

    def test_restart_events_or_postmaster_change_abort(self):
        base = healthy()
        for key in ['high', 'max', 'oom', 'oom_kill']:
            sample = copy.deepcopy(base)
            sample['memory_events'][key] = 1
            self.assertIn('no_new_pressure_events', module.rejection(sample, IDENTITY, base))
        sample = copy.deepcopy(base)
        sample['db']['postmaster_started'] = 'changed'
        self.assertIn('stable_postmaster', module.rejection(sample, IDENTITY, base))

    def test_no_key_or_child_is_loaded_when_preflight_refuses(self):
        sample = healthy()
        sample['memory_current'] = 24 * GIB
        with patch.object(module, 'snapshot', return_value=sample), \
                patch.object(module, 'read_worker_key', side_effect=AssertionError('must not load secret')), \
                patch.object(module.subprocess, 'Popen', side_effect=AssertionError('must not run load')):
            self.assertFalse(module.load('overlap', pathlib.Path('/node'), IDENTITY, 60)['passed'])

    def test_invalid_cgroup_data_fails_instead_of_infinity_or_missing_events(self):
        for value in ['max', 'infinity', '-1', 'NaN', '1e6']:
            with self.assertRaises(ValueError):
                module.counter(value)
        self.assertIsNone(module.memory_limit('max'))
        unbounded = healthy()
        unbounded.update(memory_high=None, memory_max=None, memory_swap_max=None)
        self.assertIn('finite_budget', module.rejection(unbounded, IDENTITY))
        with self.assertRaises(ValueError):
            module.events('high 0\nmax 0\n')
        with self.assertRaises(ValueError):
            module.pressure('some avg10=0.00 avg60=0 avg300=0 total=0')

    def test_sanitized_sample_omits_target_identity_and_pids(self):
        sample = module.public_sample(healthy())
        self.assertNotIn('main_pid', sample)
        self.assertNotIn('system_identifier', sample['database'])


class RequiredDatasets(unittest.TestCase):
    def test_named_set_matches_availability_alert(self):
        spec = importlib.util.spec_from_file_location('availability', pathlib.Path(__file__).with_name('analytics-availability.py'))
        alerts = importlib.util.module_from_spec(spec); spec.loader.exec_module(alerts)
        self.assertEqual(module.REQUIRED_DATASETS, alerts.REQUIRED_DATASETS)
        self.assertIn("dataset IN('activity_daily','address_activity','addresses','block_timing','daily','flow_daily','issuance_daily','mining_daily','software_daily','supply_daily','swaps')", module.SQL)
        self.assertIn('count(*)=11', module.SQL)


if __name__ == '__main__':
    unittest.main()
