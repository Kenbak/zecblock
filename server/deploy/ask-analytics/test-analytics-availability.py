import importlib.util,pathlib,unittest,json,types,tempfile,re
spec=importlib.util.spec_from_file_location('analytics_alerts',pathlib.Path(__file__).with_name('analytics-availability.py'));a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
REPO=pathlib.Path(__file__).parents[3]
CATALOGUE=(REPO/'server/api/v1/lib/ask-core-catalogue.js').read_text()
VIEWS=re.findall(r"'([a-z_]+)'",re.search(r"coreViews=Object\.freeze\(\[([^\]]*)\]\)",CATALOGUE).group(1))
def access(names=VIEWS,**extra):return [dict({'schema':'analytics_public','name':n,'kind':'v','write':False},**extra) for n in names]
class Probe(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.tmp=tempfile.TemporaryDirectory();cls.build=pathlib.Path(cls.tmp.name)/'build'
  (cls.build/'server/api/v1/lib').mkdir(parents=True);(cls.build/a.WORKER_CATALOGUE).write_text(CATALOGUE)
 @classmethod
 def tearDownClass(cls):cls.tmp.cleanup()
 READY={'activity_daily':True,'address_activity':True,'addresses':True,'block_timing':True,'daily':True,'flow_daily':True,'issuance_daily':True,'mining_daily':True,'orphaned_blocks':True,'reorgs':True,'software_daily':True,'supply_daily':True,'swap_daily':True,'swaps':True,'utxo_daily':True,'value_pools_daily':True}
 def runner(self,healthy=True,datasets=None,worker=True,reader=None,build=None):
  datasets=dict(self.READY) if datasets is None else datasets
  reader=access() if reader is None else reader;build=str(self.build) if build is None else build
  def run(args,**kwargs):
   self.assertLessEqual(kwargs['timeout'],20)
   if args[0]=='/usr/bin/python3':return types.SimpleNamespace(stdout=json.dumps({'healthy':healthy}),returncode=0)
   if args[0]=='/usr/bin/psql':
    self.assertIn('BEGIN READ ONLY',args[-1]);self.assertIn("statement_timeout='2s'",args[-1]);return types.SimpleNamespace(stdout=json.dumps({'verified_at':'2026-10-12 00:00:00+00','datasets':datasets,'reader_access':reader}),returncode=0)
   if args[1]=='show':self.assertEqual(args[-1],a.WORKER_UNIT);return types.SimpleNamespace(stdout=build+'\n',returncode=0)
   return types.SimpleNamespace(stdout='active' if worker else 'inactive',returncode=0 if worker else 1)
  return run
 def test_admission_datasets_and_worker_all_required(self):
  self.assertEqual(a.probe(self.runner())[0],[])
  for args,code in [({'healthy':False},'analytics_health_failed'),({'datasets':dict(self.READY,swaps=False)},'datasets_unavailable'),({'worker':False},'query_worker_unavailable')]:self.assertIn(code,a.probe(self.runner(**args))[0])
 def test_added_dataset_rows_never_block_research(self):
  # The 2026-10-31 incident: a seventh, warming row tripped count(*)=6.
  errors,_,warming=a.probe(self.runner(datasets=dict(self.READY,address_daily=False,future_daily=True)))
  self.assertEqual(errors,[]);self.assertEqual(warming,['address_daily'])
 def test_missing_or_malformed_required_dataset_alerts(self):
  for datasets in [{k:v for k,v in self.READY.items() if k!='daily'},{},None,[],dict(self.READY,daily='t'),dict(self.READY,flow_daily=None)]:
   self.assertEqual(a.probe(self.runner(datasets=datasets if datasets is not None else 'absent'))[0],['datasets_unavailable'])
 def test_required_set_matches_published_catalogue(self):
  catalogue=(pathlib.Path(__file__).parents[3]/'lib/ask/research-catalogue.js').read_text()
  import re
  # Core-gated datasets (blocks, transactions, flows, labels, issuance) have no dataset_coverage row.
  core=set(re.findall(r"'([a-z_]+)'",re.search(r"coreGatedIds=Object\.freeze\(\[\.\.\.coreIds,([^\]]*)\]",catalogue).group(1)))|{'blocks','transactions','flows'}
  published=set(re.findall(r"\{id:'([a-z_]+)',(?!published:false)",catalogue))-core
  self.assertEqual(set(a.REQUIRED_DATASETS),published)
 def test_analytics_alone_reports_research_data_readiness(self):
  text=a.notification_text('recovery','')
  self.assertIn('research data readiness restored',text)
  self.assertIn('admission, datasets, query worker and reader guard checks passed',text)
  failed=a.notification_text('failure','datasets_unavailable')
  self.assertIn('research data readiness blocked',failed)
  self.assertIn('datasets_unavailable',failed)
  self.assertIn('Ask research must remain unavailable',failed)
  self.assertNotIn('restored',failed)
  source_text=a.alerts.notification_text('recovery','')
  self.assertIn('feed connection restored',source_text)
  self.assertNotIn('research data readiness restored',source_text.lower())
 def test_recovery_config_must_match_subscribed_tables(self):
  import tempfile
  subscribed=['public.blocks','public.fork_events']
  with tempfile.TemporaryDirectory() as d:
   path=pathlib.Path(d)/'config.json'
   self.assertEqual(a.recovery_errors(subscribed,path),[])  # recovery not installed
   path.write_text(json.dumps({'expected_relations':['public.fork_events','public.blocks']}))
   self.assertEqual(a.recovery_errors(subscribed,path),[])
   # The 2026-10-31 incident: a rollout added a table but not to the recovery config.
   for relations in [subscribed+['public.orphaned_blocks'],['public.blocks'],None]:
    self.assertEqual(a.recovery_errors(relations,path),['recovery_relations_drift'])
   path.write_text('{')
   self.assertEqual(a.recovery_errors(subscribed,path),['recovery_config_unreadable'])
   path.write_text(json.dumps({'expected_relations':['public.blocks']}))
   self.assertIn('recovery_relations_drift',a.probe(self.runner(),path)[0])
 def test_reader_access_must_match_running_worker_views(self):
  self.assertEqual(a.worker_views(self.build),set(VIEWS))
  self.assertIn('swap_daily_query',VIEWS)
  self.assertEqual(a.probe(self.runner())[0],[])
  self.assertEqual(a.probe(self.runner(reader=access(VIEWS[:3])))[0],[])  # a missing grant fails only that dataset
  # The 2026-11-02 incident: the reader could read a view the running build did not list.
  self.assertEqual(a.probe(self.runner(reader=access()+access(['future_daily_query'])))[0],['reader_view_drift'])
  for bad in [access(['blocks'],kind='r'),access(['blocks'],schema='public'),access(['blocks'],write=True),['blocks'],[None]]:
   self.assertEqual(a.probe(self.runner(reader=access()+bad))[0],['reader_view_drift'],bad)
 def test_unknown_worker_views_or_reader_access_are_never_healthy(self):
  self.assertEqual(a.probe(self.runner(build='/nonexistent'))[0],['reader_guard_unverifiable'])
  for reader in ['absent',{},None]:
   run=self.runner();base=run
   def patched(args,**kwargs):
    out=base(args,**kwargs)
    if args[0]=='/usr/bin/psql':data=json.loads(out.stdout);data['reader_access']=reader;out.stdout=json.dumps(data)
    return out
   self.assertEqual(a.probe(patched)[0],['reader_guard_unverifiable'],reader)
  with tempfile.TemporaryDirectory() as d:
   (pathlib.Path(d)/'server/api/v1/lib').mkdir(parents=True);(pathlib.Path(d)/a.WORKER_CATALOGUE).write_text('module.exports={}')
   self.assertEqual(a.probe(self.runner(build=d))[0],['reader_guard_unverifiable'])
 def test_unreadable_probe_is_never_healthy(self):
  def broken(*args,**kwargs):raise RuntimeError('secret fixture is never output')
  errors,_,warming=a.probe(broken);self.assertEqual(errors,['analytics_probe_failed']);self.assertEqual(warming,[])
if __name__=='__main__':unittest.main()
