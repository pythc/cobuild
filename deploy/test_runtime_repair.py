import copy,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import migration_policy as policy
import suite
import test_core_migration

class RuntimeRepairTests(unittest.TestCase):
 def fixture(self):
  old,new,before,after=test_core_migration.CoreMigrationTests().fixture()
  fixed=copy.deepcopy(new);fixed['images']['core']['id']='sha256:'+'f'*64
  return old,new,fixed,before,after
 def test_runtime_transition_rejects_unplanned_schema_files_and_ledger_changes(self):
  old,new,_,_,_=self.fixture()
  plan=json.loads((Path(__file__).parent/'migrations/core-runtime-v1.json').read_text())
  new['migration'].update(kind='core-runtime-v1',plan=plan)
  new['migration']['planDigest']=policy.digest({'fromImage':new['migration']['fromImage'],'fromContract':old['contract'],'toContract':new['contract'],'plan':plan})
  before={'files':{k:v['before'] for k,v in plan['changes'].items()}}
  after={'files':{k:v['after'] for k,v in plan['changes'].items()},'coreRunnerDigest':'d'*64}
  for path,key in [(policy.CORE_SQL,'platform/0001_operations'),(policy.CORE_WEKNOW,'weknow/20261029T120000-suite-managed-spaces')]:
   before['files'][path]=after['files'][path]=plan['ledger'][key]
  policy.authorize_transition(old,new,before,after)
  for path in [policy.CORE_SQL,'apps/makit/migrations/new.sql']:
   bad=copy.deepcopy(after);bad['files'][path]='e'*64
   with self.assertRaises(policy.PolicyError):policy.authorize_transition(old,new,before,bad)
 def test_only_runtime_can_change(self):
  _,new,fixed,_,after=self.fixture()
  policy.validate_runtime_repair(new,fixed,after,after)
  cases=[]
  bad=copy.deepcopy(fixed);bad['contract']['schema']='e'*64;cases.append((bad,after))
  bad=copy.deepcopy(fixed);bad['migration']['planDigest']='e'*64;cases.append((bad,after))
  bad=copy.deepcopy(fixed);bad['images']['redis']={'id':'other'};cases.append((bad,after))
  for key in ['files','runnerDigest','coreRunnerDigest','makitLedger']:
   manifest=copy.deepcopy(after);manifest[key]={'changed':True};cases.append((fixed,manifest))
  cases.append((new,after))
  for release,manifest in cases:
   with self.assertRaises(policy.PolicyError):policy.validate_runtime_repair(new,release,after,manifest)
 def test_interrupted_repair_keeps_pending_new_candidate_and_stops_writers(self):
  old,new,fixed,before,after=self.fixture()
  evidence=policy.authorize_transition(old,new,before,after)
  with tempfile.TemporaryDirectory() as temp:
   dep=object.__new__(suite.Deployment);dep.path=Path(temp);dep.release=old
   suite.write(dep.path/'pending.json',{'previous':old,'candidate':new,'migrationEvidence':evidence,'backup':'retained'})
   def manifest(image):return before if image==old['images']['core']['id'] else after
   with patch.object(suite,'validate_release',side_effect=lambda v:v),patch.object(suite,'schema_manifest',side_effect=manifest),patch.object(dep,'stop') as stop,patch.object(dep,'preflight'),patch.object(dep,'configure'),patch.object(dep,'apply_migration'),patch.object(dep,'activate_runtime'),patch.object(dep,'start_wait',side_effect=suite.Failure('readiness')):
    with self.assertRaises(suite.Failure):dep.resume_upgrade(fixed)
    self.assertEqual(stop.call_count,2)
   pending=suite.read(dep.path/'pending.json')
   self.assertEqual(pending['candidate'],fixed);self.assertEqual(pending['repairs'][0]['candidate'],new)
   self.assertEqual(pending['previous'],old);self.assertEqual(pending['backup'],'retained')
   with patch.object(suite,'validate_release',side_effect=lambda v:v),patch.object(suite,'schema_manifest',side_effect=manifest),patch.object(dep,'stop'),patch.object(dep,'preflight'),patch.object(dep,'configure'),patch.object(dep,'apply_migration'),patch.object(dep,'activate_runtime'),patch.object(dep,'start_wait'):
    dep.resume_upgrade()
   self.assertEqual(dep.release,fixed);self.assertFalse((dep.path/'pending.json').exists())
   self.assertEqual(suite.read(dep.path/'last-recovery.json')['candidate'],fixed)
 def test_invalid_repair_does_not_replace_pending(self):
  old,new,fixed,before,after=self.fixture();fixed['contract']['schema']='e'*64
  with tempfile.TemporaryDirectory() as temp:
   dep=object.__new__(suite.Deployment);dep.path=Path(temp)
   pending={'previous':old,'candidate':new,'migrationEvidence':policy.authorize_transition(old,new,before,after)}
   suite.write(dep.path/'pending.json',pending)
   with patch.object(suite,'validate_release',side_effect=lambda v:v),patch.object(suite,'schema_manifest',side_effect=lambda image:before if image==old['images']['core']['id'] else after),patch.object(dep,'stop'),patch.object(dep,'preflight') as preflight:
    with self.assertRaises(suite.Failure):dep.resume_upgrade(fixed)
    preflight.assert_not_called()
   self.assertEqual(suite.read(dep.path/'pending.json'),pending)
if __name__=='__main__':unittest.main()
