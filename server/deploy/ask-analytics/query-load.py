#!/usr/bin/env python3
"""Read-only metadata preflight; --run opts into fixed bounded worker cases.

No arbitrary SQL/URL/visitor inputs, credentials or query results are reported.
Run on the dedicated analytics host as root; never against the writer/source.
"""
import argparse
import datetime
import json
import os
import pathlib
import re
import selectors
import stat
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
SERVICE = 'postgresql@16-main.service'
WORKER = 'zecblock-ask-analytics.service'
CGROUP = '/system.slice/system-postgresql.slice/postgresql@16-main.service'
MEMORY_ROOT = pathlib.Path('/sys/fs/cgroup' + CGROUP)
GIB = 1024 ** 3
ENV_FILE = pathlib.Path('/etc/zecblock/ask-analytics.env')
# Same named set as analytics-availability.py: added, warming datasets must not
# fail the load gate, and a missing required one must.
REQUIRED_DATASETS = ('activity_daily', 'address_activity', 'addresses', 'block_timing', 'daily', 'flow_daily', 'issuance_daily', 'mining_daily', 'software_daily', 'supply_daily', 'swaps')
SQL = """BEGIN READ ONLY; SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='200ms';
SELECT json_build_object(
 'database',current_database(),'version',current_setting('server_version_num')::integer,
 'system_identifier',(SELECT system_identifier::text FROM pg_control_system()),
 'postmaster_started',pg_postmaster_start_time(),'in_recovery',pg_is_in_recovery(),
 'shared_buffers',pg_size_bytes(current_setting('shared_buffers')),
 'ready',(SELECT ready FROM analytics_public.coverage),
 'datasets_ready',(SELECT count(*)=__REQUIRED_COUNT__ FROM analytics_public.dataset_coverage WHERE ready IS TRUE AND dataset IN(__REQUIRED__)),
 'subscriptions_ok',(SELECT count(*)=1 AND bool_and(subname='ask_public_core_v1' AND subenabled AND subdisableonerr AND NOT subrunasowner) FROM pg_subscription),
 'apply_active',(SELECT count(*)=1 FROM pg_stat_subscription WHERE relid IS NULL AND pid IS NOT NULL),
 'errors_acknowledged',analytics_meta.replication_errors_acknowledged(),
 'reader_active',(SELECT count(*) FROM pg_stat_activity WHERE usename='ask_public_reader' AND state='active'),
 'pids',(SELECT json_agg(pid) FROM pg_stat_activity WHERE pid<>pg_backend_pid())); ROLLBACK;""".replace(
    '__REQUIRED_COUNT__', str(len(REQUIRED_DATASETS))).replace('__REQUIRED__', ','.join("'" + name + "'" for name in REQUIRED_DATASETS))


def command(arguments, timeout=8):
    return subprocess.run(arguments, check=True, capture_output=True, text=True,
                          timeout=timeout, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin',
                                               'PGCONNECT_TIMEOUT': '2'}).stdout.strip()


def pairs(raw):
    return dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)


def counter(raw):
    if not re.fullmatch(r'\d+', raw.strip()):
        raise ValueError('finite counter required')
    return int(raw)


def memory_limit(raw):
    return None if raw.strip() == 'max' else counter(raw)


def events(raw):
    result = dict((key, counter(value)) for key, value in
                  (line.split() for line in raw.splitlines()))
    if not {'high', 'max', 'oom', 'oom_kill'} <= result.keys():
        raise ValueError('complete memory event counters required')
    return {key: result[key] for key in ('high', 'max', 'oom', 'oom_kill')}


def pressure(raw):
    values = []
    for kind in ('some', 'full'):
        match = re.search(r'^' + kind + r' avg10=(\d+(?:\.\d+)?) ', raw, re.M)
        if not match or not 0 <= float(match[1]) <= 100:
            raise ValueError('complete PSI required')
        values.append(float(match[1]))
    return max(values)


def read_worker_key(path=ENV_FILE):
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError('root-only dedicated environment required')
    values = [line.split('=', 1)[1].strip() for line in path.read_text().splitlines()
              if line.startswith('ASK_ANALYTICS_SERVICE_KEY=')]
    if len(values) != 1:
        raise ValueError('one dedicated worker key required')
    value = values[0]
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
        value = value[1:-1]
    if not re.fullmatch(r'[A-Za-z0-9_./+=:@%-]{32,512}', value):
        raise ValueError('literal dedicated worker key required')
    return value


