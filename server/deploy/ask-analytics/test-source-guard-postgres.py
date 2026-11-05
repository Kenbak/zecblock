import importlib.util, pathlib, subprocess, tempfile, shutil, json, os
spec=importlib.util.spec_from_file_location('guard',str(pathlib.Path(__file__).with_name('source-guard.py'))); guard=importlib.util.module_from_spec(spec); spec.loader.exec_module(guard)
bin=pathlib.Path(os.environ['ASK_LOGICAL_PG_BIN']);
assert bin.is_absolute(), 'Explicit absolute PG16 binary directory required'
root=pathlib.Path(tempfile.mkdtemp(prefix='ask-guard-proof-'));root.chmod(0o700); sock=root/'socket';sock.mkdir(mode=0o700); data=root/'pg';started=False

def cmd(tool,args): return subprocess.run([str(bin/tool)]+args,check=True,capture_output=True,text=True,timeout=20).stdout

def sql(text,user='fixture_admin'):
 p=subprocess.run([str(bin/'psql'),'-X','-w','-At','-v','ON_ERROR_STOP=1','-h',str(sock),'-d','postgres','-U',user,'-c',text],capture_output=True,text=True,timeout=12)
 if p.returncode: raise RuntimeError('fixture SQL failed')
 return p.stdout.strip()
try:
 assert cmd('postgres',['--version']).startswith('postgres (PostgreSQL) 16.'), 'PG16 required'
 cmd('initdb',['-D',str(data),'-U','fixture_admin','-A','trust','--no-locale'])
 with (data/'postgresql.conf').open('a') as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(sock)+"'\nwal_level=logical\nmax_replication_slots=8\nshared_buffers='32MB'\n")
 cmd('pg_ctl',['-D',str(data),'-l',str(root/'pg.log'),'-w','start']);started=True
 sql("CREATE ROLE ask_core_replicator LOGIN REPLICATION; CREATE ROLE unrelated_operator LOGIN; CREATE TABLE fixture_evidence(id int primary key); INSERT INTO fixture_evidence VALUES(7);")
 for name in ('ask_public_core_v1','pg_456_sync_789_123','unrelated_logical_slot'):
  sql("SELECT pg_create_logical_replication_slot('"+name+"','pgoutput');")
 sql("SELECT pg_create_physical_replication_slot('unrelated_standby');")
 # Hold actual separate sessions. Terminating the dedicated role must preserve the other.
 own=subprocess.Popen([str(bin/'psql'),'-X','-w','-h',str(sock),'-d','postgres','-U','ask_core_replicator','-c','SELECT pg_sleep(20)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 other=subprocess.Popen([str(bin/'psql'),'-X','-w','-h',str(sock),'-d','postgres','-U','unrelated_operator','-c','SELECT pg_sleep(20)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 import time
 for _ in range(30):
  if sql("SELECT count(*) FROM pg_stat_activity WHERE usename IN ('ask_core_replicator','unrelated_operator')")=='2':break
  time.sleep(.05)
 assert sql("SELECT count(*) FROM pg_stat_activity WHERE usename IN ('ask_core_replicator','unrelated_operator')")=='2'
 cfg={'source_system_identifier':'123','sync_prefix':'pg_456_sync_','slot_required':True}
 report={'system_identifier':'123','database':'zcash_explorer_mainnet','standby':False,'wal_level':'logical','wal_budget_mb':'65536','slots':[{'name':n,'retained':'0','status':'reserved'} for n in ('ask_public_core_v1','pg_456_sync_789_123','unrelated_logical_slot','unrelated_standby')]}
 scoped,reasons=guard.decision(cfg,report,255*1024**3,2*1024**4);assert reasons==['source_disk_headroom']
 assert guard.stop_feed(scoped,sql)==[]
 own.wait(timeout=5)
 assert sql("SELECT rolcanlogin FROM pg_roles WHERE rolname='ask_core_replicator'")=='f'
 assert sql("SELECT rolcanlogin FROM pg_roles WHERE rolname='unrelated_operator'")=='t'
 assert sql("SELECT count(*) FROM pg_stat_activity WHERE usename='unrelated_operator'")=='1'
 assert set(sql('SELECT slot_name FROM pg_replication_slots').splitlines())=={'unrelated_logical_slot','unrelated_standby'}
 assert sql('SELECT id FROM fixture_evidence')=='7'
 other.terminate();other.wait(timeout=5)
 print(json.dumps({'postgres':'16.15','healthy_scope':True,'real_low_disk_action_verified':True,'dedicated_login_disabled':True,'dedicated_session_terminated':True,'unrelated_login_session_slots_preserved':True,'source_fixture_rows_unchanged':True,'external_alert_delivery':False}))
finally:
 for name in ('own','other'):
  proc=locals().get(name)
  if proc and proc.poll() is None:proc.terminate();proc.wait(timeout=5)
 if started:cmd('pg_ctl',['-D',str(data),'-m','fast','-w','stop'])
 shutil.rmtree(root)
