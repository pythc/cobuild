"""Real Linux-container install/restore/rollout rehearsal with owned resources."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import uuid

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('deployment',ROOT/'deploy/suite.py')
suite=importlib.util.module_from_spec(spec);spec.loader.exec_module(suite)
from local_process import captured

def free_ports():
    sockets=[]
    try:
        for _ in range(3):
            s=socket.socket();s.bind(('127.0.0.1',0));sockets.append(s)
        return dict(zip(['platform','makit','weknow'],[s.getsockname()[1] for s in sockets]))
    finally:
        for s in sockets:s.close()

def inventory():
    ids=suite.docker('ps','-q').decode().split()
    if not ids:return {}
    rows=json.loads(suite.docker('inspect',*ids))
    return {r['Id']:{'startedAt':r['State']['StartedAt'],'running':r['State']['Running']} for r in rows}

def main():
    os.umask(0o077);suite.daemon()
    local=ROOT/'.local';local.mkdir(exist_ok=True,mode=0o700)
    owner='cobuild-deploy-'+uuid.uuid4().hex[:10]
    report={'format':1,'productionAccess':False,'externalMessages':False,'checks':[],'stages':[]}
    deployments=[];images=[];retained=[];baseline_tag=None;before=inventory();directory=Path(tempfile.mkdtemp(prefix='deployment-',dir=local))
    base={k:os.environ[k] for k in ['PATH','HOME','TMPDIR','LANG'] if k in os.environ}
    def check(value,label):
        if not value:raise AssertionError(label)
        report['checks'].append(label)
    def run(name,args,env):
        result=captured(args,cwd=ROOT,env=env,timeout=180)
        log=local/('deployment-'+name+'.private.log');log.write_text(result.stdout+result.stderr);log.chmod(0o600)
        report['stages'].append({'name':name,'exitCode':result.returncode})
        if result.returncode:raise RuntimeError(name+' failed; see private log')
        for line in result.stdout.splitlines():
            try:
                value=json.loads(line)
                if value.get('passed'):report['stages'][-1]['assertions']=value.get('checks')
            except (ValueError,AttributeError):pass
    def node(name,script,dep,*args,readonly=False):
        env={**base,'COBUILD_CONFIG':str(dep.path/'state/config.json'),'COBUILD_DATA_DIR':str(dep.path/'state/platform'),
             'COBUILD_FLOW_RECEIPT':str(directory/'flow.json'),'COBUILD_ATTACHMENT_RECEIPT':str(directory/'attachment.json')}
        if readonly:env['COBUILD_PERSISTENCE_ONLY']='true'
        run(name,['node',script,*args],env)
    def child_image(name,tail):
        tag=owner+':'+name;file=directory/('Dockerfile.'+name)
        file.write_text('FROM '+baseline_tag+'\nLABEL cobuild.test-owner="'+owner+'"\n'+tail+'\n')
        result=captured(['docker','build','--network','none','-f',str(file),'-t',tag,str(directory)],cwd=ROOT,env=base,timeout=180)
        log=local/('deployment-fixture-'+name+'.private.log');log.write_text(result.stdout+result.stderr);log.chmod(0o600)
        if result.returncode:raise RuntimeError('Fixture image build failed')
        images.append(tag);return tag
    def preserve(name,dep,add=False):node(name,'tests/deployment-persistence.mjs',dep,*(['--add-page'] if add else []))
    try:
        release=directory/'release-v1.json'
        pinned=suite.image_info('cobuild-suite:deployment-candidate')['id']
        baseline_tag=owner+':baseline';suite.docker('tag',pinned,baseline_tag)
        suite.seal(baseline_tag,'0.4.0-rehearsal.1',release)
        report['baselineImage']=pinned
        cfg=json.loads((ROOT/'config/cobuild.local.example.json').read_text());ports=free_ports()
        cfg['organization']={'name':'Isolated Deployment Team','slug':'isolated-deployment'}
        cfg['origins']={k:'http://127.0.0.1:'+str(v) for k,v in ports.items()}
        dep=suite.initialize(directory/'original',cfg,suite.read(release),ports);deployments.append(dep)
        with dep.lock():dep.up()
        check(dep.core_running(),'fresh Linux core starts with generated secrets')
        node('core-e2e','tests/local-core-e2e.mjs',dep)
        node('attachment-seed','tests/deployment-persistence.mjs',dep,'--seed')
        redis_name=dep.project+'-redis-1'
        suite.docker('exec',redis_name,'redis-cli','set','cobuild:recovery-fixture',owner)
        with dep.lock():dep.stop();dep.up()
        node('restart','tests/local-core-restart.mjs',dep,readonly=True);preserve('restart-session-files',dep)
        snapshot=directory/'backup'
        with dep.lock():dep.snapshot(snapshot)
        check(suite.verify_snapshot(snapshot)['release']==dep.release,'complete backup manifest and checksums verify')
        check(dep.core_running(),'backup returns the original service to healthy running state')
        for mode in ['tampered','missing','symlink']:
            bad=directory/('backup-'+mode);shutil.copytree(snapshot,bad)
            if mode=='tampered':(bad/'state/config.json').write_text('{}')
            elif mode=='missing':(bad/'redis.tar').unlink()
            else:(bad/'state/link').symlink_to('/etc/passwd')
            target=directory/('restore-'+mode)
            try:suite.restore(target,bad)
            except suite.Failure:pass
            else:raise AssertionError('Corrupt backup accepted: '+mode)
            check(not target.exists(),'reject '+mode+' snapshot before creating restore target')
            shutil.rmtree(bad)
        try:suite.restore(dep.path,snapshot)
        except suite.Failure:pass
        else:raise AssertionError('Existing target overwritten')
        check((dep.path/'state/platform/identity.sqlite').exists(),'restore cannot overwrite existing deployment')
        with dep.lock():dep.down()
        restored=suite.restore(directory/'restored',snapshot);deployments.append(restored)
        check(not restored.core_running(),'restore creates a stopped isolated deployment')
        with restored.lock():restored.up()
        node('restored-core','tests/local-core-restart.mjs',restored,readonly=True);preserve('restored-session-files',restored)
        check(suite.docker('exec',restored.project+'-redis-1','redis-cli','get','cobuild:recovery-fixture').decode().strip()==owner,'Redis state restored')
        v2=directory/'release-v2.json';suite.seal(child_image('v2','ENV COBUILD_REHEARSAL_RELEASE=2'),'0.4.0-rehearsal.2',v2)
        retained.append(suite.read(v2)['retainedImages']['core'])
        suite.docker('image','rm',images[-1]);images.pop()
        suite.validate_release(suite.read(v2))
        check(True,'sealed release retains its immutable image after the working tag is removed')
        with restored.lock():restored.upgrade(suite.read(v2))
        check(restored.release['version']=='0.4.0-rehearsal.2','compatible image upgrade succeeds')
        check(suite.docker('inspect','--format','{{.Image}}',restored.project+'-core-1').decode().strip()==suite.read(v2)['images']['core']['id'],'running container uses the new immutable image')
        preserve('upgrade-new-write',restored,add=True)
        with restored.lock():restored.upgrade(suite.read(release))
        check(suite.docker('inspect','--format','{{.Image}}',restored.project+'-core-1').decode().strip()==suite.read(release)['images']['core']['id'],'rollback selects the previous immutable image')
        preserve('rollback-retains-writes',restored)
        failed=directory/'release-broken.json'
        cmd='CMD ["node","-e","require(\'fs\').writeFileSync(\'/state/upgrade-preserved.txt\',\'candidate write\');process.exit(1)"]'
        suite.seal(child_image('broken',cmd),'0.4.0-rehearsal.broken',failed)
        retained.append(suite.read(failed)['retainedImages']['core'])
        try:
            with restored.lock():restored.upgrade(suite.read(failed))
        except suite.Failure:pass
        else:raise AssertionError('Broken upgrade accepted')
        check(restored.core_running() and restored.release['version']=='0.4.0-rehearsal.1','failed upgrade automatically restores old application image')
        check((restored.path/'state/upgrade-preserved.txt').read_text()=='candidate write','failed candidate writes are retained rather than overwritten by old snapshot')
        preserve('failed-upgrade-retains-data',restored)
        incompatible=directory/'release-incompatible.json'
        mutation="USER root\nRUN node -e \"require('fs').writeFileSync('/suite/apps/makit/migrations/selfhost/9999_rehearsal.sql','INVALID MIGRATION')\"\nUSER node"
        suite.seal(child_image('incompatible',mutation),'0.4.0-rehearsal.incompatible',incompatible)
        retained.append(suite.read(incompatible)['retainedImages']['core'])
        core=restored.project+'-core-1'
        started=suite.docker('inspect','--format','{{.State.StartedAt}}',core)
        try:
            with restored.lock():restored.upgrade(suite.read(incompatible))
        except suite.Failure:pass
        else:raise AssertionError('Unknown schema upgrade accepted')
        check(suite.docker('inspect','--format','{{.State.StartedAt}}',core)==started,'unknown migration rejected before stopping current service')
        try:restored.preflight(suite.read(incompatible))
        except suite.Failure:pass
        else:raise AssertionError('Runtime schema gate bypassed')
        check(True,'stored runtime contract also rejects an incompatible direct start')
        suite.write(restored.path/'pending.json',{'previous':restored.release,'candidate':suite.read(v2),'phase':'prepared'})
        try:restored.up()
        except suite.Failure:pass
        else:raise AssertionError('Interrupted operation started silently')
        with restored.lock():restored.recover()
        preserve('interrupted-upgrade-recovery',restored)
        check(not (restored.path/'pending.json').exists(),'interrupted upgrade has explicit recover path')
        original= suite.read(restored.path/'state/config.json')
        disabled={**original,'modules':['platform','kick']}
        with restored.lock():
            restored.stop();suite.write(restored.path/'state/config.json',disabled);restored.up()
        check(restored.core_running(),'platform/Kick-only module selection starts')
        for app in ['makit','weknow']:
            with socket.socket() as sock:check(sock.connect_ex(('127.0.0.1',ports[app]))!=0,app+' disabled port is not published')
        with restored.lock():
            restored.stop();suite.write(restored.path/'state/config.json',original);restored.up()
        preserve('reenabled-modules-data',restored)
        check(True,'module re-enable preserves shared identity, files and new document')
        recovery=restored.recover_owner()
        recovery_file=Path(recovery['recoveryFile'])
        check(recovery_file.is_file() and recovery_file.stat().st_mode & 0o077==0,'owner recovery writes only a private local file')
        report['passed']=True
    except BaseException as error:
        report['passed']=False;report['error']=type(error).__name__+': '+str(error)
        for i,dep in enumerate(deployments):
            for service in ['core','gateway']:
                try:
                    logs=suite.docker('logs',dep.project+'-'+service+'-1').decode(errors='replace')
                    for secret in suite.read(dep.path/'state/secrets.json').values():logs=logs.replace(secret,'[REDACTED]')
                    path=local/('deployment-failure-'+str(i)+'-'+service+'.private.log');path.write_text(logs);path.chmod(0o600)
                except Exception:pass
    finally:
        cleaned=[]
        known={d.path for d in deployments}
        for path in directory.glob('*/instance.json'):
            if path.parent.name not in ['original','restored']:continue
            if path.parent not in known:
                try:deployments.append(suite.Deployment(path.parent))
                except Exception:pass
        for dep in reversed(deployments):
            try:
                dep.down();dep.check_owned()
                for key in ['postgres','redis']:
                    name=dep.project+'-'+key
                    exists=subprocess.run(['docker','volume','inspect',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
                    if exists:suite.docker('volume','rm',name)
                cleaned.append(True)
            except Exception as error:
                cleaned.append(False);report.setdefault('cleanupErrors',[]).append(str(error))
        for tag in images+retained:
            try:
                info=json.loads(suite.docker('image','inspect',tag))[0]
                if info['Config'].get('Labels',{}).get('cobuild.test-owner')!=owner:raise RuntimeError('Fixture image ownership differs')
                suite.docker('image','rm',tag)
            except Exception as error:
                cleaned.append(False);report.setdefault('cleanupErrors',[]).append(str(error))
        if baseline_tag:
            try:
                if suite.image_info(baseline_tag)['id']!=report['baselineImage']:raise RuntimeError('Baseline image tag changed')
                suite.docker('image','rm',baseline_tag)
            except Exception as error:
                cleaned.append(False);report.setdefault('cleanupErrors',[]).append(str(error))
        report['ownedResourcesRemoved']=all(cleaned)
        after=inventory();report['otherRunningContainersPreserved']=all(after.get(k)==v for k,v in before.items())
        if report['ownedResourcesRemoved']:shutil.rmtree(directory)
        else:report['retainedPrivateTestDirectory']=str(directory)
        suite.write(local/'deployment-result.json',report)
    print(json.dumps(report));return 0 if report.get('passed') and report['ownedResourcesRemoved'] and report['otherRunningContainersPreserved'] else 1

if __name__=='__main__':raise SystemExit(main())
