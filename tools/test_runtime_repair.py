"""Disposable runtime replacement rehearsal: no production endpoints or data."""
import json,os,tempfile,shutil,subprocess,uuid
from pathlib import Path
from test_deployment import suite,free_ports,inventory
ROOT=Path(__file__).resolve().parents[1]
def main():
 os.umask(0o077);suite.daemon();before=inventory();deps=[]
 directory=Path(tempfile.mkdtemp(prefix='runtime-repair-',dir=ROOT/'.local'))
 report={'format':1,'productionAccess':False,'externalMessages':False,'checks':[],'stages':[]}
 broken_tag='cobuild-repair-fixture:'+uuid.uuid4().hex
 def check(v,label):
  if not v:raise AssertionError(label)
  report['checks'].append(label)
 def fixture(dep,seed=False):
  env={k:os.environ[k] for k in ['PATH','HOME','TMPDIR','LANG'] if k in os.environ}
  env.update(COBUILD_CONFIG=str(dep.path/'state/config.json'),COBUILD_DATA_DIR=str(dep.path/'state/platform'),COBUILD_FLOW_RECEIPT=str(directory/'flow.json'))
  r=subprocess.run(['node','tests/core-upgrade-fixture.mjs',*(['--seed'] if seed else [])],cwd=ROOT,env=env,capture_output=True,text=True,timeout=150)
  (ROOT/'.local/runtime-repair-fixture.private.log').write_text(r.stdout+r.stderr)
  if r.returncode:(directory/'core-failure.private.log').write_bytes(suite.docker('logs',dep.project+'-core-1'))
  check(r.returncode==0,'baseline seed' if seed else 'sessions, documents, attachments and new writes survive')
  report['stages'].append(json.loads(r.stdout.strip().splitlines()[-1]))
 try:
  suite.seal('cobuild-suite:managed-migration-candidate','0.7.0-repair-baseline',directory/'base.json')
  base=suite.read(directory/'base.json');plan=suite.read(ROOT/'deploy/migrations/core-runtime-v1.json')
  suite.seal('cobuild-suite:lifecycle-candidate','0.8.0-lifecycle-local',directory/'fixed.json',base,plan)
  fixed=suite.read(directory/'fixed.json')
  context=directory/'broken-image';context.mkdir()
  (context/'platform.mjs').write_text('throw new Error("Isolated runtime repair fixture failure");\n')
  (context/'Dockerfile').write_text('FROM '+fixed['retainedImages']['core']+'\nCOPY platform.mjs /suite/deploy/runtime/platform.mjs\n')
  suite.docker('build','--network','none','-t',broken_tag,str(context),timeout=120)
  suite.seal(broken_tag,'0.8.0-broken-fixture',directory/'broken.json',base,plan)
  broken=suite.read(directory/'broken.json');report['images']={k:r['images']['core']['id'] for k,r in [('base',base),('broken',broken),('fixed',fixed)]}
  ports=free_ports();cfg=suite.read(ROOT/'config/cobuild.local.example.json');cfg['origins']={k:'http://127.0.0.1:'+str(v) for k,v in ports.items()};cfg['organization']={'name':'Repair Fixture','slug':'repair-fixture'}
  dep=suite.initialize(directory/'instance',cfg,base,ports);deps.append(dep)
  with dep.lock():dep.up()
  fixture(dep,True)
  try:
   with dep.lock():dep.upgrade(broken)
   raise AssertionError('Broken runtime must fail')
  except suite.Failure as error:report['injectedFailure']=str(error)
  state=dep.schema_state();check(state and state['status']=='complete','schema evidence retained after real broken runtime')
  check(not dep.core_running() and (dep.path/'pending.json').exists(),'failed candidate and unsafe old writers stopped')
  committed=dep.migration_history(broken)
  real_start=dep.start_wait
  def interrupted(*args,**kwargs):
   real_start(*args,**kwargs);raise suite.Failure('Injected controller interruption after repaired runtime starts')
  dep.start_wait=interrupted
  try:
   with dep.lock():dep.resume_upgrade(fixed)
   raise AssertionError('Controller interruption expected')
  except suite.Failure:pass
  finally:dep.start_wait=real_start
  pending=suite.read(dep.path/'pending.json')
  check(pending['candidate']==fixed and pending['repairs'][0]['candidate']==broken,'replacement is atomic and retains original candidate')
  check(not dep.core_running(),'interrupted repaired runtime is stopped')
  # stop() deliberately stops the databases as well. Inspect the ledger with
  # only databases running, exactly as the recovery controller does.
  dep.start_databases()
  check(dep.migration_history(fixed)==committed,'repair retains exact committed migration history')
  with dep.lock():dep.resume_upgrade()
  check(dep.core_running() and not (dep.path/'pending.json').exists(),'resume starts fixed runtime without replaying destructive changes')
  fixture(dep)
  check(suite.read(dep.path/'last-recovery.json')['repairs'][0]['candidate']==broken,'completed recovery audit retained')
  try:
   with dep.lock():dep.upgrade(base)
   raise AssertionError('Unsafe downgrade expected')
  except suite.Failure:pass
  check(dep.core_running(),'downgrade rejection preserves healthy fixed runtime')
  with dep.lock():dep.stop();dep.up()
  fixture(dep)
  backup=directory/'backup'
  with dep.lock():dep.snapshot(backup,resume=False)
  suite.verify_snapshot(backup)
  restored=suite.restore(directory/'restored',backup);deps.append(restored)
  with restored.lock():restored.up()
  fixture(restored)
  check(restored.schema_state()==dep.schema_state(),'backup restore retains repaired schema identity')
  report['passed']=True
 except Exception as error:report.update(passed=False,error=str(error))
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
  # Retention tags intentionally remain as immutable test evidence; no images
  # belonging to other workspaces are pruned.
  report['unrelatedServicesUnchanged']=inventory()==before
  if not report['unrelatedServicesUnchanged'] or report.get('cleanupErrors'):report['passed']=False
  if report.get('passed'):shutil.rmtree(directory)
  else:report['privateEvidenceDirectory']=str(directory)
  (ROOT/'.local/runtime-repair-report.json').write_text(json.dumps(report,indent=2)+'\n')
  print(json.dumps(report));return 0 if report.get('passed') else 1
if __name__=='__main__':raise SystemExit(main())
