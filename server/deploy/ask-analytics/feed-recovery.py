#!/usr/bin/python3
"""Trusted target-only recovery of classified transport failures. No SQL/user API.
Never clears errors, advances an origin, recreates a slot or makes coverage ready.
"""
import argparse,datetime,fcntl,hashlib,json,os,pathlib,re,subprocess,sys,time,uuid
NAME='ask_public_core_v1'
TRANSPORT={
 ('08006','could not send end-of-streaming message to primary: server closed the connection unexpectedly'):'end_stream_disconnect',
 ('08006','could not send end-of-streaming message to primary: no COPY in progress'):'end_stream_disconnect',
 ('08006','could not receive data from WAL stream: server closed the connection unexpectedly'):'stream_connection_closed',
 ('08P01','could not receive data from WAL stream: server closed the connection unexpectedly'):'stream_connection_closed',
 ('00000','data stream from publisher has ended'):'publisher_stream_ended',
}
MAX_LOG_BYTES=16*1024*1024
LINE=re.compile(r'^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+ UTC) \[(\d+)\] (?:([0-9A-Z]{5}) )?(?:\S+@\S+ )?(LOG|ERROR|FATAL|PANIC|DETAIL|CONTEXT|STATEMENT|LOCATION):\s*(.*)$')
def stamp(value):
    if value is None:return None
    return datetime.datetime.fromisoformat(str(value).replace(' UTC','+00:00').replace('Z','+00:00')).timestamp()
def iso(value):return datetime.datetime.fromtimestamp(value,datetime.timezone.utc).isoformat()
def lsn(value):
    if not isinstance(value,str) or not re.fullmatch(r'[0-9A-F]+/[0-9A-F]+',value):raise ValueError('Invalid checkpoint')
    a,b=value.split('/');return (int(a,16)<<32)+int(b,16)
def healthy_origin(config,target):
    # Bind the monotonic checkpoint to this exact reviewed feed configuration.
    # A repin requires an explicit operator review of the persisted state.
    pins={key:config[key] for key in ['target_system_identifier','source_system_identifier','source_generation','source_timeline','subscription_oid','connection_hash']}
    pins['expected_relations']=sorted(config['expected_relations'])
    return {'name':target['origin']['name'],'lsn':target['origin']['lsn'],'subscription_oid':config['subscription_oid'],
            'pins_sha256':hashlib.sha256(json.dumps(pins,sort_keys=True).encode()).hexdigest()}
def origin_floor_problem(config,target,state):
    if 'armed' in state and type(state['armed']) is not bool:return 'origin_floor_invalid'
    if 'healthy_origin' not in state:return 'origin_floor_missing' if state.get('armed') is True else None
    floor=state['healthy_origin']
    if not isinstance(floor,dict) or set(floor)!={'name','lsn','subscription_oid','pins_sha256'}:return 'origin_floor_invalid'
    value=floor['lsn']
    if not isinstance(value,str) or not re.fullmatch(r'[0-9A-F]{1,8}/[0-9A-F]{1,8}',value) or lsn(value)<=0:return 'origin_floor_invalid'
    if type(floor['subscription_oid']) is not int or not isinstance(floor['pins_sha256'],str) or not re.fullmatch(r'[0-9a-f]{64}',floor['pins_sha256']):return 'origin_floor_invalid'
    expected=healthy_origin(config,target)
    if any(floor[key]!=expected[key] for key in ['name','subscription_oid','pins_sha256']):return 'origin_floor_identity_changed'
    if lsn(target['origin']['lsn'])<lsn(value):return 'origin_regressed'
    return None
def q(value):return 'NULL' if value is None else "'"+str(value).replace("'","''")+"'"
def read_json(path):return json.loads(path.read_text()) if path.exists() else {}
def save_state(path,state):
    path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    tmp=path.with_suffix('.tmp')
    with tmp.open('w') as f:
        os.fchmod(f.fileno(),0o600);json.dump(state,f);f.flush();os.fsync(f.fileno())
    tmp.replace(path)
    fd=os.open(path.parent,os.O_RDONLY)
    try:os.fsync(fd)
    finally:os.close(fd)