def snapshot(run=command, read=lambda path: pathlib.Path(path).read_text()):
    unit = pairs(run(['/usr/bin/systemctl', 'show', SERVICE,
                      '--property=ActiveState,MainPID,ControlGroup,NRestarts,OOMPolicy,KillMode,Restart,RestartUSec,StartLimitIntervalUSec,StartLimitBurst']))
    db = json.loads(next(line for line in run(['/usr/sbin/runuser', '-u', 'postgres', '--',
                        '/usr/bin/psql', '-X', '-w', '-At', '-v', 'ON_ERROR_STOP=1',
                        '-d', 'ask_analytics', '-c', SQL]).splitlines() if line.startswith('{')))
    # PIDs and environment values are used only to check boundaries, never emitted.
    pids = db.pop('pids')
    members = True
    for pid in pids:
        try:
            if ('0::' + CGROUP) not in read('/proc/' + str(pid) + '/cgroup').splitlines():
                members = False
        except FileNotFoundError:
            pass  # An already exited transient backend no longer allocates memory.
    worker = pairs(run(['/usr/bin/systemctl', 'show', WORKER, '--property=ActiveState,MainPID']))
    worker_pid = counter(worker['MainPID'])
    worker_env = dict(entry.split('=', 1) for entry in
                      read('/proc/' + str(worker_pid) + '/environ').split('\0') if '=' in entry)
    configured = worker_env.get('ASK_POSTGRES_CGROUP_PATH') == str(MEMORY_ROOT)
    configured = configured and worker_env.get('ASK_POSTGRES_PRESSURE_PERCENT', '85') == '85'
    configured = configured and worker_env.get('ASK_POSTGRES_PSI_AVG10_PERCENT', '5') == '5'
    meminfo = dict((key, int(value.split()[0]) * 1024) for key, value in
                   (line.split(':', 1) for line in read('/proc/meminfo').splitlines()))
    return {'unit_active': unit['ActiveState'] == 'active', 'main_pid': counter(unit['MainPID']),
            'cgroup_ok': unit['ControlGroup'] == CGROUP and members,
            'restart_policy': {key: unit[key] for key in ('OOMPolicy', 'KillMode', 'Restart', 'RestartUSec', 'StartLimitIntervalUSec', 'StartLimitBurst')},
            'restarts': counter(unit['NRestarts']), 'memory_current': counter(read(MEMORY_ROOT / 'memory.current')),
            'memory_high': memory_limit(read(MEMORY_ROOT / 'memory.high')),
            'memory_max': memory_limit(read(MEMORY_ROOT / 'memory.max')),
            'memory_swap_max': memory_limit(read(MEMORY_ROOT / 'memory.swap.max')),
            'memory_events': events(read(MEMORY_ROOT / 'memory.events')),
            'psi_avg10': pressure(read(MEMORY_ROOT / 'memory.pressure')),
            'host_available': meminfo['MemAvailable'], 'worker_guard_configured': configured,
            'worker_active': worker['ActiveState'] == 'active', 'db': db}


def rejection(sample, expected_identifier, baseline=None):
    db = sample['db']
    soft, hard, swap = (sample[key] for key in ('memory_high', 'memory_max', 'memory_swap_max'))
    finite = all(isinstance(value, int) for value in (soft, hard, swap))
    conditions = {
        'service_boundary': sample['unit_active'] and sample['worker_active'] and sample['cgroup_ok'],
        'finite_budget': finite and 0 < soft < hard <= 32 * GIB and swap <= GIB,
        'shared_buffer_headroom': isinstance(soft, int) and soft >= db['shared_buffers'] + 4 * GIB,
        'pressure_guard': sample['worker_guard_configured'],
        'restart_policy': sample['restart_policy'] == {'OOMPolicy': 'stop', 'KillMode': 'control-group',
            'Restart': 'on-failure', 'RestartUSec': '5s', 'StartLimitIntervalUSec': '5min', 'StartLimitBurst': '3'},
        'memory_headroom': isinstance(soft, int) and sample['memory_current'] < soft * 0.80,
        'host_headroom': sample['host_available'] >= 16 * GIB,
        'psi': sample['psi_avg10'] < 5,
        'database_identity': db['database'] == 'ask_analytics' and 160000 <= db['version'] < 170000
                             and db['system_identifier'] == expected_identifier and not db['in_recovery'],
        'data_ready': db['ready'] is True and db['datasets_ready'] is True
                      and db['subscriptions_ok'] is True and db['apply_active'] is True
                      and db['errors_acknowledged'] is True,
        'bounded_reader_slots': db['reader_active'] <= 2,
    }
    if baseline:
        conditions['stable_postmaster'] = (sample['main_pid'], sample['restarts'], db['postmaster_started']) == (
            baseline['main_pid'], baseline['restarts'], baseline['db']['postmaster_started'])
        conditions['no_new_pressure_events'] = sample['memory_events'] == baseline['memory_events']
    return [key for key, valid in conditions.items() if not valid]


