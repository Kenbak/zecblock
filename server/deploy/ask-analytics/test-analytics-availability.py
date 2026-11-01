import importlib.util,pathlib,unittest,json,types
spec=importlib.util.spec_from_file_location('analytics_alerts',pathlib.Path(__file__).with_name('analytics-availability.py'));a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
class Probe(unittest.TestCase):
 READY={'activity_daily':True,'address_activity':True,'addresses':True,'block_timing':True,'daily':True,'flow_daily':True,'issuance_daily':True,'mining_daily':True,'orphaned_blocks':True,'reorgs':True,'software_daily':True,'supply_daily':True,'swaps':True}
 def runner(self,healthy=True,datasets=None,worker=True):
  datasets=dict(self.READY) if datasets is None else datasets
  def run(args,**kwargs):
   self.assertLessEqual(kwargs['timeout'],20)
   if args[0]=='/usr/bin/python3':return types.SimpleNamespace(stdout=json.dumps({'healthy':healthy}),returncode=0)
   if args[0]=='/usr/bin/psql':
    self.assertIn('BEGIN READ ONLY',args[-1]);self.assertIn("statement_timeout='2s'",args[-1]);return types.SimpleNamespace(stdout=json.dumps({'verified_at':'2026-10-12 00:00:00+00','datasets':datasets}),returncode=0)
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
  self.assertIn('admission, datasets and query worker checks passed',text)
  failed=a.notification_text('failure','datasets_unavailable')
  self.assertIn('research data readiness blocked',failed)
  self.assertIn('datasets_unavailable',failed)
  self.assertIn('Ask research must remain unavailable',failed)
  self.assertNotIn('restored',failed)
  source_text=a.alerts.notification_text('recovery','')
  self.assertIn('feed connection restored',source_text)
  self.assertNotIn('research data readiness restored',source_text.lower())
 def test_unreadable_probe_is_never_healthy(self):
  def broken(*args,**kwargs):raise RuntimeError('secret fixture is never output')
  errors,_,warming=a.probe(broken);self.assertEqual(errors,['analytics_probe_failed']);self.assertEqual(warming,[])
if __name__=='__main__':unittest.main()
