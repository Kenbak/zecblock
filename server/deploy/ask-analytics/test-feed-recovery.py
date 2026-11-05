#!/usr/bin/python3
"""Offline policy, bounded log-evidence and administrative-race regressions.
No PostgreSQL process, network, service, source feed or production file is touched.
"""
import copy
import datetime
import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock

SPEC=importlib.util.spec_from_file_location('feed_recovery',pathlib.Path(__file__).with_name('feed-recovery.py'))
recovery=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recovery)
NOW=datetime.datetime(2026,10,16,tzinfo=datetime.timezone.utc).timestamp()
RESET='2026-10-15T00:00:00+00:00'
GENERATION='12345678-1234-5678-1234-567812345678'


def fixtures(root):
    config={'enabled':True,'target_system_identifier':'1234567890123456789','source_system_identifier':'9876543210987654321','source_generation':GENERATION,'source_timeline':1,'subscription_oid':1234,'connection_hash':'a'*32,'expected_relations':['public.blocks','public.transactions','analytics_feed_meta.signal'],'target_socket':str(root/'target'),'source_socket':str(root/'source'),'source_passfile':str(root/'source.pass'),'log_path':str(root/'postgres.log'),'state_dir':str(root/'state'),'target_port':5432,'source_port':15432,'target_database':'ask_analytics','source_database':'zcash_explorer_mainnet','target_user':'postgres','source_user':'ask_core_replicator'}
    target={'observed_at':recovery.iso(NOW),'database':'ask_analytics','primary':True,'target_system_identifier':config['target_system_identifier'],'store':'logical_public_core','baseline':True,'state':'stale','source_generation':GENERATION,'source_system_identifier':config['source_system_identifier'],'source_timeline':1,'subscriptions':1,'subscription':{'oid':1234,'enabled':False,'name':recovery.NAME,'owner':'postgres','slot':recovery.NAME,'publications':[recovery.NAME],'disable_on_error':True,'run_as_owner':False,'skip_lsn':'0/0','connection_hash':config['connection_hash']},'relations':[{'name':name,'state':'r'} for name in config['expected_relations']],'stats':{'apply_errors':1,'sync_errors':0,'stats_reset':RESET},'workers':[],'origin':{'name':'pg_1234','lsn':'1/10'},'ack':None,'errors_acknowledged':False}
    source={'observed_at':recovery.iso(NOW),'database':'zcash_explorer_mainnet','primary':True,'user':'ask_core_replicator','login':True,'live_system_identifier':config['source_system_identifier'],'live_timeline':1,'signal':{'generation':GENERATION,'system_identifier':config['source_system_identifier'],'timeline':1,'sampled_at':recovery.iso(NOW-10)},'slot':{'name':recovery.NAME,'plugin':'pgoutput','type':'logical','database':'zcash_explorer_mainnet','status':'reserved','active':False,'restart_lsn':'1/1','confirmed_flush_lsn':'1/10','retained_bytes':1024}}
    state={'armed':True,'error_after':NOW-300,'stats_reset':RESET,'healthy_worker_pid':987,'attempts':[],'healthy_origin':recovery.healthy_origin(config,target)}
    event={'event_at':recovery.iso(NOW-120),'pid':987,'sqlstate':'08006','kind':'end_stream_disconnect','event_id':'b'*64}
    return config,target,source,state,event


