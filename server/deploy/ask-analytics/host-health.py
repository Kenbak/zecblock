#!/usr/bin/python3
"""Fixed, read-only new-host checks. Journal-only: no external alert delivery."""
import argparse,datetime,json,os,stat,subprocess,sys

def command(args):
    return subprocess.run(args,check=True,capture_output=True,text=True,timeout=8).stdout.strip()

def replication_errors_clear(db):
    # Keep historical counters visible; only the operator helper can acknowledge
    # their exact epoch/counts. Older fixture reports keep the zero-only rule.
    if db['sync_errors']!=0: return False
    if 'errors_acknowledged' in db: return db['errors_acknowledged'] is True
    return db['apply_errors']==0 and db['sync_errors']==0

def replication_error_sql(run=command):
    installed=run(['/usr/bin/psql','-X','-w','-At','-v','ON_ERROR_STOP=1','-d','ask_analytics','-c',
        "SET statement_timeout='2s'; SELECT to_regprocedure('analytics_meta.replication_errors_acknowledged()') IS NOT NULL;"])
    result=installed.splitlines()[-1]
    if result not in ('t','f'): raise ValueError('unknown recovery helper availability')
    return 'analytics_meta.replication_errors_acknowledged()' if result=='t' else '(SELECT coalesce(sum(apply_error_count+sync_error_count),0)=0 FROM pg_stat_subscription_stats)'

def stage_alerts(db,stage):
    if stage=='bootstrap':
        return ['bootstrap_stage_changed_review_monitor_policy'] if db['subscriptions'] or db['ready'] or db['state']!='uninitialized' else []
    if stage=='ready':
        alerts=[]
        if db['subscriptions']!=1 or not db['ready'] or db['state']!='ready': alerts.append('admission_not_ready')
        if not db['subscription_enabled'] or not db['apply_worker_active'] or not replication_errors_clear(db): alerts.append('ready_replication_unhealthy')
        return alerts
    if stage!='copying': raise ValueError('unknown health stage')
    alerts=[]
    if db['subscriptions']!=1 or db['ready'] or db['state'] not in ('copying','reconciling'):
        alerts.append('copy_stage_boundary_failed')
    if not db['subscription_enabled'] or not db['apply_worker_active'] or not replication_errors_clear(db):
        alerts.append('copy_replication_unhealthy')
    return alerts

def main(stage):
    report={'observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'checks':{},'alerts':[]}
    try:
        md=open('/proc/mdstat',encoding='utf8').read()
        arrays=[line for line in md.splitlines() if 'blocks super' in line]
        report['checks']['mirrors_healthy']=len(arrays)==4 and all('[UU]' in line for line in arrays)
        report['checks']['mirror_sync_pending']=any(word in md for word in ('resync =','recovery =','reshape =','check ='))
        disk=os.statvfs('/srv')
        free=disk.f_bavail*disk.f_frsize
        total=disk.f_blocks*disk.f_frsize
        report['checks']['data_free_bytes']=free
        report['checks']['data_capacity_ok']=free>=128*1024**3 and free/total>=0.15
        sql="""BEGIN READ ONLY; SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='200ms';
    SELECT json_build_object('database',current_database(),'directory',current_setting('data_directory'),
     'listener_private',current_setting('listen_addresses')='',
     'socket_private',current_setting('unix_socket_permissions')='0700',
     'reader_active',(SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit AND rolconnlimit BETWEEN 1 AND 16 FROM pg_roles WHERE rolname='ask_public_reader'),
     'subscriptions',(SELECT count(*) FROM pg_subscription),
     'subscription_enabled',(SELECT bool_and(subenabled AND subdisableonerr AND NOT subrunasowner AND subname='ask_public_core_v1') FROM pg_subscription),
     'apply_worker_active',(SELECT count(*)=1 FROM pg_stat_subscription WHERE relid IS NULL AND pid IS NOT NULL AND subname='ask_public_core_v1'),
     'apply_errors',(SELECT coalesce(sum(apply_error_count),0) FROM pg_stat_subscription_stats),
     'sync_errors',(SELECT coalesce(sum(sync_error_count),0) FROM pg_stat_subscription_stats),
     'errors_acknowledged',__ERRORS_ACKNOWLEDGED__,
     'ready',(SELECT ready FROM analytics_public.coverage),
     'state',(SELECT state FROM analytics_public.coverage),
     'reader_dormant',(SELECT NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls FROM pg_roles WHERE rolname='ask_public_reader'),
     'reader_memberships',(SELECT count(*) FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='ask_public_reader')));
    ROLLBACK;""".replace('__ERRORS_ACKNOWLEDGED__',replication_error_sql())
        raw=command(['/usr/bin/psql','-X','-w','-At','-v','ON_ERROR_STOP=1','-d','ask_analytics','-c',sql])
        db=json.loads(next(line for line in raw.splitlines() if line.startswith('{')))
        report['checks']['database']=db
        if stage=='ready':
            admin=os.stat('/var/run/postgresql'); public=os.stat('/run/ask-public-db')
            db['socket_private']=stat.S_IMODE(admin.st_mode)&0o777==0o700 and stat.S_IMODE(public.st_mode)==0o750
        report['checks']['bootstrap_database_boundary_ok']=all((db['database']=='ask_analytics',db['directory']=='/srv/analytics/postgresql/16/main',db['listener_private'],db['socket_private'],db['reader_active'] if stage=='ready' else db['reader_dormant'],db['reader_memberships']==0))
        report['checks']['transport_active']=command(['/usr/bin/systemctl','is-active','zecblock-ask-source-transport.service'])=='active'
        sock=os.stat('/run/ask-source-transport/.s.PGSQL.15432')
        report['checks']['transport_socket_private']=stat.S_ISSOCK(sock.st_mode) and stat.S_IMODE(sock.st_mode)==0o660 and sock.st_gid==os.getgid()
        report['alerts'].extend(stage_alerts(db,stage))
        for key in ('mirrors_healthy','data_capacity_ok','bootstrap_database_boundary_ok','transport_active','transport_socket_private'):
            if report['checks'][key] is not True: report['alerts'].append(key)
    except Exception as error:
        # Do not emit arbitrary SQL, credential-bearing messages or subprocess stderr.
        report['alerts'].append('probe_failed:'+type(error).__name__)
    report['healthy']=not report['alerts']
    report['external_alert_delivery']=False
    print(json.dumps(report,sort_keys=True))
    sys.exit(0 if report['healthy'] else 1)

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--stage',choices=('bootstrap','copying','ready'),default='bootstrap')
    main(parser.parse_args().stage)
