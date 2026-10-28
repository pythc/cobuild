"""Own disposable local databases and processes; never read production config."""
import json, os, secrets, socket, subprocess, tempfile, time, uuid, sys
from pathlib import Path
from local_process import captured

ROOT=Path(__file__).resolve().parents[1]
LOCAL=ROOT/'.local'
def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1',0));return s.getsockname()[1]
def main():
    LOCAL.mkdir(exist_ok=True,mode=0o700)
    endpoint=subprocess.check_output(['docker','context','inspect','--format','{{.Endpoints.docker.Host}}'],text=True).strip()
    if not endpoint.startswith('unix://'): raise RuntimeError('Only local Docker is allowed')
    owner='cobuild-native-'+uuid.uuid4().hex[:10]
    password=secrets.token_hex(32);app_password=secrets.token_hex(32)
    processes=[];containers=[];logs=[];report={'productionAccess':False,'stages':[]}
    # Explicit minimal environment prevents inherited service credentials or .env use.
    base={k:os.environ[k] for k in ['PATH','HOME','TMPDIR','LANG'] if k in os.environ}
    def run(name,command,cwd,env):
        result=captured(command,cwd=cwd,env=env,timeout=180)
        output=(result.stdout+result.stderr).replace(password,'[REDACTED]').replace(app_password,'[REDACTED]')
        (LOCAL/f'native-{name}.log').write_text(output)
        report['stages'].append({'name':name,'exitCode':result.returncode})
        if result.returncode:raise RuntimeError(name+' failed; see private log')
    with tempfile.TemporaryDirectory(prefix='native-',dir=LOCAL) as tmp:
      tmp=Path(tmp);os.chmod(tmp,0o700)
      try:
        db_env=tmp/'database.private.env';db_env.write_text(f'POSTGRES_USER=suite_owner\nPOSTGRES_DB=makit\nPOSTGRES_PASSWORD={password}\n');db_env.chmod(0o600)
        for suffix,image,args in [('pg','postgres:17-alpine',['--env-file',str(db_env),'--tmpfs','/var/lib/postgresql/data:rw,nosuid,size=384m','-p','127.0.0.1::5432']),('redis','redis:8-alpine',['-p','127.0.0.1::6379'])]:
          name=owner+'-'+suffix
          subprocess.run(['docker','run','--pull=never','-d','--name',name,'--label','cobuild.test-owner='+owner,'--memory=512m',*args,image],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
          containers.append(name)
        def binding(name,inside):
          rows=json.loads(subprocess.check_output(['docker','inspect','--format','{{json .NetworkSettings.Ports}}',name],text=True))[inside+'/tcp']
          assert rows[0]['HostIp']=='127.0.0.1';return rows[0]['HostPort']
        pgport=binding(containers[0],'5432');redisport=binding(containers[1],'6379')
        for _ in range(100):
          if subprocess.run(['docker','exec',containers[0],'pg_isready','-h','127.0.0.1','-U','suite_owner'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
          time.sleep(.2)
        subprocess.run(['docker','exec',containers[0],'psql','-U','suite_owner','-d','makit','-c','CREATE DATABASE weknow'],check=True,stdout=subprocess.DEVNULL)
        cfg=json.loads((ROOT/'config/cobuild.local.example.json').read_text())
        cfg['organization']={'name':'Local Test Team','slug':'local-test'}
        cfg['origins']={m:'http://127.0.0.1:'+str(port()) for m in ['platform','makit','weknow']}
        config=tmp/'config.json';config.write_text(json.dumps(cfg))
        data=tmp/'data';data.mkdir(mode=0o700)
        common={**base,'NODE_ENV':'production','NODE_OPTIONS':'--require='+str(ROOT/'tools/local-network-guard.cjs'),'COBUILD_IDENTITY_MODE':'local'}
        env={**common,'COBUILD_CONFIG':str(config),'COBUILD_DATA_DIR':str(data),'COBUILD_FLOW_RECEIPT':str(tmp/'flow.json')}
        def start(name,command,cwd,env):
          f=open(LOCAL/f'native-{name}.private.log','w');os.chmod(f.name,0o600);logs.append(f)
          p=subprocess.Popen(command,cwd=cwd,env=env,stdout=f,stderr=f);processes.append(p);return p
        def wait(url,p):
          import urllib.request,urllib.error
          for _ in range(240):
            if p.poll() is not None:raise RuntimeError('Service exited before ready')
            try:
              with urllib.request.urlopen(url,timeout=1) as r:
                if r.status==200:return
            except (OSError,urllib.error.URLError):pass
            time.sleep(.25)
          raise RuntimeError('Local readiness timeout')
        p=start('platform',['node','tools/serve-platform.mjs'],ROOT,env);wait(cfg['origins']['platform']+'/healthz',p)
        # Stable organization ID is public metadata, independent of display slug.
        import urllib.request
        with urllib.request.urlopen(cfg['origins']['platform']+'/api/suite/config') as r:org=json.load(r)['organizationId']
        application_env=json.loads(subprocess.check_output(['node','tools/local-application-env.mjs',str(config),org],cwd=ROOT,env=base,text=True))
        makit={**common,**application_env['makit'],'COBUILD_SERVICE_KEY_FILE':str(data/'makit.service.key'),'MAKIT_DATABASE_URL':f'postgres://makit_application:{app_password}@127.0.0.1:{pgport}/makit','MAKIT_MIGRATION_DATABASE_URL':f'postgres://suite_owner:{password}@127.0.0.1:{pgport}/makit','MAKIT_APPLICATION_PASSWORD':app_password,'MAKIT_SESSION_ENCRYPTION_KEY':secrets.token_hex(32)}
        run('makit-migrations',['node','scripts/selfhost/migrate.cjs'],ROOT/'apps/makit',makit)
        run('makit-role',['node','scripts/selfhost/set-runtime-password.cjs'],ROOT/'apps/makit',makit)
        p=start('makit',['node','dist/selfhost/server.cjs'],ROOT/'apps/makit',makit);wait(cfg['origins']['makit']+'/healthz',p)
        weknow={**common,**application_env['weknow'],'COBUILD_SERVICE_KEY_FILE':str(data/'weknow.service.key'),'APP_SECRET':secrets.token_hex(32),'DATABASE_URL':f'postgres://suite_owner:{password}@127.0.0.1:{pgport}/weknow','REDIS_URL':f'redis://127.0.0.1:{redisport}','COBUILD_STORAGE_PATH':str(tmp/'files')}
        p=start('weknow',['node','dist/main.js'],ROOT/'integrations/weknow/source/apps/server',weknow);wait(cfg['origins']['weknow']+'/api/auth/identity/status',p)
        run('core-e2e',['node','tests/local-core-e2e.mjs'],ROOT,env)
        run('collections',['node','tests/local-collections.cjs'],ROOT,makit)
        for old in reversed(processes):
          if old.poll() is None:old.terminate()
        for old in processes:
          try:old.wait(timeout=12)
          except subprocess.TimeoutExpired:old.kill();old.wait()
        p=start('platform-restarted',['node','tools/serve-platform.mjs'],ROOT,env);wait(cfg['origins']['platform']+'/healthz',p)
        p=start('makit-restarted',['node','dist/selfhost/server.cjs'],ROOT/'apps/makit',makit);wait(cfg['origins']['makit']+'/healthz',p)
        p=start('weknow-restarted',['node','dist/main.js'],ROOT/'integrations/weknow/source/apps/server',weknow);wait(cfg['origins']['weknow']+'/api/auth/identity/status',p)
        run('restart-e2e',['node','tests/local-core-restart.mjs'],ROOT,env)
        if '--browser-review' in sys.argv:
          release=tmp/'finish-browser-review'
          metadata={'origins':cfg['origins'],'receipt':json.loads((tmp/'flow.json').read_text()),'releaseFile':str(release)}
          (LOCAL/'browser-review.json').write_text(json.dumps(metadata))
          deadline=time.monotonic()+900
          while not release.exists() and time.monotonic()<deadline:time.sleep(.25)
          if not release.exists():raise RuntimeError('Browser review hold expired')
          report['browserReviewReleased']=True
        report['passed']=True
      except Exception as e:
        report['passed']=False;report['error']=str(e).replace(password,'[REDACTED]').replace(app_password,'[REDACTED]')
      finally:
        for p in reversed(processes):
          if p.poll() is None:p.terminate()
        for p in processes:
          try:p.wait(timeout=12)
          except subprocess.TimeoutExpired:p.kill();p.wait()
        for f in logs:f.close()
        removed=[]
        for name in containers:
          label=subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "cobuild.test-owner"}}',name],text=True).strip()
          if label!=owner:raise RuntimeError('Container ownership mismatch')
          removed.append(subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0)
        report['ownedContainersRemoved']=all(removed)
    (LOCAL/'native-core-result.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
    return 0 if report.get('passed') and report.get('ownedContainersRemoved') else 1
if __name__=='__main__':raise SystemExit(main())