def query(config,sql,source=False,replication=False):
    prefix='source_' if source else 'target_'
    env={k:v for k,v in os.environ.items() if not k.startswith('PG')}
    env.update(PGCONNECT_TIMEOUT='3',PGAPPNAME='zecblock_feed_recovery')
    if source:env['PGPASSFILE']=config['source_passfile']
    args=[config.get('psql_bin','/usr/bin/psql'),'-X','-w','-At','-v','ON_ERROR_STOP=1','-h',config[prefix+'socket'],'-p',str(config[prefix+'port']),'-U',config.get(prefix+'user','postgres'),'-d',('dbname=zcash_explorer_mainnet replication=database' if replication else config[prefix+'database'])]
    response=subprocess.run(args,input=sql,text=True,capture_output=True,timeout=8,env=env)
    if response.returncode:raise RuntimeError('Fixed operator query failed')
    if replication:
        fields=response.stdout.strip().split('|')
        if len(fields)!=4 or fields[3]!='zcash_explorer_mainnet' or not fields[1].isdigit():raise ValueError('Invalid live publisher identity')
        return {'live_system_identifier':fields[0],'live_timeline':int(fields[1])}
    lines=[line for line in response.stdout.splitlines() if line.startswith('{')]
    return json.loads(lines[-1]) if lines else {}
TARGET_SQL="""BEGIN READ ONLY; SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='200ms';
SELECT json_build_object('observed_at',clock_timestamp(),'database',current_database(),'primary',NOT pg_is_in_recovery(),
 'target_system_identifier',(SELECT system_identifier::text FROM pg_control_system()),
 'store',(SELECT store_kind FROM analytics_meta.identity WHERE singleton),
 'baseline',(SELECT baseline_verified FROM analytics_meta.admission_control WHERE singleton),
 'state',(SELECT state FROM analytics_meta.sync_state WHERE singleton),
 'source_generation',(SELECT source_id FROM analytics_meta.sync_state WHERE singleton),
 'source_system_identifier',(SELECT source_system_identifier FROM analytics_meta.sync_state WHERE singleton),
 'source_timeline',(SELECT expected_timeline FROM analytics_meta.admission_control WHERE singleton),
 'subscriptions',(SELECT count(*) FROM pg_subscription),
 'subscription',(SELECT json_build_object('oid',oid,'enabled',subenabled,'name',subname,'owner',subowner::regrole::text,'slot',subslotname,'publications',subpublications,'disable_on_error',subdisableonerr,'run_as_owner',subrunasowner,'skip_lsn',subskiplsn,'connection_hash',md5(subconninfo)) FROM pg_subscription WHERE subname='ask_public_core_v1'),
 'relations',(SELECT json_agg(json_build_object('name',srrelid::regclass::text,'state',srsubstate)) FROM pg_subscription_rel WHERE srsubid=(SELECT oid FROM pg_subscription WHERE subname='ask_public_core_v1')),
 'stats',(SELECT json_build_object('apply_errors',apply_error_count,'sync_errors',sync_error_count,'stats_reset',stats_reset) FROM pg_stat_subscription_stats WHERE subname='ask_public_core_v1'),
 'workers',(SELECT coalesce(json_agg(json_build_object('pid',pid,'relid',relid)), '[]'::json) FROM pg_stat_subscription WHERE subname='ask_public_core_v1' AND pid IS NOT NULL),
 'origin',(SELECT json_build_object('name',external_id,'lsn',remote_lsn) FROM pg_replication_origin_status WHERE external_id='pg_'||(SELECT oid::text FROM pg_subscription WHERE subname='ask_public_core_v1')),
 'ack',(SELECT json_build_object('event_id',e.event_id,'apply_errors',e.apply_errors,'stats_reset',e.stats_reset) FROM analytics_meta.replication_recovery_ack a JOIN analytics_meta.replication_recovery_events e USING(subid,event_id) WHERE a.subid=(SELECT oid FROM pg_subscription WHERE subname='ask_public_core_v1')),
 'errors_acknowledged',analytics_meta.replication_errors_acknowledged()); ROLLBACK;"""
