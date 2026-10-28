"""Disposable core upgrade, interrupted recovery, downgrade refusal and restore."""
import json,os,sys,tempfile,shutil,subprocess
from pathlib import Path
from test_deployment import suite,free_ports,inventory
ROOT=Path(__file__).resolve().parents[1]
def main():
 os.umask(0o077);suite.daemon();before=inventory();deps=[]
 directory=Path(tempfile.mkdtemp(prefix='core-upgrade-',dir=ROOT/'.local'))
 report={'format':1,'productionAccess':False,'externalMessages':False,'checks':[],'stages':[]}
 def check(v,label):
  if not v:raise AssertionError(label)
  report['checks'].append(label)
 def fixture(dep,seed=False):
  env={k:os.environ[k] for k in ['PATH','HOME','TMPDIR','LANG'] if k in os.environ}
  env.update(COBUILD_CONFIG=str(dep.path/'state/config.json'),COBUILD_DATA_DIR=str(dep.path/'state/platform'),COBUILD_FLOW_RECEIPT=str(directory/'flow.json'))
  r=subprocess.run(['node','tests/core-upgrade-fixture.mjs',*(['--seed'] if seed else [])],cwd=ROOT,env=env,capture_output=True,text=True,timeout=150)
  (ROOT/'.local/core-upgrade-fixture.private.log').write_text(r.stdout+r.stderr)
  if r.returncode:
   (directory/'core-failure.private.log').write_bytes(suite.docker('logs',dep.project+'-core-1'))
  check(r.returncode==0,'baseline seed' if seed else 'persistent authenticated data and new writes')
  report['stages'].append(json.loads(r.stdout.strip().splitlines()[-1]))
 def sql(dep,text):return suite.docker('exec','-i',dep.project+'-postgres-1','psql','-X','-v','ON_ERROR_STOP=1','-U','suite_admin','-d','weknow',input=text.encode())
 try:
  suite.seal('cobuild-suite:deployment-candidate','0.6.0-upgrade-baseline',directory/'base.json')
  base=suite.read(directory/'base.json')
  suite.seal('cobuild-suite:managed-migration-candidate','0.8.0-local',directory/'candidate.json',base,suite.read(ROOT/'deploy/migrations/core-managed-v1.json'))
  candidate=suite.read(directory/'candidate.json');report['images']={'base':base['images']['core']['id'],'candidate':candidate['images']['core']['id']}
  ports=free_ports();cfg=suite.read(ROOT/'config/cobuild.local.example.json');cfg['origins']={k:'http://127.0.0.1:'+str(v) for k,v in ports.items()};cfg['organization']={'name':'Upgrade Fixture','slug':'upgrade-fixture'}
  dep=suite.initialize(directory/'instance',cfg,base,ports);deps.append(dep)
  with dep.lock():dep.up()
  fixture(dep,True)
  # Deliberate conflict in this fixture only, after all real baseline data exists.
  sql(dep,'CREATE TABLE suite_managed_spaces(fixture_only integer);')
  try:
   with dep.lock():dep.upgrade(candidate)
   raise AssertionError('Conflicting migration should fail')
  except suite.Failure as failure:report['injectedMigrationFailure']=str(failure)
  state=dep.schema_state();
  if state is None:raise RuntimeError('Upgrade rejected before migration: '+report.get('injectedMigrationFailure','unknown'))
  check(state['status']=='partial' and state['applied']==['platform/0001_operations'],'partial SQLite commit recorded after PG failure')
  check(not dep.core_running() and (dep.path/'pending.json').exists(),'unsafe old binary remains stopped with pending recovery')
  check(state['compatibleSchemas']==[],'partial core schema authorizes no binary')
  sql(dep,'DROP TABLE suite_managed_spaces;')
  real_start=dep.start_wait
  def interrupted(*args,**kwargs):
   real_start(*args,**kwargs)
   raise suite.Failure('Injected controller failure after candidate activation')
  dep.start_wait=interrupted
  try:
   with dep.lock():dep.resume_upgrade()
   raise AssertionError('Injected controller interruption expected')
  except suite.Failure:pass
  finally:dep.start_wait=real_start
  check(dep.schema_state()['status']=='complete','commit survives controller exception after candidate activation')
  check(not dep.core_running(),'controller interruption leaves writers stopped')
  with dep.lock():dep.resume_upgrade()
  check(dep.core_running() and not (dep.path/'pending.json').exists(),'resume reuses both committed steps and starts candidate')
  check(dep.schema_state()['compatibleSchemas']==[candidate['contract']['schema']],'old runtime excluded after managed boundary is installed')
  fixture(dep)
  raw=sql(dep,'SELECT count(*) FROM suite_managed_spaces;').decode()
  check('\n     1\n' in raw or '\n     1' in raw,'legacy mapping is not silently converted; only new space managed')
  try:
   with dep.lock():dep.upgrade(base)
   raise AssertionError('Incompatible rollback should fail')
  except suite.Failure:pass
  check(dep.core_running(),'rollback rejection leaves healthy current runtime running')
  fixture(dep)
  with dep.lock():dep.stop();dep.up()
  fixture(dep)
  backup=directory/'backup'
  with dep.lock():dep.snapshot(backup,resume=False)
  suite.verify_snapshot(backup)
  restored=suite.restore(directory/'restored',backup);deps.append(restored)
  with restored.lock():restored.up()
  fixture(restored)
  check(restored.schema_state()==dep.schema_state(),'restore retains migration state and safety barrier')
  report['passed']=True
 except Exception as error:
  report.update(passed=False,error=str(error))
 finally:
  for dep in reversed(deps):
   try:
    with dep.lock():dep.down()
    for key in ['postgres','redis']:
     volume=dep.project+'-'+key
     labels=json.loads(suite.docker('volume','inspect',volume))[0].get('Labels',{})
     if labels.get('cobuild.deployment')!=dep.instance['id']:raise RuntimeError('Volume ownership differs')
     suite.docker('volume','rm',volume)
   except Exception as error:report.setdefault('cleanupErrors',[]).append(str(error))
  report['unrelatedServicesUnchanged']=inventory()==before
  if not report['unrelatedServicesUnchanged'] or report.get('cleanupErrors'):report['passed']=False
  if report.get('passed'):shutil.rmtree(directory)
  else:report['privateEvidenceDirectory']=str(directory)
  (ROOT/'.local/core-upgrade-report.json').write_text(json.dumps(report,indent=2)+'\n')
  print(json.dumps(report));return 0 if report.get('passed') else 1
if __name__=='__main__':raise SystemExit(main())
