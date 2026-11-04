#!/usr/bin/python3
"""Trusted operator guard: stop only the reviewed analytics feed on disk/WAL risk."""
import datetime,json,os,re,subprocess,sys
ROLE='ask_core_replicator'
SLOT='ask_public_core_v1'

def decision(config,report,free,total):
    prefix=config.get('sync_prefix','')
    if not re.fullmatch(r'pg_[0-9]+_sync_',prefix): raise ValueError('invalid sync prefix')
    if str(report.get('system_identifier'))!=str(config['source_system_identifier']) or report.get('standby') is not False:
        raise ValueError('source identity changed')
    if report.get('database')!='zcash_explorer_mainnet': raise ValueError('wrong database')
    if report.get('wal_level')!='logical' or int(report.get('wal_budget_mb',0))!=65536:
        raise ValueError('reviewed WAL configuration required')
    own=[s for s in report.get('slots',[]) if s['name']==SLOT or re.fullmatch(re.escape(prefix)+r'[0-9]+_[0-9]+',s['name'])]
    reasons=[]
    if config.get('slot_required') and not any(s['name']==SLOT for s in own):
        reasons.append('main_slot_missing')
    if free<256*1024**3 or free/total<0.20: reasons.append('source_disk_headroom')
    if any(s.get('status') in ('lost','unreserved') for s in own): reasons.append('slot_continuity_lost_or_at_risk')
    if any(int(s.get('retained',0))>=48*1024**3 for s in own): reasons.append('retained_wal_48gib')
    return own,reasons

def query(sql):
    p=subprocess.run(['/usr/bin/psql','-X','-w','-At','-v','ON_ERROR_STOP=1','-d','zcash_explorer_mainnet','-c',sql],capture_output=True,text=True,timeout=12)
    if p.returncode: raise RuntimeError('database probe failed')
    return p.stdout

def stop_feed(own,run=query):
    # Slot names are independently validated here as well as in the policy.
    # A policy failure must never broaden a privileged administrative action.
    for slot in own:
        if slot['name'] != SLOT and not re.fullmatch(r'pg_[0-9]+_sync_[0-9]+_[0-9]+',slot['name']):
            raise ValueError('invalid slot name')
    run("BEGIN; SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='200ms'; ALTER ROLE ask_core_replicator NOLOGIN; COMMIT; SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='ask_core_replicator' AND pid<>pg_backend_pid();")
    pending=[]
    for slot in own:
        try: run("SET statement_timeout='3s'; SELECT pg_drop_replication_slot('"+slot['name']+"');")
        except RuntimeError: pending.append(slot['name'])
    return pending

def main():
    result={'observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'action':'none','external_alert_delivery':False}
    try:
        with open('/etc/zecblock-ask-feed/source-guard.json',encoding='utf8') as f: config=json.load(f)
        raw=query("""BEGIN READ ONLY; SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='200ms';
SELECT json_build_object('database',current_database(),'standby',pg_is_in_recovery(),
 'system_identifier',(SELECT system_identifier::text FROM pg_control_system()),
 'wal_level',current_setting('wal_level'),'wal_budget_mb',(SELECT setting FROM pg_settings WHERE name='max_slot_wal_keep_size'),
 'slots',(SELECT coalesce(json_agg(json_build_object('name',slot_name,'status',wal_status,
 'retained',coalesce(pg_wal_lsn_diff(pg_current_wal_lsn(),restart_lsn),0)::text)), '[]'::json) FROM pg_replication_slots)); ROLLBACK;""")
        report=json.loads(next(line for line in raw.splitlines() if line.startswith('{')))
        disk=os.statvfs('/var/lib/postgresql/16/main')
        own,reasons=decision(config,report,disk.f_bavail*disk.f_frsize,disk.f_blocks*disk.f_frsize)
        result['slots']=[{'name':s['name'],'retained_bytes':s['retained'],'status':s['status']} for s in own]
        result['reasons']=reasons
        if reasons:
            # No standby promotion, arbitrary role/slot input, transaction skipping,
            # source-data write or automatic recreation. Disable this login first,
            # terminate only its sessions, and release ONLY its reviewed slots.
            pending=stop_feed(own)
            result['action']='feed_login_disabled'
            if pending: result['slot_drop_pending']=pending
            result['requires_operator_reconciliation_or_resnapshot']=True
        print(json.dumps(result,sort_keys=True));return 0 if not reasons else 1
    except Exception as error:
        result['action']='probe_failed';result['error_class']=type(error).__name__
        print(json.dumps(result,sort_keys=True));return 1
if __name__=='__main__': sys.exit(main())
