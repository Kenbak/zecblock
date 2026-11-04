import importlib.util,pathlib,unittest
spec=importlib.util.spec_from_file_location('health',str(pathlib.Path(__file__).with_name('host-health.py')));health=importlib.util.module_from_spec(spec);spec.loader.exec_module(health)
class Monitor(unittest.TestCase):
 def setUp(self):self.db={'subscriptions':1,'ready':False,'state':'copying','subscription_enabled':True,'apply_worker_active':True,'apply_errors':0,'sync_errors':0}
 def test_known_stages_only(self):
  self.assertEqual(health.stage_alerts(self.db,'copying'),[])
  with self.assertRaises(ValueError):health.stage_alerts(self.db,'unknown')
  self.assertTrue(health.stage_alerts(self.db,'bootstrap'))
 def test_no_admission_by_copy_completion(self):
  self.db['state']='reconciling';self.assertEqual(health.stage_alerts(self.db,'copying'),[])
  self.db['ready']=True;self.assertIn('copy_stage_boundary_failed',health.stage_alerts(self.db,'copying'))
 def test_replication_errors_disabled_or_missing_worker_alert(self):
  for field,value in [('subscription_enabled',False),('apply_worker_active',False),('apply_errors',1),('sync_errors',1)]:
   db=self.db.copy();db[field]=value
   self.assertIn('copy_replication_unhealthy',health.stage_alerts(db,'copying'))
 def test_admitted_reader_stage(self):
  db=self.db.copy();db.update(ready=True,state='ready');self.assertEqual(health.stage_alerts(db,'ready'),[])
  db['ready']=False;self.assertIn('admission_not_ready',health.stage_alerts(db,'ready'))
 def test_bootstrap_defaults_dormant(self):
  self.assertEqual(health.stage_alerts({'subscriptions':0,'ready':False,'state':'uninitialized'},'bootstrap'),[])
 def test_acknowledged_history_remains_visible_without_hiding_new_errors(self):
  db=self.db.copy();db.update(ready=True,state='ready',apply_errors=1,errors_acknowledged=True)
  self.assertEqual(health.stage_alerts(db,'ready'),[])
  self.assertEqual(db['apply_errors'],1)
  for changes in [dict(errors_acknowledged=False),dict(errors_acknowledged=None),dict(errors_acknowledged='true'),dict(sync_errors=1),dict(subscription_enabled=False),dict(apply_worker_active=False)]:
   self.assertIn('ready_replication_unhealthy',health.stage_alerts(dict(db,**changes),'ready'))
  db.update(apply_errors=0,errors_acknowledged=False)
  self.assertIn('ready_replication_unhealthy',health.stage_alerts(db,'ready'))
 def test_helper_selection_falls_back_only_when_absent(self):
  def run(answer):
   def probe(args):
    self.assertIn("statement_timeout='2s'",args[-1]);self.assertIn('to_regprocedure',args[-1]);return answer
   return probe
  self.assertEqual(health.replication_error_sql(run('SET\nt')),'analytics_meta.replication_errors_acknowledged()')
  self.assertIn('sum(apply_error_count+sync_error_count)',health.replication_error_sql(run('f')))
  for answer in ['','unknown','NULL']:
   with self.assertRaises((ValueError,IndexError)):health.replication_error_sql(run(answer))
  def broken(args):raise RuntimeError('helper probe unavailable')
  with self.assertRaises(RuntimeError):health.replication_error_sql(broken)
if __name__=='__main__':unittest.main()