SOURCE_SQL="""BEGIN READ ONLY; SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='200ms';
SELECT json_build_object('observed_at',clock_timestamp(),'database',current_database(),'primary',NOT pg_is_in_recovery(),
 'user',current_user,'login',(SELECT rolcanlogin FROM pg_roles WHERE rolname=current_user),
 'signal',(SELECT row_to_json(s) FROM analytics_feed_meta.signal s),
 'slot',(SELECT json_build_object('name',slot_name,'plugin',plugin,'type',slot_type,'database',database,'status',wal_status,'active',active,'restart_lsn',restart_lsn,'confirmed_flush_lsn',confirmed_flush_lsn,'retained_bytes',pg_wal_lsn_diff(pg_current_wal_lsn(),restart_lsn)) FROM pg_replication_slots WHERE slot_name='ask_public_core_v1')); ROLLBACK;"""
def probe_target(config):return query(config,TARGET_SQL)
def probe_source(config):
    result=query(config,SOURCE_SQL,True)
    result.update(query(config,'IDENTIFY_SYSTEM;',True,True))
    return result
def target_problem(config,target):
    sub=target.get('subscription') or {};origin=target.get('origin') or {};stats=target.get('stats') or {}
    if target.get('database')!='ask_analytics' or target.get('primary') is not True or target.get('store')!='logical_public_core' or target.get('target_system_identifier')!=config['target_system_identifier']:return 'target_identity'
    if target.get('baseline') is not True or target.get('state') not in ('ready','stale','reconciling'):return 'baseline_or_quarantine'
    if target.get('source_generation')!=config['source_generation'] or target.get('source_system_identifier')!=config['source_system_identifier'] or target.get('source_timeline')!=config['source_timeline']:return 'source_pin'
    if type(target.get('subscriptions')) is not int or target['subscriptions']!=1 or str(sub.get('oid'))!=str(config['subscription_oid']) or sub.get('name')!=NAME or sub.get('owner')!=config.get('target_user','postgres') or sub.get('slot')!=NAME or sub.get('publications')!=[NAME] or sub.get('disable_on_error') is not True or sub.get('run_as_owner') is not False or sub.get('skip_lsn')!='0/0' or sub.get('connection_hash')!=config['connection_hash']:return 'subscription_changed'
    if type(sub.get('enabled')) is not bool:return 'subscription_changed'
    relations=target.get('relations') or []
    names=[r['name'] if '.' in r['name'] else 'public.'+r['name'] for r in relations]
    if len(names)!=len(set(names)) or set(names)!=set(config['expected_relations']) or any(r.get('state')!='r' for r in relations):return 'copy_incomplete'
    if origin.get('name')!='pg_'+str(config['subscription_oid']):return 'origin_missing'
    try:
        if lsn(origin.get('lsn'))<=0:return 'origin_missing'
    except ValueError:return 'origin_missing'
    if type(stats.get('apply_errors')) is not int or stats['apply_errors']<0 or type(stats.get('sync_errors')) is not int or stats['sync_errors']!=0:return 'unreviewed_replication_error'
    return None
def source_problem(config,source,now):
    if source.get('database')!='zcash_explorer_mainnet' or source.get('primary') is not True or source.get('user')!='ask_core_replicator' or source.get('login') is not True:return 'publisher_unavailable'
    if source.get('live_system_identifier')!=config['source_system_identifier'] or source.get('live_timeline')!=config['source_timeline']:return 'publisher_identity'
    signal=source.get('signal') or {};slot=source.get('slot') or {}
    if signal.get('generation')!=config['source_generation'] or signal.get('system_identifier')!=config['source_system_identifier'] or signal.get('timeline')!=config['source_timeline']:return 'publisher_identity'
    try:
        if not 0<=now-stamp(signal.get('sampled_at'))<=120:return 'publisher_stale'
    except (ValueError,TypeError):return 'publisher_stale'
    if slot.get('name')!=NAME or slot.get('plugin')!='pgoutput' or slot.get('type')!='logical' or slot.get('database')!='zcash_explorer_mainnet' or slot.get('status')!='reserved':return 'slot_unavailable'
    try:
        if lsn(slot.get('restart_lsn'))<=0 or lsn(slot.get('confirmed_flush_lsn'))<=0:return 'slot_unavailable'
    except ValueError:return 'slot_unavailable'
    retained=slot.get('retained_bytes')
    if type(retained) not in (int,float) or not 0<=retained<48*1024**3:return 'wal_pressure'
    return None
