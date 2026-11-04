#!/usr/bin/python3
"""Private analytics checks and existing ops destination; never query content."""
import datetime,importlib.util,json,pathlib,subprocess,sys,time,os
spec=importlib.util.spec_from_file_location('alerts',pathlib.Path(__file__).with_name('source-availability.py'));alerts=importlib.util.module_from_spec(spec);spec.loader.exec_module(alerts)
SQL="""BEGIN READ ONLY; SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='200ms';
SELECT json_build_object('verified_at',(SELECT verified_at::text FROM analytics_public.coverage),
 'datasets_ready',(SELECT count(*)=6 AND bool_and(ready) FROM analytics_public.dataset_coverage)); ROLLBACK;"""
def probe(runner=subprocess.run):
    errors=[];verified=None
    try:
        health=runner(['/usr/bin/python3','/opt/zecblock-ask-operations/host-health.py','--stage','ready'],capture_output=True,text=True,timeout=20)
        if json.loads(health.stdout).get('healthy') is not True:errors.append('analytics_health_failed')
        output=runner(['/usr/bin/psql','-X','-w','-At','-v','ON_ERROR_STOP=1','-d','ask_analytics','-c',SQL],capture_output=True,text=True,check=True,timeout=5).stdout
        data=json.loads(next(line for line in output.splitlines() if line.startswith('{')));verified=data.get('verified_at')
        if data.get('datasets_ready') is not True:errors.append('datasets_unavailable')
        worker=runner(['/usr/bin/systemctl','is-active','zecblock-ask-analytics.service'],capture_output=True,text=True,timeout=3)
        if worker.returncode or worker.stdout.strip()!='active':errors.append('query_worker_unavailable')
    except Exception:errors=['analytics_probe_failed']
    return errors,verified

def notification_text(event,signature):
    if event=='recovery':return 'ZecBlock research data readiness restored: admission, datasets and query worker checks passed.'
    return 'ZecBlock research data readiness blocked. Checks: '+signature+'. Ask research must remain unavailable until freshness and isolation checks pass.'

def main():
    path=pathlib.Path('/var/lib/zecblock-ask-analytics-alerts/state.json');previous=json.loads(path.read_text()) if path.exists() else {}
    errors,verified=probe()
    now=time.time();state,event=alerts.transition(previous,errors,verified,now)
    if event:
        text=notification_text(event,state['signature'])
        try:alerts.telegram('sendMessage',{'text':text,'disable_web_page_preview':True},os.environ);state.update(notified='' if event=='recovery' else state['signature'],sent_at=now)
        except Exception:event='delivery_failed'
    path.parent.mkdir(mode=0o700,parents=True,exist_ok=True);temporary=path.with_suffix('.tmp');temporary.write_text(json.dumps(state));temporary.chmod(0o600);temporary.replace(path)
    print(json.dumps({'event':'analytics_health_alerts','observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'healthy':not state['signature'],'checks':state['signature'],'notification':event}))
    return 2 if event=='delivery_failed' else 1 if state['signature'] else 0
if __name__=='__main__':
    try:sys.exit(main())
    except Exception:print(json.dumps({'event':'analytics_health_alerts','status':'configuration_unavailable'}));sys.exit(2)
