import importlib.util,pathlib,unittest,json,io
spec=importlib.util.spec_from_file_location('availability',pathlib.Path(__file__).with_name('source-availability.py'));a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
class Availability(unittest.TestCase):
 def test_probe_boundaries(self):
  good={'database':'zcash_explorer_mainnet','primary':True,'identity':'12345678900','slot':{'active':True,'status':'extended','confirmed':'10C/E01','retained_bytes':10}}
  self.assertEqual(a.reasons(good,'12345678900'),[])
  for change in [{'identity':'other'},{'primary':False},{'slot':None}]: self.assertTrue(a.reasons({**good,**change},'12345678900'))
  self.assertIn('subscriber_inactive',a.reasons({**good,'slot':{**good['slot'],'active':False}},'12345678900'))
  self.assertIn('retained_wal_pressure',a.reasons({**good,'slot':{**good['slot'],'retained_bytes':48*1024**3}},'12345678900'))
 def test_delay_dedup_recovery_and_progress(self):
  s,event=a.transition({},['subscriber_inactive'],'A/1',0);self.assertIsNone(event)
  s,event=a.transition(s,['subscriber_inactive'],'A/1',119);self.assertIsNone(event)
  s,event=a.transition(s,['subscriber_inactive'],'A/1',120);self.assertEqual(event,'failure')
  s.update(notified=s['signature'],sent_at=120)
  s,event=a.transition(s,['subscriber_inactive'],'A/1',121);self.assertIsNone(event)
  s,event=a.transition(s,[],'A/2',122);self.assertEqual(event,'recovery')
  s.update(notified='');s,event=a.transition(s,[],'A/2',242);self.assertIn('stalled',s['signature']);self.assertIsNone(event)
  s,event=a.transition(s,[],'A/3',243);self.assertEqual(s['signature'],'')
 def test_changing_failure_codes_do_not_restart_the_delay(self):
  s,event=a.transition({},['subscriber_inactive'],'A/1',0)
  s,event=a.transition(s,['source_probe_failed'],'A/1',60);self.assertIsNone(event)
  s,event=a.transition(s,['source_probe_failed'],'A/1',120);self.assertEqual(event,'failure')
 def test_source_recovery_reports_connection_without_claiming_research_readiness(self):
  text=a.notification_text('recovery','')
  self.assertIn('feed connection restored',text)
  self.assertIn('subscriber connected and advancing',text)
  self.assertIn('readiness requires separate confirmation from the analytics monitor',text)
  self.assertNotIn('research data readiness restored',text.lower())
  self.assertNotIn('research recovered',text.lower())
  failed=a.notification_text('failure','subscriber_inactive')
  self.assertIn('subscriber_inactive',failed)
  self.assertIn('Stale data must not be served',failed)
  self.assertIn('reported separately by the analytics monitor',failed)
 def test_http_success_alone_is_not_delivery(self):
  env={'TELEGRAM_BOT_TOKEN':'123:'+('a'*25),'TELEGRAM_CHAT_ID':'-123'}
  class Response(io.BytesIO):
   status=200
  for payload in [{'ok':False},{'ok':True,'result':{'message_id':1}}]:
   def opener(request,timeout):
    self.assertEqual(timeout,8);self.assertTrue(request.full_url.startswith('https://api.telegram.org/'));return Response(json.dumps(payload).encode())
   if not payload['ok']:
    with self.assertRaises(ValueError):a.telegram('sendMessage',{'text':'test'},env,opener)
   else:self.assertEqual(a.telegram('sendMessage',{'text':'test'},env,opener)['message_id'],1)
if __name__=='__main__':unittest.main()