def read_event(config,target,state):
    # Read a bounded complete interval. If rotation/truncation removes the last
    # healthy observation, refuse automatic acknowledgement rather than guessing.
    cutoff=state.get('error_after');records=[]
    if not isinstance(cutoff,(int,float)):raise ValueError('Recovery has not observed a healthy feed')
    for path in [pathlib.Path(config['log_path']+'.1'),pathlib.Path(config['log_path'])]:
        if not path.exists():continue
        if path.is_symlink():raise ValueError('Log path is a symlink')
        with path.open('rb') as f:
            before=os.fstat(f.fileno());offset=max(0,before.st_size-MAX_LOG_BYTES);f.seek(offset);raw=f.read(MAX_LOG_BYTES)
            after=os.fstat(f.fileno())
            if before.st_ino!=after.st_ino or after.st_size<before.st_size:raise ValueError('Log changed during evidence read')
        if offset:raw=raw.partition(b'\n')[2]
        for line in raw.decode('utf8',errors='strict').splitlines():
            m=LINE.match(line)
            if m:records.append({'at':stamp(m[1]),'pid':int(m[2]),'code':m[3],'severity':m[4],'message':m[5]})
    records.sort(key=lambda r:r['at'])
    if not records or records[0]['at']>cutoff:raise ValueError('Incomplete log evidence')
    disabled=[r for r in records if r['at']>cutoff and r['severity']=='LOG' and r['message']==f'subscription "{NAME}" has been disabled because of an error']
    if len(disabled)!=1:raise ValueError('Ambiguous disable evidence')
    event=disabled[0]
    start=[r for r in records if r['pid']==event['pid'] and cutoff<r['at']<=event['at'] and r['message']==f'logical replication apply worker for subscription "{NAME}" has started']
    if not start and state.get('healthy_worker_pid')!=event['pid']:raise ValueError('Worker session is not proven')
    errors=[r for r in records if r['pid']==event['pid'] and cutoff<r['at']<=event['at'] and r['severity'] in ('ERROR','FATAL','PANIC')]
    ended=[r for r in records if r['pid']==event['pid'] and cutoff<r['at']<=event['at'] and r['severity']=='LOG' and (r['code'],r['message'])==('00000','data stream from publisher has ended')]
    if len(errors)==0 and len(ended)==1:errors=ended
    if len(errors)!=1:raise ValueError('Ambiguous worker error')
    error=errors[0]
    # End-streaming send errors can carry the known no-COPY DETAIL. The exact
    # 08006 receive disconnect qualifies only without a publisher error DETAIL.
    key=(error['code'],error['message']);kind=TRANSPORT.get(key)
    # Graceful stream-end is a native LOG event, not a successful SQLSTATE
    # attached to an ERROR. All other reviewed disconnects require ERROR.
    severity='LOG' if key[0]=='00000' else 'ERROR'
    if kind is None or error['severity']!=severity:raise ValueError('Worker error is not a reviewed disconnect')
    if key[0]=='08006':
        details=[r['message'] for r in records if r['pid']==event['pid'] and error['at']<=r['at']<=event['at'] and r['severity']=='DETAIL']
        if details and (kind!='end_stream_disconnect' or details!=['no COPY in progress']):raise ValueError('Unknown disconnect detail')
    result={'event_at':iso(event['at']),'error_at':iso(error['at']),'pid':event['pid'],'sqlstate':key[0],'kind':kind,'error_message':error['message'],'disable_message':event['message']}
    result['log_evidence_sha256']=hashlib.sha256(json.dumps([error,event],sort_keys=True).encode()).hexdigest()
    result['event_id']=hashlib.sha256(json.dumps([config['subscription_oid'],target['stats'],result],sort_keys=True).encode()).hexdigest()
    return result
