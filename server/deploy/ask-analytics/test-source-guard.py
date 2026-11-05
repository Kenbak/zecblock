import importlib.util,unittest
spec=importlib.util.spec_from_file_location('guard',str(__import__('pathlib').Path(__file__).with_name('source-guard.py')));guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)
class Policy(unittest.TestCase):
 def setUp(self):
  self.cfg={'source_system_identifier':'123','sync_prefix':'pg_456_sync_'}
  self.report={'database':'zcash_explorer_mainnet','system_identifier':'123','standby':False,'wal_level':'logical','wal_budget_mb':'65536','slots':[{'name':'ask_public_core_v1','retained':'0','status':'reserved'},{'name':'pg_456_sync_789_123','retained':'2','status':'reserved'},{'name':'unrelated_slot','retained':str(100*1024**3),'status':'lost'}]}
 def decision(self,free=1024**4,total=2*1024**4):return guard.decision(self.cfg,self.report,free,total)
 def test_healthy_does_not_stop_other_slots(self):
  own,reasons=self.decision();self.assertEqual(len(own),2);self.assertEqual(reasons,[])
 def test_slot_and_disk_pressure(self):
  self.report['slots'][0]['retained']=str(48*1024**3);self.assertIn('retained_wal_48gib',self.decision()[1]);self.assertIn('source_disk_headroom',self.decision(255*1024**3)[1])
 def test_continuity_loss(self):
  self.report['slots'][0]['status']='lost';self.assertIn('slot_continuity_lost_or_at_risk',self.decision()[1])
 def test_refuse_identity_config_and_name_injection(self):
  for key,value in [('database','other'),('system_identifier','456'),('standby',True),('wal_level','replica'),('wal_budget_mb','-1')]:
   original=self.report[key];self.report[key]=value
   with self.assertRaises(ValueError):self.decision()
   self.report[key]=original
  self.cfg['sync_prefix']="pg_456_sync_';DROP DATABASE";
  with self.assertRaises(ValueError):self.decision()
 def test_numeric_prefix_scope_only(self):
  self.report['slots'].append({'name':'pg_456_sync_extra','retained':str(100*1024**3),'status':'lost'});self.assertEqual(self.decision()[1],[])
 def test_missing_required_slot(self):
  self.cfg['slot_required']=True
  self.report['slots']=[s for s in self.report['slots'] if s['name']!='ask_public_core_v1']
  self.assertIn('main_slot_missing',self.decision()[1])
 def test_invalid_slot_never_runs_admin_action(self):
  calls=[]
  with self.assertRaises(ValueError): guard.stop_feed([{'name':"evil';DROP DATABASE"}],calls.append)
  self.assertEqual(calls,[])
if __name__=='__main__': unittest.main()
