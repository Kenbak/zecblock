#!/usr/bin/env python3
"""Native PG16 proof. Explicit opt-in; disposable private clusters, never real hosts.

ASK_LOGICAL_TEST_POSTGRES=1 ASK_LOGICAL_PG_BIN=/absolute/pg16/bin \
  python3 server/deploy/ask-analytics/test-feed-recovery-postgres.py
"""
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import time
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
GENERATION = '00000000-0000-4000-8000-000000000002'
SUBSCRIPTION = 'ask_public_core_v1'
ADMIN = 'postgres'
REAL_TIME = time.time
RELATIONS = ['public.blocks', 'analytics_feed_meta.signal']
BLOCKS = """CREATE TABLE public.blocks(height bigint PRIMARY KEY,hash text NOT NULL,
previous_block_hash text,timestamp bigint,transaction_count integer,size integer,
total_fees bigint,miner_address text)"""
SIGNAL = """CREATE SCHEMA analytics_feed_meta;
CREATE TABLE analytics_feed_meta.signal(singleton boolean PRIMARY KEY CHECK(singleton),
generation uuid NOT NULL,system_identifier text NOT NULL,timeline integer NOT NULL,
sampled_at timestamptz NOT NULL,tip_height bigint NOT NULL,tip_hash text NOT NULL,
before_lsn pg_lsn NOT NULL)"""


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def lsn(value):
    upper, lower = value.split('/')
    return (int(upper, 16) << 32) + int(lower, 16)


