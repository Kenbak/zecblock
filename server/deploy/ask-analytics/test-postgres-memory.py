#!/usr/bin/env python3
"""Offline policy checks; opt-in real PG16 OOM/WAL/restart proof in a private unit.

ASK_MEMORY_TEST_SYSTEMD=1 ASK_LOGICAL_PG_BIN=/usr/lib/postgresql/16/bin \
  python3 server/deploy/ask-analytics/test-postgres-memory.py

Root only for native proof. The live PostgreSQL unit is never mutated. Every
write/signal is confined to a unique ask-pg-memory-proof-* unit and /run directory.
"""
import json
import os
import pathlib
import pwd
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
import uuid

HERE = pathlib.Path(__file__).resolve().parent


def unit_text(root, binaries):
    return f"""[Unit]
Description=Disposable Ask PostgreSQL memory proof
StartLimitIntervalSec=60
StartLimitBurst=3
[Service]
Type=simple
User=postgres
Group=postgres
ExecStart={binaries}/postgres -D {root}/data
Restart=on-failure
RestartSec=2
OOMPolicy=stop
KillMode=control-group
TimeoutStopSec=10
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths={root}
NoNewPrivileges=yes
MemoryAccounting=yes
MemoryHigh=128M
MemoryMax=192M
MemorySwapMax=0
"""


class PolicyTests(unittest.TestCase):
    def test_candidate_caps_leave_space_above_configured_shared_buffers(self):
        text = (HERE / 'postgres-memory.conf.example').read_text()
        for expected in ['MemoryAccounting=yes', 'MemoryHigh=24G', 'MemoryMax=32G', 'MemorySwapMax=1G']:
            self.assertIn(expected, text)
        self.assertNotIn('Restart=', text)

    def test_restart_is_separate_bounded_and_does_not_enable_replication(self):
        text = (HERE / 'postgres-restart.conf.example').read_text()
        for expected in ['StartLimitIntervalSec=300', 'StartLimitBurst=3', 'Restart=on-failure', 'RestartSec=5']:
            self.assertIn(expected, text)
        self.assertNotIn('ExecStart', text)
        self.assertNotIn('ALTER SUBSCRIPTION', text)

    def test_disposable_budget_is_small_and_has_no_tcp_or_real_unit_command(self):
        text = unit_text('/run/ask-pg-memory-proof-fixture', '/usr/lib/postgresql/16/bin')
        self.assertIn('MemoryMax=192M', text)
        self.assertIn('MemorySwapMax=0', text)
        self.assertIn('PrivateTmp=yes', text)
        self.assertNotIn('postgresql@16-main', text)


