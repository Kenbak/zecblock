#!/usr/bin/python3
"""Private analytics checks and existing ops destination; never query content."""
import datetime,importlib.util,json,pathlib,subprocess,sys,time,os
spec=importlib.util.spec_from_file_location('alerts',pathlib.Path(__file__).with_name('source-availability.py'));alerts=importlib.util.module_from_spec(spec);spec.loader.exec_module(alerts)
# Datasets research depends on. Name them instead of counting rows: a newly
# migrated dataset adds a dataset_coverage row and stays unready while it
# backfills, which must not block research. Add a dataset here only once its
# rollout is verified and it is published in lib/ask/research-catalogue.js.
REQUIRED_DATASETS=('activity_daily','address_activity','addresses','block_timing','daily','flow_daily','issuance_daily','mining_daily','orphaned_blocks','reorgs','software_daily','supply_daily','swaps')
# feed-recovery.py blocks with copy_incomplete unless its reviewed relation list
# equals the subscribed tables; a dataset rollout that adds a table must update
# both (2026-10-31 to 11-01: recovery silently blocked after batch 1).
RECOVERY_CONFIG=pathlib.Path('/etc/zecblock-ask-recovery/config.json')
SQL="""BEGIN READ ONLY; SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='200ms';
SELECT json_build_object('verified_at',(SELECT verified_at::text FROM analytics_public.coverage),
 'datasets',(SELECT coalesce(json_object_agg(dataset,ready IS TRUE),'{}'::json) FROM analytics_public.dataset_coverage),
 'relations',(SELECT coalesce(json_agg(n.nspname||'.'||c.relname),'[]'::json) FROM pg_subscription_rel r JOIN pg_subscription s ON s.oid=r.srsubid JOIN pg_class c ON c.oid=r.srrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE s.subname='ask_public_core_v1')); ROLLBACK;"""

def dataset_errors(datasets):
    """Required datasets must exist and be ready; others are reported, never alerted."""
    if not isinstance(datasets,dict) or any(type(ready) is not bool for ready in datasets.values()):return ['datasets_unavailable'],[]
    missing=[name for name in REQUIRED_DATASETS if datasets.get(name) is not True]
    warming=sorted(name for name,ready in datasets.items() if name not in REQUIRED_DATASETS and not ready)
    return (['datasets_unavailable'] if missing else []),warming
def recovery_errors(relations,config_path=RECOVERY_CONFIG):
    """An installed recovery config must list exactly the subscribed tables."""
    if not config_path.exists():return []
    try:expected=json.loads(config_path.read_text())['expected_relations']
    except Exception:return ['recovery_config_unreadable']
    if not isinstance(relations,list) or not isinstance(expected,list) or set(expected)!=set(relations):return ['recovery_relations_drift']
    return []
def probe(runner=subprocess.run,config_path=RECOVERY_CONFIG):
    errors=[];verified=None;warming=[]
    try:
        health=runner(['/usr/bin/python3','/opt/zecblock-ask-operations/host-health.py','--stage','ready'],capture_output=True,text=True,timeout=20)
        if json.loads(health.stdout).get('healthy') is not True:errors.append('analytics_health_failed')
        output=runner(['/usr/bin/psql','-X','-w','-At','-v','ON_ERROR_STOP=1','-d','ask_analytics','-c',SQL],capture_output=True,text=True,check=True,timeout=5).stdout
        data=json.loads(next(line for line in output.splitlines() if line.startswith('{')));verified=data.get('verified_at')
        dataset_failures,warming=dataset_errors(data.get('datasets'));errors.extend(dataset_failures)
        errors.extend(recovery_errors(data.get('relations'),config_path))
        worker=runner(['/usr/bin/systemctl','is-active','zecblock-ask-analytics.service'],capture_output=True,text=True,timeout=3)
        if worker.returncode or worker.stdout.strip()!='active':errors.append('query_worker_unavailable')
    except Exception:errors=['analytics_probe_failed'];warming=[]
    return errors,verified,warming

def notification_text(event,signature):
    if event=='recovery':return 'ZecBlock research data readiness restored: admission, datasets and query worker checks passed.'
    return 'ZecBlock research data readiness blocked. Checks: '+signature+'. Ask research must remain unavailable until freshness and isolation checks pass.'

def main():
    path=pathlib.Path('/var/lib/zecblock-ask-analytics-alerts/state.json');previous=json.loads(path.read_text()) if path.exists() else {}
    errors,verified,warming=probe()
    now=time.time();state,event=alerts.transition(previous,errors,verified,now)
    if event:
        text=notification_text(event,state['signature'])
        try:alerts.telegram('sendMessage',{'text':text,'disable_web_page_preview':True},os.environ);state.update(notified='' if event=='recovery' else state['signature'],sent_at=now)
        except Exception:event='delivery_failed'
    path.parent.mkdir(mode=0o700,parents=True,exist_ok=True);temporary=path.with_suffix('.tmp');temporary.write_text(json.dumps(state));temporary.chmod(0o600);temporary.replace(path)
    print(json.dumps({'event':'analytics_health_alerts','observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'healthy':not state['signature'],'checks':state['signature'],'warming_datasets':warming,'notification':event}))
    return 2 if event=='delivery_failed' else 1 if state['signature'] else 0
if __name__=='__main__':
    try:sys.exit(main())
    except Exception:print(json.dumps({'event':'analytics_health_alerts','status':'configuration_unavailable'}));sys.exit(2)