class Fixture:
    def __init__(self, binaries):
        self.binaries = binaries
        self.root = pathlib.Path(tempfile.mkdtemp(prefix='ask-feed-recovery-proof-'))
        self.root.chmod(0o700)
        self.env = {key: value for key, value in os.environ.items() if not key.startswith('PG')}
        self.env.update(PGCONNECT_TIMEOUT='2', PGAPPNAME='ask_recovery_fixture')
        self.clusters = {}
        for name, database in [('source', 'zcash_explorer_mainnet'), ('target', 'ask_analytics')]:
            socket = self.root / (name + '-socket')
            socket.mkdir(mode=0o700)
            self.clusters[name] = dict(data=self.root / name, socket=socket,
                                       database=database, log=self.root / (name + '.log'), active=False)

    def command(self, tool, arguments, timeout=20):
        return subprocess.run([str(self.binaries / tool), *map(str, arguments)],
                              check=True, capture_output=True, text=True, timeout=timeout,
                              env=self.env).stdout.strip()

    def sql(self, name, statement, database=None, user=ADMIN):
        cluster = self.clusters[name]
        result = subprocess.run([str(self.binaries / 'psql'), '-X', '-w', '-At',
                                 '-v', 'ON_ERROR_STOP=1', '-h', str(cluster['socket']),
                                 '-p', '5432', '-U', user, '-d', database or cluster['database']],
                                input=statement, capture_output=True, text=True,
                                timeout=15, env=self.env)
        if result.returncode:
            raise RuntimeError('Disposable ' + name + ' SQL failed: ' + result.stderr[-2000:])
        return result.stdout.strip()

    def row(self, name, select):
        return json.loads(self.sql(name, 'SELECT row_to_json(fixture_row) FROM (' + select + ') fixture_row;'))

    def wait(self, predicate, description, seconds=20):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            if predicate():
                return
            time.sleep(0.08)
        raise AssertionError('Disposable replication deadline: ' + description)

    def start(self, name):
        cluster = self.clusters[name]
        self.command('pg_ctl', ['-D', cluster['data'], '-l', cluster['log'], '-w', 'start'])
        cluster['active'] = True

    def stop(self, name):
        cluster = self.clusters[name]
        self.command('pg_ctl', ['-D', cluster['data'], '-m', 'fast', '-w', 'stop'])
        cluster['active'] = False

    def initialize(self):
        for name, cluster in self.clusters.items():
            self.command('initdb', ['-D', cluster['data'], '-U', ADMIN, '-A', 'trust',
                                    '--no-locale', '--encoding=UTF8'])
            with (cluster['data'] / 'postgresql.conf').open('a') as config:
                config.write("\nlisten_addresses=''\nunix_socket_directories=" + literal(cluster['socket']) + "\n"
                             "wal_level=logical\nmax_replication_slots=8\nmax_wal_senders=8\n"
                             "max_logical_replication_workers=4\nmax_worker_processes=8\n"
                             "max_sync_workers_per_subscription=1\nmax_slot_wal_keep_size='64MB'\n"
                             "shared_buffers='32MB'\nlog_min_messages=warning\nlog_timezone='UTC'\n"
                             "log_line_prefix='%m [%p] %e '\n"
                             "log_replication_commands=on\nlog_statement='all'\n"
                             "wal_receiver_status_interval='1s'\n")
            self.start(name)
            self.sql(name, 'CREATE DATABASE ' + cluster['database'], database='postgres')
        for name in self.clusters:
            self.sql(name, BLOCKS + ';' + SIGNAL + ';')
        self.sql('source', """CREATE ROLE ask_core_replicator LOGIN REPLICATION NOSUPERUSER;
GRANT SELECT ON public.blocks TO ask_core_replicator;
GRANT USAGE ON SCHEMA analytics_feed_meta TO ask_core_replicator;
GRANT SELECT ON analytics_feed_meta.signal TO ask_core_replicator;
CREATE PUBLICATION ask_public_core_v1 FOR TABLE public.blocks,analytics_feed_meta.signal;
INSERT INTO public.blocks VALUES(1,repeat('1',64),repeat('0',64),1700000001,0,100,7,'fixture');
INSERT INTO public.blocks VALUES(2,repeat('2',64),repeat('1',64),1700000002,0,100,8,'fixture');""")
        source_identity = self.row('source', "SELECT system_identifier::text AS id,(SELECT timeline_id FROM pg_control_checkpoint()) AS timeline FROM pg_control_system()")
        target_identity = self.row('target', 'SELECT system_identifier::text AS id FROM pg_control_system()')
        self.source_identity = source_identity
        self.sql('source', 'INSERT INTO analytics_feed_meta.signal SELECT true,' + literal(GENERATION) + ', ' + literal(source_identity['id']) + ',' + str(source_identity['timeline']) + ",clock_timestamp(),height,hash,pg_current_wal_lsn() FROM public.blocks ORDER BY height DESC LIMIT 1")
        self.sql('target', """CREATE ROLE analytics_owner NOLOGIN NOSUPERUSER;
CREATE ROLE ask_public_reader NOLOGIN NOSUPERUSER;
CREATE ROLE ask_public_view_owner NOLOGIN NOSUPERUSER;
ALTER TABLE public.blocks OWNER TO analytics_owner;
ALTER TABLE analytics_feed_meta.signal OWNER TO analytics_owner;
ALTER SCHEMA analytics_feed_meta OWNER TO analytics_owner;
CREATE SCHEMA analytics_meta;
CREATE TABLE analytics_meta.identity(singleton boolean PRIMARY KEY CHECK(singleton),schema_version integer NOT NULL,network text NOT NULL,store_kind text NOT NULL);
INSERT INTO analytics_meta.identity VALUES(true,1,'mainnet','logical_public_core');
CREATE TABLE analytics_meta.sync_state(singleton boolean PRIMARY KEY CHECK(singleton),state text NOT NULL,source_id uuid,source_system_identifier text,applied_lsn pg_lsn,covered_from bigint,covered_through bigint,tip_hash text,verified_at timestamptz,flow_completeness text NOT NULL DEFAULT 'unverified');
CREATE TABLE analytics_meta.admission_control(singleton boolean PRIMARY KEY CHECK(singleton),baseline_verified boolean NOT NULL,expected_timeline integer NOT NULL,baseline_through bigint,baseline_at timestamptz);
""" + 'INSERT INTO analytics_meta.sync_state VALUES(true,\'stale\',' + literal(GENERATION) + ',' + literal(source_identity['id']) + ",'0/0',1,2,repeat('2',64),NULL,'unverified');" +
                      'INSERT INTO analytics_meta.admission_control VALUES(true,true,' + str(source_identity['timeline']) + ',2,clock_timestamp());')
        self.sql('target', (HERE / 'replication-recovery-v1.sql').read_text())
        connection = 'host=' + str(self.clusters['source']['socket']) + ' port=5432 dbname=zcash_explorer_mainnet user=ask_core_replicator application_name=ask_recovery_fixture'
        self.sql('target', 'CREATE SUBSCRIPTION ask_public_core_v1 CONNECTION ' + literal(connection) + ' PUBLICATION ask_public_core_v1 WITH(copy_data=true,streaming=off,run_as_owner=false,disable_on_error=true)')
        self.wait(lambda: self.row('target', "SELECT count(*)=2 AND bool_and(srsubstate='r') AS ready FROM pg_subscription_rel")['ready'], 'both initial copies ready')
        checkpoint = self.pulse()
        self.wait(lambda: self.status()['origin_lsn'] is not None and lsn(self.status()['origin_lsn']) >= lsn(checkpoint), 'native signal checkpoint applied')
        self.sql('target', "UPDATE analytics_meta.sync_state SET applied_lsn=(SELECT remote_lsn FROM pg_replication_origin_status WHERE external_id='pg_'||(SELECT oid::text FROM pg_subscription WHERE subname='ask_public_core_v1'))")
        state_dir = self.root / 'state'
        state_dir.mkdir(mode=0o700)
        passfile = self.root / 'empty.pgpass'
        passfile.touch(mode=0o600)
        self.state_path = state_dir / 'recovery.json'
        self.config = dict(enabled=True, target_socket=str(self.clusters['target']['socket']), target_port=5432,
                           target_database='ask_analytics', target_user=ADMIN,
                           source_socket=str(self.clusters['source']['socket']), source_port=5432,
                           source_database='zcash_explorer_mainnet', source_user='ask_core_replicator',
                           source_passfile=str(passfile), psql_bin=str(self.binaries / 'psql'),
                           target_system_identifier=target_identity['id'], source_system_identifier=source_identity['id'],
                           source_generation=GENERATION, source_timeline=source_identity['timeline'],
                           subscription_oid=int(self.status()['oid']),
                           connection_hash=self.row('target', "SELECT md5(subconninfo) AS hash FROM pg_subscription WHERE subname='ask_public_core_v1'")['hash'],
                           expected_relations=RELATIONS,
                           log_path=str(self.clusters['target']['log']), state_dir=str(state_dir))

    def pulse(self):
        self.sql('source', "UPDATE analytics_feed_meta.signal SET sampled_at=clock_timestamp(),before_lsn=pg_current_wal_lsn(),tip_height=(SELECT max(height) FROM public.blocks),tip_hash=(SELECT hash FROM public.blocks ORDER BY height DESC LIMIT 1) WHERE singleton")
        return self.sql('source', 'SELECT before_lsn::text FROM analytics_feed_meta.signal WHERE singleton')

    def status(self):
        return self.row('target', """SELECT s.oid,s.subenabled AS enabled,s.subdisableonerr AS disable_on_error,
s.subrunasowner AS run_as_owner,s.subskiplsn::text AS skip_lsn,
(SELECT external_id FROM pg_replication_origin_status WHERE external_id='pg_'||s.oid::text) AS origin,
(SELECT remote_lsn::text FROM pg_replication_origin_status WHERE external_id='pg_'||s.oid::text) AS origin_lsn,
(SELECT apply_error_count::text FROM pg_stat_subscription_stats WHERE subid=s.oid) AS apply_errors,
(SELECT sync_error_count::text FROM pg_stat_subscription_stats WHERE subid=s.oid) AS sync_errors,
(SELECT count(*) FROM pg_stat_subscription WHERE subid=s.oid AND relid IS NULL AND pid IS NOT NULL) AS workers
FROM pg_subscription s WHERE subname='ask_public_core_v1'""")

    def rows(self):
        return json.loads(self.sql('target', 'SELECT coalesce(json_agg(row_to_json(b) ORDER BY height),\'[]\') FROM (SELECT height,total_fees::text AS fees FROM public.blocks) b'))

    def invoke(self, module):
        # Native logs independently catch resnapshot, slot recreation, skip and
        # origin-advance commands issued by the recovery entry point.
        offsets = {name: cluster['log'].stat().st_size for name, cluster in self.clusters.items()}
        # Only accelerate the configured 60-second backoff. Native probes, logs,
        # replication, durable state and administrative SQL remain real.
        advance = 61 if not self.status()['enabled'] else 0
        with patch.object(module.time, 'time', lambda: REAL_TIME() + advance):
            result = module.run_once(self.config, self.state_path)
        for name, cluster in self.clusters.items():
            with cluster['log'].open() as log:
                log.seek(offsets[name])
                emitted = log.read()
            assert not re.search(r'\b(?:CREATE_REPLICATION_SLOT|DROP_REPLICATION_SLOT)\b', emitted), emitted
            assert not re.search(r'\b(?:pg_replication_origin_advance|pg_replication_origin_session_setup|pg_stat_reset_subscription_stats)\s*\(', emitted), emitted
            assert not re.search(r'\b(?:CREATE|DROP)\s+SUBSCRIPTION\b|\bALTER\s+SUBSCRIPTION\s+\w+\s+SKIP\b', emitted), emitted
        return result

    def arm(self, module):
        # Synthetic fixture-operator admission, never performed by recovery.
        # Production readiness still requires its normal consistency checks.
        checkpoint = self.pulse()
        self.wait(lambda: self.status()['workers'] == 1 and lsn(self.status()['origin_lsn']) >= lsn(checkpoint), 'healthy apply checkpoint')
        self.sql('target', "UPDATE analytics_meta.sync_state SET state='ready',verified_at=clock_timestamp(),applied_lsn=(SELECT remote_lsn FROM pg_replication_origin_status WHERE external_id='pg_'||(SELECT oid::text FROM pg_subscription WHERE subname='ask_public_core_v1'))")
        result = self.invoke(module)
        assert result['action'] == 'healthy', result
        self.sql('target', "UPDATE analytics_meta.sync_state SET state='stale',verified_at=NULL")

    def assert_closed(self, module):
        before = self.status()
        rows = self.rows()
        for _ in range(2):
            result = self.invoke(module)
            assert result['action'] in ('paused', 'blocked'), result
            current = self.status()
            assert current['enabled'] is False, current
            assert current['origin'] == before['origin'], (before, current)
            assert current['origin_lsn'] == before['origin_lsn'], (before, current)
            assert current['skip_lsn'] == '0/0', current
            assert current['apply_errors'] == before['apply_errors'] and current['sync_errors'] == before['sync_errors']
            assert self.rows() == rows
            assert self.row('target', "SELECT state<>'ready' AS closed FROM analytics_meta.sync_state WHERE singleton")['closed']

    def publisher_outage(self):
        before = self.status()
        assert before['enabled'] and before['workers'] == 1, before
        offset = self.clusters['target']['log'].stat().st_size
        self.stop('source')
        self.wait(lambda: self.status()['enabled'] is False, 'publisher shutdown auto-disabled subscription')
        after = self.status()
        assert int(after['apply_errors']) == int(before['apply_errors']) + 1, (before, after)
        with self.clusters['target']['log'].open() as log:
            log.seek(offset)
            event = log.read()
        disabled = re.search(r'\[(\d+)\] 00000 LOG:\s+subscription "ask_public_core_v1" has been disabled because of an error', event)
        assert disabled, event
        pid = disabled[1]
        errors = re.findall(r'\[' + pid + r'\] ([0-9A-Z]{5}) (?:ERROR|FATAL|PANIC):\s*(.*)', event[:disabled.start()])
        if errors:
            assert len(errors) == 1 and errors[0] in [
                ('08006', 'could not send end-of-streaming message to primary: server closed the connection unexpectedly'),
                ('08006', 'could not send end-of-streaming message to primary: no COPY in progress'),
                ('08006', 'could not receive data from WAL stream: server closed the connection unexpectedly'),
                ('08P01', 'could not receive data from WAL stream: server closed the connection unexpectedly'),
            ], event
        else:
            # PG16 can finish the graceful publisher stream without a separate
            # ERROR. Require the actual same-worker end/disable pair, never a
            # synthetic disabled flag or an unrelated old transport event.
            messages = re.findall(r'\[' + pid + r'\] 00000 LOG:\s*(.*)', event[:disabled.start()])
            assert messages and messages[-1] == 'data stream from publisher has ended', event
        self.start('source')
        identity = self.row('source', "SELECT system_identifier::text AS id,(SELECT timeline_id FROM pg_control_checkpoint()) AS timeline FROM pg_control_system()")
        assert identity == self.source_identity
        return after

    def close(self):
        errors = []
        for name in ['target', 'source']:
            if self.clusters[name]['active']:
                try:
                    self.stop(name)
                except Exception as error:
                    errors.append(error)
        if not errors:
            shutil.rmtree(self.root)
        else:
            raise RuntimeError('Disposable cluster cleanup failed; files retained at ' + str(self.root)) from errors[0]