def changed(value,path,replacement):
    result=copy.deepcopy(value)
    parent=result
    for key in path[:-1]:parent=parent[key]
    parent[path[-1]]=replacement
    return result


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(prefix='ask-feed-policy-')
        self.addCleanup(self.temporary.cleanup)
        self.root=pathlib.Path(self.temporary.name)
        self.config,self.target,self.source,self.state,self.event=fixtures(self.root)
        self.path=self.root/'state'/'state.json'

    def decision(self,**changes):
        values={'config':self.config,'target':self.target,'source':self.source,'event':self.event,'state':self.state,'now':NOW}
        values.update(changes)
        return recovery.decide(**values)

    def healthy(self):
        target=copy.deepcopy(self.target)
        target.update(state='ready',errors_acknowledged=True,workers=[{'pid':987,'relid':None}])
        target['subscription']['enabled']=True
        target['stats']['apply_errors']=0
        return target

    def log_line(self,at,severity,message,pid=987,code='00000'):
        at=datetime.datetime.fromtimestamp(at,datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%S.%f UTC')
        return f'{at} [{pid}] {code} {severity}: {message}\n'

    def logs(self,message=None,code='08006',detail=None,severity='ERROR'):
        if message is None:
            message=next((message for (state,message) in recovery.TRANSPORT if state=='08006' and 'no COPY' in message),next(message for (state,message) in recovery.TRANSPORT if state=='08006'))
        lines=[self.log_line(NOW-301,'LOG','previous healthy checkpoint'),self.log_line(NOW-121,severity,message,code=code)]
        if detail is not None:lines.append(self.log_line(NOW-121,'DETAIL',detail))
        lines.append(self.log_line(NOW-120,'LOG',f'subscription "{recovery.NAME}" has been disabled because of an error'))
        return lines

    def write_log(self,lines,suffix=''):
        path=pathlib.Path(self.config['log_path']+suffix)
        path.write_text(''.join(lines))
        return path

    def run_mocked(self,target=None,read_event=None,mutate=None):
        recovery.save_state(self.path,self.state)
        target=target or [self.target,copy.deepcopy(self.target)]
        with mock.patch.object(recovery.time,'time',return_value=NOW),mock.patch.object(recovery,'probe_target',side_effect=target),mock.patch.object(recovery,'probe_source',return_value=self.source),mock.patch.object(recovery,'read_event',side_effect=read_event or (lambda *_:self.event)),mock.patch.object(recovery,'mutate',side_effect=mutate) as mutation:
            result=recovery.run_once(self.config,self.path)
        return result,mutation

    def test_only_reviewed_transport_event_can_resume(self):
        self.assertEqual(self.decision(),{'action':'resume','reason':'end_stream_disconnect'})
        for event in [None,{**self.event,'kind':'unique_violation'},{**self.event,'sqlstate':'23505'},{**self.event,'sqlstate':'08P01','kind':'end_stream_disconnect'}]:
            with self.subTest(event=event):self.assertNotEqual(self.decision(event=event)['action'],'resume')

    def test_target_identity_baseline_quarantine_and_subscription_pins(self):
        cases=[(('database',),'postgres'),(('primary',),False),(('store',),'other'),(('target_system_identifier',),'0000000000000000000'),(('baseline',),False),(('state',),'quarantined'),(('state',),'copying'),(('source_generation',),'87654321-4321-8765-4321-876543218765'),(('source_system_identifier',),'0000000000000000000'),(('source_timeline',),2),(('subscriptions',),2),(('subscription','owner'),'reader'),(('subscription','oid'),5678),(('subscription','slot'),'other_slot'),(('subscription','publications'),['other_publication']),(('subscription','disable_on_error'),False),(('subscription','run_as_owner'),True),(('subscription','skip_lsn'),'1/20'),(('subscription','connection_hash'),'b'*32),(('origin','name'),'pg_5678'),(('origin','lsn'),'0/0'),(('origin','lsn'),'not-an-lsn')]
        for path,value in cases:
            with self.subTest(path=path,value=value):self.assertNotEqual(self.decision(target=changed(self.target,path,value))['action'],'resume')

    def test_copy_missing_duplicate_or_unready_relation_blocks(self):
        for relations in [self.target['relations'][:-1],self.target['relations']+[self.target['relations'][0]],[{**r,'state':'s'} for r in self.target['relations']]]:
            with self.subTest(relations=relations):self.assertNotEqual(self.decision(target={**self.target,'relations':relations})['action'],'resume')

    def test_malformed_boolean_flags_and_counters_fail_closed(self):
        for path in [('subscription','enabled'),('subscription','disable_on_error'),('subscription','run_as_owner'),('baseline',),('primary',)]:
            for value in ['false','true',0,1,None]:
                with self.subTest(path=path,value=value):self.assertNotEqual(self.decision(target=changed(self.target,path,value))['action'],'resume')
        for path,value in [(('stats','apply_errors'),True),(('stats','sync_errors'),False),(('subscriptions',),True)]:
            with self.subTest(path=path):self.assertNotEqual(self.decision(target=changed(self.target,path,value))['action'],'resume')
        self.assertNotEqual(self.decision(state={**self.state,'armed':'true'})['action'],'resume')
        self.assertEqual(self.decision(config={**self.config,'enabled':'true'})['action'],'paused')

    def test_source_live_identity_slot_retention_and_freshness(self):
        cases=[(('database',),'other'),(('primary',),False),(('login',),False),(('user',),'postgres'),(('live_system_identifier',),'0000000000000000000'),(('live_timeline',),2),(('signal','generation'),'87654321-4321-8765-4321-876543218765'),(('signal','system_identifier'),'0000000000000000000'),(('signal','timeline'),2),(('signal','sampled_at'),recovery.iso(NOW-121)),(('signal','sampled_at'),recovery.iso(NOW+1)),(('slot','name'),'other'),(('slot','plugin'),'test_decoding'),(('slot','type'),'physical'),(('slot','database'),'other'),(('slot','active'),True),(('slot','restart_lsn'),'0/0'),(('slot','confirmed_flush_lsn'),'bad'),(('slot','retained_bytes'),48*1024**3),(('slot','retained_bytes'),-1)]
        for path,value in cases:
            with self.subTest(path=path,value=value):self.assertNotEqual(self.decision(source=changed(self.source,path,value))['action'],'resume')
        for status in ['extended','unreserved','lost',None]:
            with self.subTest(status=status):self.assertNotEqual(self.decision(source=changed(self.source,('slot','status'),status))['action'],'resume')

    def test_confirmed_ahead_preserves_native_idle_feedback_without_rewinding_origin(self):
        # Native PG16 feedback can legitimately advance over control/empty WAL.
        # The saved healthy origin remains the monotonic lower bound.
        source=changed(self.source,('slot','confirmed_flush_lsn'),'1/20')
        self.assertEqual(self.decision(source=source)['action'],'resume')
        target=changed(self.target,('origin','lsn'),'1/20')
        self.assertEqual(self.decision(target=target)['action'],'resume')
        target=changed(self.target,('origin','lsn'),'1/F')
        self.assertEqual(self.decision(target=target)['reason'],'origin_regressed')

    def test_armed_recovery_requires_a_valid_pinned_origin_floor(self):
        state={key:value for key,value in self.state.items() if key!='healthy_origin'}
        self.assertEqual(self.decision(state=state)['reason'],'origin_floor_missing')
        for floor in [None,{},'1/10',{'name':'pg_1234'},True]:
            with self.subTest(floor=floor):self.assertEqual(self.decision(state={**self.state,'healthy_origin':floor})['reason'],'origin_floor_invalid')
        for value in ['bad','0/0','1/100000000','100000000/1',True,None]:
            state=changed(self.state,('healthy_origin','lsn'),value)
            with self.subTest(value=value):self.assertEqual(self.decision(state=state)['reason'],'origin_floor_invalid')
        for key,value in [('name','pg_5678'),('subscription_oid',5678),('pins_sha256','b'*64)]:
            state=changed(self.state,('healthy_origin',key),value)
            with self.subTest(key=key):self.assertEqual(self.decision(state=state)['reason'],'origin_floor_identity_changed')

    def test_origin_floor_is_bound_to_reviewed_configuration(self):
        config={**self.config,'connection_hash':'b'*32}
        target=changed(self.target,('subscription','connection_hash'),'b'*32)
        self.assertEqual(self.decision(config=config,target=target)['reason'],'origin_floor_identity_changed')

    def test_statistics_epoch_counter_and_acknowledgement(self):
        for stats in [{'apply_errors':2,'sync_errors':0,'stats_reset':RESET},{'apply_errors':1,'sync_errors':1,'stats_reset':RESET},{'apply_errors':1,'sync_errors':0,'stats_reset':None}]:
            with self.subTest(stats=stats):self.assertNotEqual(self.decision(target={**self.target,'stats':stats})['action'],'resume')
        self.assertEqual(self.decision(target=changed(self.target,('stats','apply_errors'),0))['reason'],'disabled_without_new_error')
        ack={'event_id':'c'*64,'apply_errors':1,'stats_reset':RESET}
        self.assertEqual(self.decision(target={**self.target,'ack':ack})['reason'],'disabled_without_new_error')
        target={**self.target,'ack':ack,'stats':{**self.target['stats'],'apply_errors':2}}
        self.assertEqual(self.decision(target=target)['action'],'resume')
        target['ack']={**ack,'stats_reset':None}
        self.assertNotEqual(self.decision(target=target)['action'],'resume')

    def test_manual_disable_never_becomes_a_transport_retry(self):
        self.assertEqual(self.decision(config={**self.config,'enabled':False})['action'],'paused')
        self.assertNotEqual(self.decision(state={**self.state,'armed':False})['action'],'resume')
        self.assertNotEqual(self.decision(target={**self.target,'workers':[{'pid':987,'relid':None}]})['action'],'resume')

    def test_retry_budget_and_backoff_survive_new_event_ids(self):
        self.assertEqual(self.decision(state={**self.state,'attempts':[NOW-300,NOW-200,NOW-100]})['reason'],'hourly_retry_budget')
        self.assertEqual(self.decision(state={**self.state,'attempts':[NOW-4000,NOW-3900,NOW-3800]})['action'],'resume')
        state={**self.state,'incident':self.event['event_id'],'incident_attempts':[NOW-1000,NOW-900,NOW-800]}
        self.assertEqual(self.decision(state=state)['reason'],'incident_retry_budget')
        self.assertEqual(self.decision(event={**self.event,'event_at':recovery.iso(NOW-30)})['reason'],'retry_backoff')
        state={**self.state,'incident':self.event['event_id'],'incident_attempts':[NOW-61]}
        self.assertEqual(self.decision(state=state)['reason'],'retry_backoff')
        self.assertEqual(self.decision(state={**self.state,'attempts':[NOW-300,NOW-200,NOW-100]},event={**self.event,'event_id':'d'*64})['reason'],'hourly_retry_budget')

    def test_log_transport_classification_and_known_details(self):
        for (code,message),kind in recovery.TRANSPORT.items():
            with self.subTest(code=code,message=message):
                self.write_log(self.logs(message=message,code=code,severity='LOG' if code=='00000' else 'ERROR'))
                event=recovery.read_event(self.config,self.target,self.state)
                self.assertEqual((event['sqlstate'],event['kind']),(code,kind))
                self.assertEqual(len(event['event_id']),64)
                self.assertEqual(event,recovery.read_event(self.config,self.target,self.state))

    def test_receive_disconnect_08006_reaches_guarded_resume(self):
        # Exact native receive-path pair observed on October 17 and October 23;
        # an 08006 SQLSTATE alone never establishes a transport failure.
        message='could not receive data from WAL stream: server closed the connection unexpectedly'
        self.write_log(self.logs(message=message,code='08006'))
        event=recovery.read_event(self.config,self.target,self.state)
        self.assertEqual((event['sqlstate'],event['kind'],event['error_message']),('08006','stream_connection_closed',message))
        self.assertEqual(self.decision(event=event),{'action':'resume','reason':'stream_connection_closed'})
        result,mutation=self.run_mocked(read_event=lambda *_:event)
        self.assertEqual(result,{'action':'resumed','reason':'stream_connection_closed','event_id':event['event_id']})
        mutation.assert_called_once_with(self.config,self.target,event)
        saved=recovery.read_json(self.path)
        self.assertEqual(saved['pending_event'],event)
        self.assertEqual(saved['attempts'],[NOW])
        self.assertEqual(self.target['stats'],{'apply_errors':1,'sync_errors':0,'stats_reset':RESET})

    def test_receive_disconnect_08006_keeps_existing_recovery_gates(self):
        message='could not receive data from WAL stream: server closed the connection unexpectedly'
        self.write_log(self.logs(message=message,code='08006'))
        event=recovery.read_event(self.config,self.target,self.state)
        cases=[{'config':{**self.config,'enabled':False}},
               {'target':changed(self.target,('stats','apply_errors'),2)},
               {'target':changed(self.target,('stats','sync_errors'),1)},
               {'target':changed(self.target,('stats','stats_reset'),None)},
               {'target':changed(self.target,('state',),'quarantined')},
               {'target':changed(self.target,('origin','lsn'),'1/F')},
               {'source':changed(self.source,('slot','status'),'lost')},
               {'source':changed(self.source,('live_timeline',),2)},
               {'state':{**self.state,'armed':False}},
               {'state':{**self.state,'attempts':[NOW-300,NOW-200,NOW-100]}}]
        for changes in cases:
            with self.subTest(changes=changes):self.assertNotEqual(self.decision(event=event,**changes)['action'],'resume')

    def test_receive_disconnect_08006_rejects_near_matches_details_and_ambiguous_evidence(self):
        message='could not receive data from WAL stream: server closed the connection unexpectedly'
        cases=[self.logs(message=message,code=code) for code in ['08003','23505','00000']]
        cases += [self.logs(message=message,code='08006',severity=severity) for severity in ['LOG','FATAL','PANIC']]
        cases += [self.logs(message=message,code='08006',detail=detail) for detail in ['no COPY in progress','permission denied on publisher','requested WAL segment has already been removed']]
        cases += [self.logs(message=text,code='08006') for text in [message+': permission denied',message+' while applying a transaction','could not receive data from WAL stream: requested WAL segment has already been removed','could not receive data from WAL stream: permission denied','could not receive data from WAL stream: terminating connection due to administrator command']]
        good=self.logs(message=message,code='08006')
        cases += [good[:-1],good+[good[-1]],good+[self.log_line(NOW-121,'ERROR','duplicate key violates unique constraint',code='23505')],good[:-1]+[good[-1].replace('[987]','[654]')]]
        for lines in cases:
            with self.subTest(lines=lines):
                self.write_log(lines)
                with self.assertRaises(ValueError):recovery.read_event(self.config,self.target,self.state)
        # The end-of-stream send path retains its independently reviewed detail.
        send='could not send end-of-streaming message to primary: no COPY in progress'
        self.write_log(self.logs(message=send,code='08006',detail='no COPY in progress'))
        self.assertEqual(recovery.read_event(self.config,self.target,self.state)['kind'],'end_stream_disconnect')

    def test_native_stream_ended_log_needs_disable_and_no_worker_error(self):
        message='data stream from publisher has ended'
        lines=self.logs(message=message,code='00000',severity='LOG')
        self.write_log(lines)
        event=recovery.read_event(self.config,self.target,self.state)
        self.assertEqual((event['sqlstate'],event['kind']),('00000','publisher_stream_ended'))
        self.assertEqual(self.decision(event=event)['action'],'resume')
        cases=[lines+[self.log_line(NOW-121,'ERROR','duplicate key violates unique constraint',code='23505')],lines+[lines[1]],lines[:-1],self.logs(message=message,code='00000',severity='ERROR'),self.logs(message=message,code='00000',severity='FATAL')]
        for candidate in cases:
            with self.subTest(candidate=candidate):
                self.write_log(candidate)
                with self.assertRaises(ValueError):recovery.read_event(self.config,self.target,self.state)
        # A recognized failure message at LOG/FATAL/PANIC is not the reviewed
        # ERROR event, even when its SQLSTATE and text otherwise match exactly.
        transport=next(message for (code,message) in recovery.TRANSPORT if code=='08006')
        for severity in ['LOG','FATAL','PANIC']:
            with self.subTest(severity=severity):
                self.write_log(self.logs(message=transport,code='08006',severity=severity))
                with self.assertRaises(ValueError):recovery.read_event(self.config,self.target,self.state)

    def test_unknown_sqlstate_messages_and_wrapped_details_never_acknowledge(self):
        cases=[self.logs(code='23505'),self.logs(message='permission denied for table blocks'),self.logs(message='could not receive data from WAL stream: requested WAL segment has already been removed'),self.logs(detail='permission denied on publisher'),self.logs()+[self.log_line(NOW-121,'ERROR','duplicate key violates unique constraint',code='23505')]]
        for lines in cases:
            with self.subTest(lines=lines):
                self.write_log(lines)
                with self.assertRaises(ValueError):recovery.read_event(self.config,self.target,self.state)

    def test_missing_ambiguous_and_unproven_worker_logs_block(self):
        good=self.logs()
        cases=[[],good[1:],good[:-1],good+[good[-1]],good+[good[1]],[line.replace('[987]','[654]') for line in good]]
        for lines in cases:
            with self.subTest(lines=lines):
                self.write_log(lines)
                with self.assertRaises(ValueError):recovery.read_event(self.config,self.target,self.state)
        with self.assertRaises(ValueError):recovery.read_event(self.config,self.target,{})

    def test_post_cutoff_start_proves_a_new_worker_session(self):
        lines=self.logs()
        lines.insert(1,self.log_line(NOW-200,'LOG',f'logical replication apply worker for subscription "{recovery.NAME}" has started'))
        self.write_log(lines)
        event=recovery.read_event(self.config,self.target,{**self.state,'healthy_worker_pid':654})
        self.assertEqual(event['pid'],987)

    def test_log_rotation_is_accepted_only_when_bounded_evidence_is_complete(self):
        lines=self.logs()
        self.write_log(lines[:1],'.1');self.write_log(lines[1:])
        self.assertEqual(recovery.read_event(self.config,self.target,self.state)['pid'],987)
        pathlib.Path(self.config['log_path']+'.1').unlink()
        with self.assertRaises(ValueError):recovery.read_event(self.config,self.target,self.state)
        self.write_log(lines)
        with mock.patch.object(recovery,'MAX_LOG_BYTES',128):
            with self.assertRaises(ValueError):recovery.read_event(self.config,self.target,self.state)

    def test_symlink_invalid_utf8_and_shrinking_logs_fail_closed(self):
        actual=self.root/'actual.log';actual.write_text(''.join(self.logs()))
        path=pathlib.Path(self.config['log_path']);path.symlink_to(actual)
        with self.assertRaises(ValueError):recovery.read_event(self.config,self.target,self.state)
        path.unlink();path.write_bytes(b'\xff')
        with self.assertRaises(UnicodeError):recovery.read_event(self.config,self.target,self.state)
        self.write_log(self.logs())
        before=os.stat(path);after=mock.Mock(st_ino=before.st_ino,st_size=before.st_size-1)
        with mock.patch.object(recovery.os,'fstat',side_effect=[before,after]):
            with self.assertRaises(ValueError):recovery.read_event(self.config,self.target,self.state)

    def test_state_is_durable_private_and_reserved_before_mutation(self):
        def mutate(*_):
            saved=json.loads(self.path.read_text())
            self.assertEqual(saved['attempts'],[NOW]);self.assertEqual(saved['pending_event'],self.event)
            self.assertEqual(saved['incident_attempts'],[NOW]);self.assertEqual(self.path.stat().st_mode&0o777,0o600)
        result,mutation=self.run_mocked(mutate=mutate)
        self.assertEqual(result['action'],'resumed');mutation.assert_called_once()

    def test_persistence_failure_never_mutates(self):
        with mock.patch.object(recovery.time,'time',return_value=NOW),mock.patch.object(recovery,'probe_target',return_value=self.target),mock.patch.object(recovery,'probe_source',return_value=self.source),mock.patch.object(recovery,'read_event',return_value=self.event),mock.patch.object(recovery,'save_state',side_effect=OSError('fixture persistence failure')),mock.patch.object(recovery,'mutate') as mutation:
            self.state['armed']=True
            self.path.parent.mkdir();self.path.write_text(json.dumps(self.state))
            with self.assertRaises(OSError):recovery.run_once(self.config,self.path)
            mutation.assert_not_called()

    def test_mutation_failure_keeps_retry_reservation_and_backoff(self):
        with self.assertRaises(RuntimeError):
            self.run_mocked(mutate=RuntimeError('fixture administrative failure'))
        saved=json.loads(self.path.read_text())
        self.assertEqual(saved['attempts'],[NOW]);self.assertEqual(saved['pending_event'],self.event)
        self.assertEqual(self.decision(state=saved,now=NOW+61)['reason'],'retry_backoff')

    def test_unavailable_log_evidence_never_mutates(self):
        for error in [ValueError('ambiguous evidence'),OSError('unavailable evidence'),UnicodeError('malformed evidence')]:
            with self.subTest(error=type(error).__name__):
                result,mutation=self.run_mocked(read_event=error)
                self.assertEqual(result['action'],'blocked');mutation.assert_not_called()

    def test_probe_race_keeps_reserved_attempt_but_never_mutates_changed_pins(self):
        changes=[(('subscription','owner'),'reader'),(('stats','apply_errors'),2),(('origin','lsn'),'1/20'),(('store',),'other'),(('subscriptions',),2),(('primary',),False)]
        for path,value in changes:
            with self.subTest(path=path):
                result,mutation=self.run_mocked(target=[self.target,changed(self.target,path,value)])
                self.assertEqual(result['action'],'blocked');mutation.assert_not_called()
                self.assertEqual(json.loads(self.path.read_text())['attempts'],[NOW])
        result,mutation=self.run_mocked(target=[self.target,{**self.target,'ack':{'event_id':'c'*64,'apply_errors':1,'stats_reset':RESET}}])
        self.assertEqual(result['action'],'blocked');mutation.assert_not_called()

    def test_operator_pause_before_or_during_probing_never_mutates(self):
        self.path.parent.mkdir();(self.path.parent/'paused').write_text('operator maintenance')
        with mock.patch.object(recovery,'probe_target') as target,mock.patch.object(recovery,'mutate') as mutation:
            self.assertEqual(recovery.run_once(self.config,self.path)['action'],'paused');target.assert_not_called();mutation.assert_not_called()
        (self.path.parent/'paused').unlink()
        def read_event(*_):
            (self.path.parent/'paused').write_text('operator maintenance')
            return self.event
        result,mutation=self.run_mocked(read_event=read_event)
        self.assertEqual(result['action'],'paused');mutation.assert_not_called()

    def test_only_admitted_apply_worker_can_arm_automatic_recovery(self):
        healthy=self.healthy()
        with mock.patch.object(recovery.time,'time',return_value=NOW),mock.patch.object(recovery,'probe_target',return_value=healthy),mock.patch.object(recovery,'probe_source') as source,mock.patch.object(recovery,'mutate') as mutation:
            self.assertEqual(recovery.run_once(self.config,self.path)['action'],'healthy');source.assert_not_called();mutation.assert_not_called()
        self.assertIs(json.loads(self.path.read_text())['armed'],True)
        self.assertEqual(json.loads(self.path.read_text())['healthy_origin'],recovery.healthy_origin(self.config,healthy))
        self.path.unlink()
        with mock.patch.object(recovery,'probe_target',return_value={**healthy,'workers':[{'pid':987,'relid':42}]}):
            self.assertNotEqual(recovery.run_once(self.config,self.path)['action'],'healthy')
        self.assertFalse(self.path.exists())

    def test_enabled_feed_cannot_rearm_with_missing_invalid_or_regressed_floor(self):
        healthy=self.healthy()
        states=[{key:value for key,value in self.state.items() if key!='healthy_origin'},
                {**self.state,'healthy_origin':None},changed(self.state,('healthy_origin','lsn'),'1/20')]
        for state in states:
            with self.subTest(state=state):
                recovery.save_state(self.path,state)
                with mock.patch.object(recovery,'probe_target',return_value=healthy),mock.patch.object(recovery,'mutate') as mutation:
                    self.assertEqual(recovery.run_once(self.config,self.path)['action'],'blocked');mutation.assert_not_called()
                self.assertEqual(json.loads(self.path.read_text()),state,'a rewind must never overwrite its previous floor')
        recovery.save_state(self.path,self.state)
        advanced=changed(healthy,('origin','lsn'),'1/20')
        with mock.patch.object(recovery,'probe_target',return_value=advanced):self.assertEqual(recovery.run_once(self.config,self.path)['action'],'healthy')
        self.assertEqual(json.loads(self.path.read_text())['healthy_origin']['lsn'],'1/20')

    def test_operator_pause_is_durable_before_disable_and_unpause_never_enables(self):
        config_path=self.root/'config.json';config_path.write_text(json.dumps(self.config))
        pause=self.path.parent/'paused'
        def query(*args,**_):
            self.assertTrue(pause.exists());self.assertEqual(pause.stat().st_mode&0o777,0o600)
            self.assertEqual(args[1],'ALTER SUBSCRIPTION ask_public_core_v1 DISABLE;')
        with mock.patch.object(recovery.sys,'argv',['feed-recovery.py','--config',str(config_path),'--pause']),mock.patch.object(recovery,'query',side_effect=query) as call:
            self.assertEqual(recovery.main()['action'],'paused');call.assert_called_once()
        with mock.patch.object(recovery.sys,'argv',['feed-recovery.py','--config',str(config_path),'--unpause']),mock.patch.object(recovery,'query') as call:
            self.assertEqual(recovery.main()['action'],'paused');call.assert_not_called()
        self.assertFalse(pause.exists())

    def test_source_probe_pairs_read_only_slot_probe_with_live_replication_identity(self):
        source={key:value for key,value in self.source.items() if not key.startswith('live_')}
        identity={'live_system_identifier':self.config['source_system_identifier'],'live_timeline':1}
        with mock.patch.object(recovery,'query',side_effect=[source,identity]) as query:
            observed=recovery.probe_source(self.config)
        self.assertEqual(observed['live_system_identifier'],self.config['source_system_identifier'])
        self.assertEqual(query.call_args_list,[mock.call(self.config,recovery.SOURCE_SQL,True),mock.call(self.config,'IDENTIFY_SYSTEM;',True,True)])
        response=subprocess.CompletedProcess([],0,stdout=self.config['source_system_identifier']+'|1|1/10|zcash_explorer_mainnet\n',stderr='')
        with mock.patch.object(recovery.subprocess,'run',return_value=response) as run:
            self.assertEqual(recovery.query(self.config,'IDENTIFY_SYSTEM;',source=True,replication=True),identity)
            self.assertIn('dbname=zcash_explorer_mainnet replication=database',run.call_args.args[0])
        for output in ['bad|identity','1234|1|1/10|other_database','1234|not-a-timeline|1/10|zcash_explorer_mainnet']:
            with mock.patch.object(recovery.subprocess,'run',return_value=subprocess.CompletedProcess([],0,stdout=output,stderr='')):
                with self.assertRaises(ValueError):recovery.query(self.config,'IDENTIFY_SYSTEM;',source=True,replication=True)

    def test_fixed_mutation_preserves_error_counters_origins_and_source_slots(self):
        with mock.patch.object(recovery,'query') as query:
            recovery.mutate(self.config,self.target,self.event)
        args,kwargs=query.call_args
        self.assertFalse(kwargs.get('source',False))
        sql=args[1]
        self.assertLess(sql.index('INSERT INTO analytics_meta.replication_recovery_events'),sql.index('ALTER SUBSCRIPTION ask_public_core_v1 ENABLE'))
        self.assertIn('INSERT INTO analytics_meta.replication_recovery_ack',sql)
        self.assertNotRegex(sql,r'(?i)pg_stat_reset|pg_replication_origin_advance|pg_drop_replication_slot|pg_create_logical_replication_slot|DROP\s+SUBSCRIPTION')

    def test_config_validation_rejects_unpinned_identity_and_invalid_private_paths(self):
        self.assertEqual(recovery.validate(self.config),self.config)
        cases=[('target_system_identifier',''),('source_system_identifier','not-an-id'),('source_generation','invalid'),('source_timeline',True),('subscription_oid',False),('connection_hash','password'),('target_port',True),('source_port',65536),('source_user','postgres'),('target_database','postgres'),('expected_relations',[]),('source_socket','relative/path')]
        for key,value in cases:
            with self.subTest(key=key):
                with self.assertRaises((ValueError,TypeError,KeyError)):recovery.validate({**self.config,key:value})

    def test_probes_strip_inherited_postgres_credentials_and_options(self):
        response=subprocess.CompletedProcess([],0,stdout='{"ok":true}\n',stderr='')
        with mock.patch.dict(os.environ,{'PGPASSWORD':'fixture-not-a-real-password','PGOPTIONS':'-c search_path=unsafe','PGHOST':'unwanted-host'}),mock.patch.object(recovery.subprocess,'run',return_value=response) as run:
            self.assertEqual(recovery.query(self.config,'SELECT fixture;',source=True),{'ok':True})
            options=run.call_args.kwargs
            self.assertNotIn('PGPASSWORD',options['env']);self.assertNotIn('PGOPTIONS',options['env']);self.assertNotIn('PGHOST',options['env'])
            self.assertEqual(options['env']['PGPASSFILE'],self.config['source_passfile']);self.assertLessEqual(options['timeout'],8)


if __name__=='__main__':unittest.main()