@unittest.skipUnless(os.environ.get('ASK_MEMORY_TEST_SYSTEMD') == '1', 'explicit isolated systemd proof opt-in')
class NativeProof(unittest.TestCase):
    def test_real_oom_wal_recovery_error_gate_and_start_limit(self):
        self.assertEqual(os.geteuid(), 0, 'native fixture needs root for its private systemd unit')
        binaries = pathlib.Path(os.environ.get('ASK_LOGICAL_PG_BIN', ''))
        self.assertTrue(binaries.is_absolute())
        clean_env = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'PGCONNECT_TIMEOUT': '2'}

        def run(args, timeout=15, check=True, input=None):
            return subprocess.run(list(map(str, args)), input=input, capture_output=True,
                                  text=True, timeout=timeout, check=check, env=clean_env)

        self.assertRegex(run([binaries / 'postgres', '--version']).stdout, r'^postgres \(PostgreSQL\) 16\.')
        self.assertTrue(pathlib.Path('/sys/fs/cgroup/cgroup.controllers').exists(), 'cgroup v2 required')
        token = uuid.uuid4().hex[:12]
        name = 'ask-pg-memory-proof-' + token + '.service'
        self.assertRegex(name, r'^ask-pg-memory-proof-[0-9a-f]{12}\.service$')
        root = pathlib.Path(tempfile.mkdtemp(prefix='ask-pg-memory-proof-', dir='/run'))
        self.assertTrue(str(root).startswith('/run/ask-pg-memory-proof-'))
        account = pwd.getpwnam('postgres')
        os.chown(root, account.pw_uid, account.pw_gid)
        root.chmod(0o700)
        socket = root / 'socket'
        socket.mkdir(mode=0o700)
        os.chown(socket, account.pw_uid, account.pw_gid)
        unit = pathlib.Path('/run/systemd/system') / name
        evidence = {'kind': 'disposable-postgres-memory-proof', 'unit': name}

        def control(*args, check=True):
            # This wrapper cannot target the live cluster or any pre-existing unit.
            return run(['/usr/bin/systemctl', *args, name], check=check)

        def properties():
            raw = control('show', '--property=ActiveState,SubState,Result,MainPID,NRestarts,ControlGroup').stdout
            return dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)

        def sql(statement, database='ask_analytics', check=True):
            return run(['/usr/sbin/runuser', '-u', 'postgres', '--', binaries / 'psql', '-X', '-w', '-At',
                        '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', '5432', '-U', 'postgres', '-d', database],
                       input=statement, check=check)

        def row(select):
            result = sql('SELECT row_to_json(proof) FROM (' + select + ') proof;')
            return json.loads(result.stdout.strip())

        def wait(predicate, label, seconds=20):
            until = time.monotonic() + seconds
            while time.monotonic() < until:
                try:
                    if predicate():
                        return
                except (subprocess.CalledProcessError, ValueError):
                    pass
                time.sleep(0.1)
            raise AssertionError('Disposable proof deadline: ' + label)

        try:
            run(['/usr/sbin/runuser', '-u', 'postgres', '--', binaries / 'initdb', '-D', root / 'data',
                 '-U', 'postgres', '-A', 'trust', '--no-locale', '--encoding=UTF8'])
            with (root / 'data/postgresql.conf').open('a') as config:
                config.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\n"
                             "shared_buffers='16MB'\nhuge_pages=off\nmax_connections=10\n"
                             "wal_level=logical\nmax_replication_slots=2\nmax_wal_senders=2\n"
                             "max_logical_replication_workers=2\nmax_worker_processes=4\n"
                             "max_parallel_workers=0\nwork_mem='1MB'\nmaintenance_work_mem='16MB'\n"
                             "autovacuum=off\nlog_min_messages=warning\nlog_line_prefix='%m [%p] %e '\n")
            unit.write_text(unit_text(root, binaries))
            run(['/usr/bin/systemd-analyze', 'verify', unit])
            run(['/usr/bin/systemctl', 'daemon-reload'])
            control('start')
            wait(lambda: sql('SELECT 1', database='postgres').returncode == 0, 'initial startup')
            before = properties()
            group = pathlib.Path('/sys/fs/cgroup' + before['ControlGroup'])
            self.assertEqual(int((group / 'memory.high').read_text()), 128 * 1024 ** 2)
            self.assertEqual(int((group / 'memory.max').read_text()), 192 * 1024 ** 2)
            self.assertEqual(int((group / 'memory.swap.max').read_text()), 0)
            self.assertIn('0::' + before['ControlGroup'], pathlib.Path('/proc/' + before['MainPID'] + '/cgroup').read_text())
            sql('CREATE ROLE analytics_owner NOLOGIN NOSUPERUSER; CREATE DATABASE ask_analytics OWNER analytics_owner;', database='postgres')
            # Apply the actual ledger/admission schemas, not mock copies.
            for migration in ['subscriber-core-v1.sql', 'admission-v1.sql', 'replication-recovery-v1.sql']:
                sql((HERE / migration).read_text())
            sql("""UPDATE analytics_meta.sync_state SET state='stale',source_id='00000000-0000-4000-8000-000000000001',source_system_identifier='1234567890123456789';
UPDATE analytics_meta.admission_control SET baseline_verified=true;
INSERT INTO analytics_feed_meta.signal VALUES(true,'00000000-0000-4000-8000-000000000001','1234567890123456789',2,clock_timestamp(),0,repeat('a',64),'0/0');
CREATE TABLE public.memory_proof(id integer PRIMARY KEY);
INSERT INTO public.memory_proof VALUES(1); CHECKPOINT; INSERT INTO public.memory_proof VALUES(2);""")
            sql('CREATE TABLE public.blocks(height bigint PRIMARY KEY,hash text); CREATE PUBLICATION memory_proof_publication FOR TABLE public.blocks;', database='postgres')
            sql("SELECT pg_create_logical_replication_slot('ask_public_core_v1','pgoutput');", database='postgres')
            sql("CREATE SUBSCRIPTION ask_public_core_v1 CONNECTION 'host=" + str(socket) + " dbname=postgres user=postgres' PUBLICATION memory_proof_publication WITH(copy_data=false,create_slot=false,enabled=false,slot_name='ask_public_core_v1',disable_on_error=true,run_as_owner=false);")
            subid = int(sql("SELECT oid FROM pg_subscription WHERE subname='ask_public_core_v1'").stdout)
            sql("DO $$BEGIN IF NOT EXISTS(SELECT FROM pg_replication_origin WHERE roname='pg_" + str(subid) + "') THEN PERFORM pg_replication_origin_create('pg_" + str(subid) + "'); END IF; END$$; SELECT pg_replication_origin_advance('pg_" + str(subid) + "','0/1'); SELECT pg_stat_reset_subscription_stats(" + str(subid) + ");")
            # A known pre-error epoch makes a later unexpected crash reset fail closed.
            sql("""INSERT INTO analytics_meta.replication_recovery_events(event_id,subid,stats_reset,apply_errors,sync_errors,source_generation,source_system_identifier,source_timeline,origin_name,event_at,evidence)
SELECT repeat('a',64),subid,stats_reset,apply_error_count,sync_error_count,'00000000-0000-4000-8000-000000000001','1234567890123456789',2,'pg_'||subid,clock_timestamp(),'{"fixture":"zero-error-before-conflict"}' FROM pg_stat_subscription_stats;
INSERT INTO analytics_meta.replication_recovery_ack SELECT subid,repeat('a',64) FROM pg_stat_subscription_stats;
INSERT INTO public.blocks(height,hash) VALUES(1,repeat('a',64));""")
            sql("INSERT INTO public.blocks VALUES(1,repeat('b',64));", database='postgres')
            sql('ALTER SUBSCRIPTION ask_public_core_v1 ENABLE;')
            gate_sql = "SELECT sub.subenabled AS enabled,sub.subdisableonerr AS disable_on_error,stats.apply_error_count AS errors,analytics_meta.replication_errors_acknowledged() AS acknowledged,(SELECT ready FROM analytics_public.coverage) AS ready FROM pg_subscription sub JOIN pg_stat_subscription_stats stats ON stats.subid=sub.oid"
            wait(lambda: (lambda gate: not gate['enabled'] and gate['errors'] > 0)(row(gate_sql)), 'real counted duplicate-key error')
            evidence['before_crash'] = row(gate_sql)
            self.assertFalse(evidence['before_crash']['acknowledged'])
            self.assertFalse(evidence['before_crash']['ready'])
            # Show the soft threshold can throttle this fixture until its bounded
            # statement timeout cancels it. This alone is not an OOM proof.
            soft = sql("SET statement_timeout='2s'; SELECT length(repeat('x',256*1024*1024));", check=False)
            self.assertNotEqual(soft.returncode, 0)
            self.assertIn('statement timeout', soft.stderr)
            self.assertEqual(properties()['MainPID'], before['MainPID'])
            evidence['soft_throttled_timeout'] = True
            # Avoid waiting under reclaim for the deliberate hard-cap test. Only
            # this disposable unit's High changes; Max remains 192MiB/swap zero.
            run(['/usr/bin/systemctl', 'set-property', '--runtime', name, 'MemoryHigh=192M'])
            self.assertEqual(int((group / 'memory.max').read_text()), 192 * 1024 ** 2)
            # Deliberate OOM is confined to this 192MiB private disposable unit.
            # Only a scalar length returns; neither the app compiler nor live DB is involved.
            sql("SET statement_timeout='8s'; SELECT length(repeat('x',256*1024*1024));", check=False)
            wait(lambda: properties()['MainPID'] not in ('0', before['MainPID']) and properties()['ActiveState'] == 'active', 'automatic OOM restart', seconds=25)
            wait(lambda: sql('SELECT 1').returncode == 0, 'WAL recovery')
            after = properties()
            # Cgroup may be re-created on restart. Journal unit metadata provides
            # OOM evidence even when the new cgroup counters start from zero.
            journal = run(['/usr/bin/journalctl', '-u', name, '--no-pager', '-o', 'cat']).stdout
            self.assertRegex(journal, r'(?i)(oom-kill|out of memory|oom killer)')
            evidence['oom_observed'] = True
            evidence['restarts_after_oom'] = int(after['NRestarts'])
            self.assertGreaterEqual(evidence['restarts_after_oom'], 1)
            self.assertEqual(sql('SELECT count(*) FROM public.memory_proof').stdout.strip(), '2')
            self.assertEqual(sql('SELECT count(*) FROM analytics_meta.replication_recovery_events').stdout.strip(), '1')
            gate = row(gate_sql)
            evidence['after_crash'] = gate
            self.assertFalse(gate['enabled'], 'restart never enables a subscription')
            self.assertTrue(gate['disable_on_error'])
            self.assertFalse(gate['acknowledged'], 'unknown errors or changed epoch remain closed')
            self.assertFalse(gate['ready'], 'closed admission persists through crash')
            # Exhaust ONLY this private service's startup budget. No blind reset.
            def limited():
                state = properties()
                if state['ActiveState'] != 'failed' or int(state['NRestarts']) < 3:
                    return False
                log = run(['/usr/bin/journalctl', '-u', name, '--no-pager', '-o', 'cat']).stdout
                return 'Start request repeated too quickly' in log

            kills = 0
            for _ in range(4):
                state = properties()
                if limited():
                    break
                pid = int(state['MainPID'])
                self.assertGreater(pid, 1)
                self.assertIn('0::' + state['ControlGroup'], pathlib.Path('/proc/' + str(pid) + '/cgroup').read_text())
                os.kill(pid, signal.SIGKILL)
                kills += 1
                wait(lambda: limited() or
                     (properties()['ActiveState'] == 'active' and properties()['MainPID'] not in ('0', str(pid))),
                     'bounded crash restart')
            wait(limited, 'startup rate limit')
            evidence['crash_loop_kills'] = kills
            evidence['start_limit_refused'] = True
            evidence['final_result'] = properties()['Result']
            self.assertLessEqual(int(properties()['NRestarts']), 3)
            stable = properties()
            time.sleep(3)
            self.assertEqual(properties()['MainPID'], stable['MainPID'])
            self.assertEqual(properties()['NRestarts'], stable['NRestarts'])
            evidence['wal_rows_durable'] = True
            evidence['passed'] = True
            print(json.dumps(evidence, sort_keys=True))
        finally:
            if unit.exists():
                # Even a partially failed start can leave processes; stop only
                # this generated/validated unit before removing its files.
                control('stop', check=False)
                control('reset-failed', check=False)
            unit.unlink(missing_ok=True)
            shutil.rmtree(pathlib.Path('/run/systemd/system.control') / (name + '.d'), ignore_errors=True)
            run(['/usr/bin/systemctl', 'daemon-reload'])
            shutil.rmtree(root)


if __name__ == '__main__':
    unittest.main()