def decide(config,target,source,event,state,now):
    problem=target_problem(config,target)
    if problem:return {'action':'blocked','reason':problem}
    if config.get('enabled') is not True:return {'action':'paused','reason':'configuration_paused'}
    sub=target['subscription'];stats=target['stats'];ack=target.get('ack') or {}
    if sub['enabled']:return {'action':'observe','reason':'enabled'}
    if target.get('workers'):return {'action':'blocked','reason':'worker_still_present'}
    if state.get('armed') is not True:return {'action':'blocked','reason':'never_observed_healthy'}
    problem=origin_floor_problem(config,target,state)
    if problem:return {'action':'blocked','reason':problem}
    if stats.get('stats_reset')!=state.get('stats_reset'):return {'action':'blocked','reason':'statistics_epoch_changed'}
    base=ack.get('apply_errors',0)
    if ack and ack.get('stats_reset')!=stats.get('stats_reset'):return {'action':'blocked','reason':'acknowledgement_epoch_changed'}
    if stats['apply_errors']==base:return {'action':'paused','reason':'disabled_without_new_error'}
    if stats['apply_errors']!=base+1:return {'action':'blocked','reason':'multiple_unreviewed_errors'}
    problem=source_problem(config,source,now)
    if problem:return {'action':'blocked','reason':problem}
    if source['slot'].get('active') is not False:return {'action':'blocked','reason':'slot_active'}
    # Native feedback can advance over idle/control WAL beyond the last applied
    # transaction origin. Preserve the native resume semantics; the saved healthy
    # origin floor, fixed identities and reviewed transport evidence fence recovery.
    if not event or (event.get('sqlstate'),event.get('kind')) not in [(code,kind) for (code,_),kind in TRANSPORT.items()]:return {'action':'blocked','reason':'unclassified_error'}
    recent=[t for t in state.get('attempts',[]) if now-t<3600]
    if len(recent)>=3:return {'action':'blocked','reason':'hourly_retry_budget'}
    failures=[t for t in state.get('incident_attempts',[]) if now-t<86400] if state.get('incident')==event['event_id'] else []
    if len(failures)>=3:return {'action':'blocked','reason':'incident_retry_budget'}
    delay=[60,120,300][min(len(failures),2)]
    if now-stamp(event['event_at'])<delay or failures and now-failures[-1]<delay:return {'action':'waiting','reason':'retry_backoff'}
    return {'action':'resume','reason':event['kind']}