def main():
    assert os.environ.get('ASK_LOGICAL_TEST_POSTGRES') == '1', 'Explicit ASK_LOGICAL_TEST_POSTGRES=1 required'
    binaries = pathlib.Path(os.environ['ASK_LOGICAL_PG_BIN'])
    assert binaries.is_absolute(), 'Explicit absolute PG16 binary directory required'
    version = subprocess.run([str(binaries / 'postgres'), '--version'], check=True,
                             capture_output=True, text=True, timeout=5).stdout.strip()
    assert re.match(r'^postgres \(PostgreSQL\) 16\.', version), 'Native PG16 required; never use the existing PG14 installation'
    spec = importlib.util.spec_from_file_location('feed_recovery', HERE / 'feed-recovery.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    fixture = Fixture(binaries)
    try:
        fixture.initialize()
        module.validate(fixture.config)
        original = fixture.status()
        fixture.arm(module)
        disabled = fixture.publisher_outage()
        fixture.sql('source', "BEGIN;UPDATE public.blocks SET total_fees=42 WHERE height=1;DELETE FROM public.blocks WHERE height=2;INSERT INTO public.blocks VALUES(3,repeat('3',64),repeat('1',64),1700000003,0,100,9,'fixture');COMMIT")
        fixture.pulse()
        result = fixture.invoke(module)
        assert result['action'] == 'resumed', result
        fixture.wait(lambda: fixture.status()['enabled'] and fixture.rows() == [{'height': 1, 'fees': '42'}, {'height': 3, 'fees': '9'}], 'automatic resume and exact historical catch-up')
        recovered = fixture.status()
        assert recovered['oid'] == original['oid'] and recovered['origin'] == original['origin']
        assert lsn(recovered['origin_lsn']) > lsn(disabled['origin_lsn'])
        assert recovered['apply_errors'] == disabled['apply_errors']
        acknowledgement = fixture.row('target', "SELECT e.apply_errors::text AS errors,e.origin_name,e.evidence->>'origin_before' AS origin_before FROM analytics_meta.replication_recovery_ack a JOIN analytics_meta.replication_recovery_events e USING(subid,event_id)")
        assert acknowledgement == dict(errors=disabled['apply_errors'], origin_name=disabled['origin'], origin_before=disabled['origin_lsn'])
        assert fixture.row('target', 'SELECT analytics_meta.replication_errors_acknowledged() AS acknowledged')['acknowledged']
        assert recovered['disable_on_error'] and not recovered['run_as_owner'] and recovered['skip_lsn'] == '0/0'
        assert fixture.row('target', "SELECT state<>'ready' AS closed FROM analytics_meta.sync_state WHERE singleton")['closed']
        fixture.arm(module)
        # Restart only the disposable subscriber, retaining its native checkpoint.
        fixture.stop('target')
        fixture.sql('source', 'UPDATE public.blocks SET total_fees=43 WHERE height=1')
        fixture.start('target')
        fixture.wait(lambda: fixture.status()['workers'] == 1 or not fixture.status()['enabled'], 'subscriber worker restart')
        fixture.invoke(module)
        fixture.wait(lambda: fixture.rows()[0]['fees'] == '43', 'subscriber restart catch-up')
        assert fixture.status()['oid'] == original['oid'] and fixture.status()['origin'] == original['origin']
        fixture.arm(module)
        # An old approved transport event must not authorize an operator pause.
        fixture.sql('target', 'ALTER SUBSCRIPTION ask_public_core_v1 DISABLE')
        fixture.wait(lambda: fixture.status()['workers'] == 0, 'operator pause stopped worker')
        fixture.sql('source', 'UPDATE public.blocks SET total_fees=44 WHERE height=1')
        fixture.assert_closed(module)
        fixture.sql('target', 'ALTER SUBSCRIPTION ask_public_core_v1 ENABLE')  # Explicit fixture-operator repair.
        fixture.wait(lambda: fixture.rows()[0]['fees'] == '44', 'operator-authorized resume')
        fixture.arm(module)
        # Real native conflict: no error/event report is fabricated. Database
        # disablement commits before its final log write, so observe both.
        before_conflict = fixture.status()
        conflict_log = fixture.clusters['target']['log']
        conflict_offset = conflict_log.stat().st_size
        fixture.sql('target', "INSERT INTO public.blocks VALUES(4,repeat('a',64),repeat('3',64),1700000004,0,100,10,'target-only')")
        fixture.sql('source', "INSERT INTO public.blocks VALUES(4,repeat('4',64),repeat('3',64),1700000004,0,100,11,'source-only')")
        fixture.wait(lambda: not fixture.status()['enabled'], 'duplicate-key apply conflict')

        def native_conflict_logged():
            with conflict_log.open() as log:
                log.seek(conflict_offset)
                emitted = log.read()
            error = re.search(r'\[(\d+)\] 23505 ERROR:\s+duplicate key value violates unique constraint', emitted)
            return bool(error and re.search(r'\[' + error[1] + r'\] 00000 LOG:\s+subscription "ask_public_core_v1" has been disabled because of an error', emitted[error.end():]))

        try:
            fixture.wait(native_conflict_logged, 'native 23505 and same-worker disable evidence', seconds=5)
        except AssertionError as error:
            raise AssertionError('Native conflict evidence missing; disposable target log tail:\n' + conflict_log.read_text()[-8000:]) from error
        assert int(fixture.status()['apply_errors']) == int(before_conflict['apply_errors']) + 1
        fixture.assert_closed(module)
    finally:
        fixture.close()
    # A fresh fixture independently proves slot loss blocks an otherwise eligible
    # transport error, without repairing/recreating a slot between test cases.
    lost = Fixture(binaries)
    try:
        lost.initialize()
        module.validate(lost.config)
        lost.arm(module)
        lost.publisher_outage()
        lost.pulse()
        lost.sql('source', "SELECT pg_drop_replication_slot('ask_public_core_v1')")
        lost.assert_closed(module)
        assert lost.sql('source', "SELECT count(*) FROM pg_replication_slots WHERE slot_name='ask_public_core_v1'") == '0'
    finally:
        lost.close()
    print(json.dumps(dict(postgres=version, publisher_restart_recovered=True,
                          subscriber_restart_recovered=True, exact_rows_replayed=True,
                          operator_pause_preserved=True, native_conflict_closed=True,
                          lost_slot_closed=True, recovery_advanced_origin_or_recreated_slot=False,
                          original_errors_preserved=True, admission_opened_by_recovery=False)))


if __name__ == '__main__':
    main()