def public_sample(sample):
    return {key: value for key, value in sample.items() if key not in ('main_pid', 'db')} | {
        'database': {key: value for key, value in sample['db'].items() if key != 'system_identifier'}}


def stop_child(child):
    if child.poll() is None:
        child.terminate()  # Worker wrapper aborts requests and cancels known tickets.
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=3)


def load(profile, node, expected_identifier, duration, emit=print):
    baseline = snapshot()
    denied = rejection(baseline, expected_identifier)
    if denied:
        return {'passed': False, 'refused': denied, 'preflight': public_sample(baseline)}
    env = {'PATH': '/usr/bin:/bin', 'ASK_ANALYTICS_URL': 'http://127.0.0.1:3015',
           'ASK_ANALYTICS_SERVICE_KEY': read_worker_key()}
    child = subprocess.Popen([str(node), str(HERE / 'query-load-worker.cjs'), profile], env=env,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    began = time.monotonic()
    peak = baseline['memory_current']
    records = []
    denied = []
    try:
        while child.poll() is None:
            if time.monotonic() - began > duration:
                denied = ['overall_deadline']
                break
            for key, _ in selector.select(timeout=0.2):
                line = key.fileobj.readline(8193)
                if len(line) > 8192:
                    raise ValueError('bounded child record required')
                if line:
                    record = json.loads(line)
                    # The child is fixed reviewed code, but keep a hard output allowlist.
                    allowed = {'kind', 'case', 'round', 'state', 'error', 'elapsedMs', 'queueMs',
                               'executionMs', 'rows', 'indexedThrough', 'httpStatus', 'networkCode',
                               'failureType', 'observedAt', 'concurrency', 'samples', 'succeeded',
                               'failed', 'endToEndP50Ms', 'endToEndP95Ms', 'executionP95Ms', 'meaning',
                               'profile', 'queuedSamples', 'queuedFailed', 'quickSamples', 'quickFailed',
                               'aborted', 'sample'}
                    if not isinstance(record, dict) or set(record) - allowed or len(records) >= 32:
                        raise ValueError('unexpected child output')
                    records.append(record)
            sample = snapshot()
            peak = max(peak, sample['memory_current'])
            denied = rejection(sample, expected_identifier, baseline)
            if denied:
                break
        if denied:
            stop_child(child)
        child.wait(timeout=10)
        # Drain the small bounded tail after exit; never emit raw stdout/stderr.
        tail = child.stdout.read(16385)
        if len(tail) > 16384:
            raise ValueError('bounded child tail required')
        summaries = records + [json.loads(line) for line in tail.splitlines() if line]
        summary = next((record for record in summaries if record.get('kind') == 'bounded-load-summary'), None)
        research = next((record for record in summaries if record.get('kind') == 'reviewed-research-readiness'), None)
        postflight = snapshot()
        denied += rejection(postflight, expected_identifier, baseline)
        passed = not denied and child.returncode == 0 and summary is not None and not summary['aborted']
        return {'passed': passed, 'refused': sorted(set(denied)), 'profile': profile,
                'elapsed_seconds': round(time.monotonic() - began, 3), 'peak_memory_bytes': peak,
                'worker_summary': summary, 'research_summary': research, 'postflight': public_sample(postflight),
                'meaning': 'Fixed private warm/cache-capable sample; not public capacity, cold performance or natural-language accuracy.'}
    finally:
        stop_child(child)
        selector.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--system-identifier', required=True)
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--profile', choices=('serial', 'overlap'), default='serial')
    parser.add_argument('--node', type=pathlib.Path)
    parser.add_argument('--duration', type=int, default=360)
    args = parser.parse_args()
    if os.geteuid() != 0 or not re.fullmatch(r'\d{10,25}', args.system_identifier):
        parser.error('root on the dedicated host and pinned target system identifier required')
    if not 30 <= args.duration <= 600 or (args.run and (not args.node or not args.node.is_absolute())):
        parser.error('bounded duration and explicit absolute Node runtime required')
    report = {'kind': 'bounded-postgres-load', 'observed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    try:
        if args.run:
            report.update(load(args.profile, args.node, args.system_identifier, args.duration))
        else:
            sample = snapshot()
            denied = rejection(sample, args.system_identifier)
            report.update(passed=not denied, refused=denied, preflight=public_sample(sample), workload_started=False)
    except Exception as error:
        report.update(passed=False, refused=['probe_failed:' + type(error).__name__])
    print(json.dumps(report, sort_keys=True))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