def mutate(config,target,event):
    stats=target['stats'];origin=target['origin'];subid=int(config['subscription_oid'])
    evidence={**event,'origin_before':origin['lsn'],'target_system_identifier':config['target_system_identifier'],'automatic':True}
    names='ARRAY['+','.join(q(name) for name in sorted(config['expected_relations']))+']::text[]'
    expected_ack=(target.get('ack') or {}).get('event_id')
    sql=f"""BEGIN; SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='500ms';
DO $$BEGIN
 PERFORM 1 FROM analytics_meta.sync_state WHERE singleton FOR UPDATE;
 PERFORM 1 FROM analytics_meta.admission_control WHERE singleton FOR UPDATE;
 LOCK TABLE analytics_meta.replication_recovery_ack IN SHARE ROW EXCLUSIVE MODE;
 IF current_database()<>'ask_analytics' OR pg_is_in_recovery() OR (SELECT system_identifier::text FROM pg_control_system())<>{q(config['target_system_identifier'])} THEN RAISE EXCEPTION 'Target changed'; END IF;
 IF (SELECT count(*) FROM pg_subscription)<>1 OR NOT EXISTS(SELECT FROM pg_subscription WHERE oid={subid} AND subname='ask_public_core_v1' AND NOT subenabled AND subdisableonerr AND NOT subrunasowner AND subslotname='ask_public_core_v1' AND subskiplsn='0/0' AND md5(subconninfo)={q(config['connection_hash'])} AND subowner=(SELECT oid FROM pg_roles WHERE rolname={q(config.get('target_user','postgres'))}) AND subpublications=ARRAY['ask_public_core_v1']::text[]) THEN RAISE EXCEPTION 'Subscription changed'; END IF;
 IF EXISTS(SELECT FROM pg_stat_subscription WHERE subid={subid} AND pid IS NOT NULL) OR EXISTS(SELECT FROM pg_subscription_rel WHERE srsubid={subid} AND srsubstate<>'r') THEN RAISE EXCEPTION 'Worker or copy changed'; END IF;
 IF (SELECT array_agg(n.nspname||'.'||c.relname ORDER BY n.nspname||'.'||c.relname) FROM pg_subscription_rel r JOIN pg_class c ON c.oid=r.srrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE r.srsubid={subid}) IS DISTINCT FROM {names} THEN RAISE EXCEPTION 'Relations changed'; END IF;
 IF (SELECT event_id FROM analytics_meta.replication_recovery_ack WHERE subid={subid}) IS DISTINCT FROM {q(expected_ack)}::text THEN RAISE EXCEPTION 'Acknowledgement changed'; END IF;
 IF NOT EXISTS(SELECT FROM analytics_meta.identity WHERE singleton AND schema_version=1 AND store_kind='logical_public_core') THEN RAISE EXCEPTION 'Store changed'; END IF;
 IF NOT EXISTS(SELECT FROM pg_stat_subscription_stats WHERE subid={subid} AND apply_error_count={stats['apply_errors']} AND sync_error_count=0 AND stats_reset IS NOT DISTINCT FROM {q(stats['stats_reset'])}::timestamptz) THEN RAISE EXCEPTION 'Statistics changed'; END IF;
 IF NOT EXISTS(SELECT FROM pg_replication_origin_status WHERE external_id={q(origin['name'])} AND remote_lsn={q(origin['lsn'])}::pg_lsn) THEN RAISE EXCEPTION 'Origin changed'; END IF;
 IF NOT EXISTS(SELECT FROM analytics_meta.sync_state s JOIN analytics_meta.admission_control c USING(singleton) WHERE s.singleton AND s.state IN('ready','stale','reconciling') AND c.baseline_verified AND s.source_id={q(config['source_generation'])}::uuid AND s.source_system_identifier={q(config['source_system_identifier'])} AND c.expected_timeline={config['source_timeline']}) THEN RAISE EXCEPTION 'Baseline changed'; END IF;
END$$;
UPDATE analytics_meta.sync_state SET state='stale',verified_at=NULL WHERE singleton;
INSERT INTO analytics_meta.replication_recovery_events(event_id,subid,stats_reset,apply_errors,sync_errors,source_generation,source_system_identifier,source_timeline,origin_name,event_at,evidence) VALUES({q(event['event_id'])},{subid},{q(stats['stats_reset'])}::timestamptz,{stats['apply_errors']},0,{q(config['source_generation'])}::uuid,{q(config['source_system_identifier'])},{config['source_timeline']},{q(origin['name'])},{q(event['event_at'])}::timestamptz,{q(json.dumps(evidence))}::jsonb) ON CONFLICT(event_id) DO NOTHING;
INSERT INTO analytics_meta.replication_recovery_ack(subid,event_id) VALUES({subid},{q(event['event_id'])}) ON CONFLICT(subid) DO UPDATE SET event_id=excluded.event_id;
ALTER SUBSCRIPTION ask_public_core_v1 ENABLE;
COMMIT;"""
    query(config,sql)
