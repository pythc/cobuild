import unittest,copy,json
from pathlib import Path
import migration_policy as p
class TransferMigrationTests(unittest.TestCase):
 def fixture(self):
  plan=json.loads((Path(__file__).parent/'migrations/core-project-transfer-v1.json').read_text())
  a={'format':1,'schema':'a'*64,'runtime':'core-single-writer-v1','postgresMajor':17};b={**a,'schema':'b'*64}
  old={'contract':a,'images':{'core':{'id':'sha256:'+'a'*64}}}
  transition={'format':1,'kind':plan['kind'],'fromImage':old['images']['core']['id'],'fromContract':a,'plan':plan}
  transition['planDigest']=p.digest({'fromImage':transition['fromImage'],'fromContract':a,'toContract':b,'plan':plan})
  new={'contract':b,'migration':transition,'images':{'core':{'id':'sha256:'+'b'*64}}}
  before={'files':{k:v['before'] for k,v in plan['changes'].items() if v['before']}}
  after={'files':{k:v['after'] for k,v in plan['changes'].items()},'coreRunnerDigest':'d'*64}
  for path,key in [(p.CORE_SQL,'platform/0001_operations'),(p.CORE_WEKNOW,'weknow/20261029T120000-suite-managed-spaces')]:before['files'][path]=after['files'][path]=plan['ledger'][key]
  return old,new,before,after
 def test_retains_baseline_ledger_and_appends_exact_transfer(self):
  old,new,before,after=self.fixture();e=p.authorize_transition(old,new,before,after)
  self.assertEqual(len(e['baseLedger']),2);self.assertEqual(list(e['newLedger']),['platform/0002_project_transfers'])
  self.assertFalse(p.reconcile_history(e['baseLedger'],e['newLedger'],e['baseLedger'])['complete'])
  self.assertTrue(p.reconcile_history(e['baseLedger'],e['newLedger'],{**e['baseLedger'],**e['newLedger']})['complete'])
  with self.assertRaises(p.PolicyError):p.reconcile_history(e['baseLedger'],e['newLedger'],e['newLedger'])
 def test_no_unplanned_changes_or_old_migration_rewrites(self):
  old,new,before,after=self.fixture()
  for path in [p.CORE_SQL,p.CORE_WEKNOW,'apps/platform/server/another-store.mjs']:
   bad=copy.deepcopy(after);bad['files'][path]='f'*64
   with self.assertRaises(p.PolicyError):p.authorize_transition(old,new,before,bad)
 def test_old_binary_denied_after_new_table_commits(self):
  old,new,before,after=self.fixture();e=p.authorize_transition(old,new,before,after)
  self.assertEqual(p.compatible_schemas(new['migration'],'a','b',list(e['newLedger']),True),['b'])
  self.assertEqual(p.compatible_schemas(new['migration'],'a','b',list(e['newLedger']),False),[])
 def test_persisted_state_cannot_drop_retained_history(self):
  old,new,before,after=self.fixture();e=p.authorize_transition(old,new,before,after)
  state={'format':1,'status':'complete','baseContract':old['contract'],'targetContract':new['contract'],'targetImage':new['images']['core']['id'],'transition':new['migration'],**e,'applied':sorted(e['newLedger']),'complete':True,'actualSchema':new['contract']['schema'],'compatibleSchemas':[new['contract']['schema']]}
  self.assertEqual(p.validate_state(state),state)
  state['baseLedger']={}
  with self.assertRaises(p.PolicyError):p.validate_state(state)
