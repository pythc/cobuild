import unittest,copy,json
from pathlib import Path
import migration_policy as p

class CoreMigrationTests(unittest.TestCase):
 def fixture(self):
  plan=json.loads((Path(__file__).parent/'migrations/core-managed-v1.json').read_text())
  a={'format':1,'schema':'a'*64,'runtime':'core-single-writer-v1','postgresMajor':17};b={**a,'schema':'b'*64}
  before={k:v['before'] for k,v in plan['changes'].items() if v['before']};after={k:v['after'] for k,v in plan['changes'].items()}
  before['unchanged']='c'*64;after['unchanged']='c'*64
  old={'contract':a,'images':{'core':{'id':'sha256:'+'a'*64}}}
  transition={'format':1,'kind':'core-managed-v1','fromImage':old['images']['core']['id'],'fromContract':a,'plan':plan}
  transition['planDigest']=p.digest({'fromImage':transition['fromImage'],'fromContract':a,'toContract':b,'plan':plan})
  new={'contract':b,'migration':transition,'images':{'core':{'id':'sha256:'+'b'*64}}}
  return old,new,{'files':before},{'files':after,'migrationRunner':True,'coreRunnerDigest':'d'*64}
 def test_exact_file_inventory_and_checksum_required(self):
  old,new,before,after=self.fixture();e=p.authorize_transition(old,new,before,after)
  self.assertEqual(e['baseLedger'],{});self.assertEqual(len(e['newLedger']),2)
  for path,value in [('unchanged','e'*64),('unplanned','e'*64)]:
   bad=copy.deepcopy(after);bad['files'][path]=value
   with self.assertRaises(p.PolicyError):p.authorize_transition(old,new,before,bad)
 def test_state_does_not_allow_old_binary_after_either_step(self):
  old,new,before,after=self.fixture();e=p.authorize_transition(old,new,before,after)
  for count in [0,1,2]:
   applied=sorted(e['newLedger'])[:count];complete=count==2
   state={'format':1,'status':'complete' if complete else 'partial' if count else 'not_applied',
    'baseContract':old['contract'],'targetContract':new['contract'],'targetImage':new['images']['core']['id'],
    'transition':new['migration'],**e,'applied':applied,'complete':complete,
    'actualSchema':'b'*64 if complete else None if count else 'a'*64,
    'compatibleSchemas':['b'*64] if complete else [] if count else ['a'*64]}
   p.validate_state(state)
   if count:
    state['compatibleSchemas'].append('a'*64)
    with self.assertRaises(p.PolicyError):p.validate_state(state)
 def test_existing_weknow_migration_or_unbounded_schema_paths_rejected(self):
  old,new,_,_=self.fixture()
  for path in ['integrations/weknow/source/apps/server/dist/database/migrations/old.js','apps/makit/migrations/old.sql','../escape']:
   plan=copy.deepcopy(new['migration']['plan']);plan['changes'][path]={'before':None,'after':'a'*64}
   with self.assertRaises(p.PolicyError):p.core_plan(plan)
  plan=copy.deepcopy(new['migration']['plan']);plan['changes'][p.CORE_WEKNOW]['before']='a'*64
  with self.assertRaises(p.PolicyError):p.core_plan(plan)
if __name__=='__main__':unittest.main()