def run_once(config,state_path):
    path=pathlib.Path(state_path);state=read_json(path);now=time.time()
    if (path.parent/'paused').exists() or config.get('enabled') is not True:return {'action':'paused','reason':'operator_pause'}
    target=probe_target(config);problem=target_problem(config,target)
    if problem:return {'action':'blocked','reason':problem}
    problem=origin_floor_problem(config,target,state)
    if problem:return {'action':'blocked','reason':problem}
    if target['subscription']['enabled']:
        if target['state']=='ready' and target['errors_acknowledged'] is True and len(target['workers'])==1 and target['workers'][0].get('relid') is None and type(target['workers'][0].get('pid')) is int:
            state.update(armed=True,error_after=now,stats_reset=target['stats']['stats_reset'],healthy_worker_pid=target['workers'][0]['pid'],healthy_origin=healthy_origin(config,target))
            state.pop('incident_attempts',None);state.pop('incident',None);save_state(path,state)
            return {'action':'healthy','reason':'admission_verified'}
        return {'action':'observing','reason':'waiting_for_admission'}
    source=probe_source(config)
    try:event=read_event(config,target,state)
    except (ValueError,OSError,UnicodeError):event=None
    result=decide(config,target,source,event,state,now)
    if result['action']!='resume':return result
    # Persist reservation/evidence BEFORE administrative mutation. A crash cannot
    # erase the retry budget. Public readiness remains the normal admission's job.
    state['attempts']=[t for t in state.get('attempts',[]) if now-t<3600]+[now]
    old=state.get('incident_attempts',[]) if state.get('incident')==event['event_id'] else []
    state.update(incident=event['event_id'],incident_attempts=old+[now],pending_event=event)
    save_state(path,state)
    if (path.parent/'paused').exists():return {'action':'paused','reason':'operator_pause'}
    current=probe_target(config)
    if current!=target:
        # Probe timestamps change: compare only security-relevant snapshot fields.
        keys=['target_system_identifier','subscription','stats','origin','relations','baseline','state','source_generation','source_system_identifier','source_timeline','workers','ack','errors_acknowledged','database','primary','store','subscriptions']
        if any(current[k]!=target[k] for k in keys):return {'action':'blocked','reason':'target_changed_during_recovery'}
    if (path.parent/'paused').exists():return {'action':'paused','reason':'operator_pause'}
    mutate(config,current,event)
    return {'action':'resumed','reason':event['kind'],'event_id':event['event_id']}
def validate(config):
    for key in ['target_socket','source_socket','source_passfile','log_path','state_dir']:
        if not isinstance(config.get(key),str) or not os.path.isabs(config[key]):raise ValueError('Absolute private paths required')
    for key in ['target_system_identifier','source_system_identifier']:
        if not re.fullmatch(r'\d{10,25}',str(config.get(key,''))):raise ValueError('Pinned physical identity required')
    if not re.fullmatch(r'[0-9a-f]{32}',config.get('connection_hash','')):raise ValueError('Pinned subscription connection required')
    uuid.UUID(config['source_generation'])
    if type(config.get('subscription_oid')) is not int or config['subscription_oid']<=0 or type(config.get('source_timeline')) is not int or config['source_timeline']<=0:raise ValueError('Pinned subscription/timeline required')
    if config.get('target_database')!='ask_analytics' or config.get('source_database')!='zcash_explorer_mainnet' or config.get('source_user')!='ask_core_replicator':raise ValueError('Fixed feed databases/role required')
    for key in ['target_port','source_port']:
        if type(config.get(key)) is not int or not 1<=config[key]<=65535:raise ValueError('Private port required')
    if not config.get('expected_relations') or any(not re.fullmatch(r'(?:public|analytics_feed_meta)\.[a-z_]+',name) for name in config['expected_relations']):raise ValueError('Reviewed relations required')
    return config
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--config',default='/etc/zecblock-ask-recovery/config.json');parser.add_argument('--pause',action='store_true');parser.add_argument('--unpause',action='store_true');args=parser.parse_args()
    config=validate(json.loads(pathlib.Path(args.config).read_text()));directory=pathlib.Path(config['state_dir']);directory.mkdir(mode=0o700,parents=True,exist_ok=True)
    with (directory/'lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return {'action':'busy','reason':'recovery_locked'}
        pause=directory/'paused'
        if args.pause:
            save_state(pause,{'paused_at':iso(time.time())})
            query(config,"ALTER SUBSCRIPTION ask_public_core_v1 DISABLE;")
            return {'action':'paused','reason':'operator_pause'}
        if args.unpause:
            # Removing pause does NOT enable an intentionally disabled subscription.
            pause.unlink(missing_ok=True);return {'action':'paused','reason':'operator_resume_requires_reviewed_enable'}
        return run_once(config,directory/'state.json')
if __name__=='__main__':
    try:print(json.dumps({'event':'analytics_feed_recovery',**main()}))
    except Exception as error:
        print(json.dumps({'event':'analytics_feed_recovery','action':'blocked','reason':'probe_or_persistence_failed','error_class':type(error).__name__}));sys.exit(1)
