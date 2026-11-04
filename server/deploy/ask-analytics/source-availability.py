#!/usr/bin/python3
"""Source-side availability alerts: existing private ops Telegram destination.
No recovery/slot mutation, visitor content, arbitrary SQL or raw error logging.
"""
import argparse,datetime,json,os,pathlib,re,subprocess,sys,time,urllib.request
SQL="""BEGIN READ ONLY; SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='200ms';
SELECT json_build_object('database',current_database(),'primary',NOT pg_is_in_recovery(),
 'identity',(SELECT system_identifier::text FROM pg_control_system()),
 'slot',(SELECT json_build_object('active',active,'status',wal_status,'confirmed',confirmed_flush_lsn::text,'retained_bytes',pg_wal_lsn_diff(pg_current_wal_lsn(),restart_lsn)) FROM pg_replication_slots WHERE slot_name='ask_public_core_v1'));
ROLLBACK;"""
def reasons(report,expected_identity):
    if not isinstance(report,dict) or report.get('database')!='zcash_explorer_mainnet' or report.get('primary') is not True or report.get('identity')!=expected_identity:
        return ['source_probe_failed']
    slot=report.get('slot')
    if not isinstance(slot,dict): return ['logical_slot_missing']
    errors=[]
    if slot.get('status') not in ('reserved','extended'): errors.append('logical_slot_unavailable')
    if slot.get('active') is not True: errors.append('subscriber_inactive')
    if not isinstance(slot.get('retained_bytes'),(int,float)) or slot['retained_bytes']<0 or slot['retained_bytes']>=48*1024**3: errors.append('retained_wal_pressure')
    if not re.fullmatch(r'[0-9A-F]+/[0-9A-F]+',slot.get('confirmed') or ''): errors.append('applied_progress_unknown')
    return errors

def transition(previous,errors,confirmed,now):
    state=dict(previous);progress_at=state.get('progress_at',now)
    if confirmed and confirmed!=state.get('confirmed'): progress_at=now
    if not errors and now-progress_at>=120: errors=['subscriber_progress_stalled']
    signature=','.join(sorted(errors));old=state.get('signature','')
    since=state.get('since',now) if signature and old else now
    # Ignore brief expected maintenance/reconnects. Persist pending failures.
    alert=bool(signature) and now-since>=120 and (state.get('notified')!=signature or now-state.get('sent_at',0)>=1800)
    recovery=not signature and bool(state.get('notified'))
    state.update(signature=signature,since=since,confirmed=confirmed or state.get('confirmed'),progress_at=progress_at)
    return state,'failure' if alert else 'recovery' if recovery else None

def notification_text(event,signature):
    if event=='recovery':return 'ZecBlock feed connection restored: subscriber connected and advancing. Research data readiness requires separate confirmation from the analytics monitor.'
    return 'ZecBlock feed health checks failed: '+signature+'. Stale data must not be served; review the replication recovery runbook. Research data readiness is reported separately by the analytics monitor.'

def telegram(method,payload,env,opener=urllib.request.urlopen):
    token=env.get('TELEGRAM_BOT_TOKEN','');chat=env.get('TELEGRAM_CHAT_ID','')
    if not re.fullmatch(r'\d+:[A-Za-z0-9_-]{20,}',token) or not re.fullmatch(r'-?\d+',chat): raise ValueError('Existing private ops destination required')
    body=json.dumps({'chat_id':chat,**payload}).encode()
    request=urllib.request.Request('https://api.telegram.org/bot'+token+'/'+method,data=body,headers={'Content-Type':'application/json'},method='POST')
    with opener(request,timeout=8) as response:
        data=json.load(response)
        if response.status!=200 or data.get('ok') is not True: raise ValueError('Delivery not acknowledged')
        return data.get('result')

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--test-notification',action='store_true');args=parser.parse_args()
    config=json.loads(pathlib.Path('/etc/zecblock-ask-feed/availability.json').read_text());identity=config['source_system_identifier']
    if not re.fullmatch(r'\d{10,25}',identity): raise ValueError('Verified source identity required')
    if args.test_notification:
        bot=telegram('getMe',{},os.environ);chat=telegram('getChat',{},os.environ)
        if bot.get('username')!='cipherscanalertbot' or chat.get('type')!='private': raise ValueError('Existing ops bot/destination mismatch')
        telegram('sendMessage',{'text':'ZecBlock analytics monitoring TEST: this private ops bot will alert if the analytics subscriber disconnects, stops advancing or puts retained WAL under pressure. This is a delivery test, not an outage.','disable_web_page_preview':True},os.environ)
        print(json.dumps({'event':'analytics_alert_delivery_test','acknowledged':True}));return
    path=pathlib.Path('/var/lib/zecblock-ask-availability/state.json');previous=json.loads(path.read_text()) if path.exists() else {};now=time.time()
    try:
        output=subprocess.run(['/usr/bin/psql','-X','-w','-At','-v','ON_ERROR_STOP=1','-d','zcash_explorer_mainnet','-c',SQL],check=True,capture_output=True,text=True,timeout=5).stdout
        report=json.loads(next(line for line in output.splitlines() if line.startswith('{')));errors=reasons(report,identity);confirmed=(report.get('slot') or {}).get('confirmed')
    except Exception: errors=['source_probe_failed'];confirmed=None
    state,event=transition(previous,errors,confirmed,now)
    if event:
        text=notification_text(event,state['signature'])
        try:
            telegram('sendMessage',{'text':text,'disable_web_page_preview':True},os.environ)
            state.update(notified='' if event=='recovery' else state['signature'],sent_at=now)
        except Exception:
            # Retry on the next check. Never persist a successful delivery claim.
            path.parent.mkdir(mode=0o700,parents=True,exist_ok=True);temporary=path.with_suffix('.tmp');temporary.write_text(json.dumps(state));temporary.chmod(0o600);temporary.replace(path)
            print(json.dumps({'event':'analytics_availability','status':'delivery_failed','checks':state['signature']}));return 2
    path.parent.mkdir(mode=0o700,parents=True,exist_ok=True);temporary=path.with_suffix('.tmp');temporary.write_text(json.dumps(state));temporary.chmod(0o600);temporary.replace(path)
    print(json.dumps({'event':'analytics_availability','observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'healthy':not state['signature'],'checks':state['signature'],'notification':event}));return 1 if state['signature'] else 0
if __name__=='__main__':
    try: sys.exit(main() or 0)
    except Exception: print(json.dumps({'event':'analytics_availability','status':'configuration_unavailable'}));sys.exit(2)
