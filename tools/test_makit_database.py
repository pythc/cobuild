"""Run inherited Makit integration tests against an ephemeral, local-only PostgreSQL.

Uses an already-cached image and never reuses a database or volume. Secrets are
generated for this run, supplied through a private temporary file, and redacted
from captured output. The owned container is removed even if a test fails.
"""
from pathlib import Path
import json
import os
import secrets
import subprocess
import tempfile
import time
import uuid

ROOT=Path(__file__).resolve().parents[1]
LOCAL=ROOT/'.local'

def main():
    LOCAL.mkdir(exist_ok=True,mode=0o700)
    endpoint=subprocess.check_output(['docker','context','inspect','--format','{{.Endpoints.docker.Host}}'],text=True).strip()
    if not endpoint.startswith('unix://'): raise RuntimeError('Only a local Unix Docker endpoint is supported')
    password=secrets.token_hex(32);application_password=secrets.token_hex(32)
    owner=f'cobuild-test-{uuid.uuid4().hex[:12]}'
    image='postgres:17-alpine'
    container=None;env_file=None;results=[];cleanup=False
    report={'kind':'isolated-test-database','productionAccess':False,'checks':results}
    try:
        with tempfile.NamedTemporaryFile(mode='w',dir=LOCAL,prefix='database-',suffix='.private.env',delete=False) as f:
            env_file=Path(f.name);os.chmod(env_file,0o600)
            f.write(f'POSTGRES_USER=suite_owner\nPOSTGRES_DB=suite_test\nPOSTGRES_PASSWORD={password}\n')
        command=['docker','run','--pull=never','--detach','--name',owner,'--label',f'cobuild.test-owner={owner}','--memory=512m','--cpus=1','--publish','127.0.0.1::5432','--tmpfs','/var/lib/postgresql/data:rw,nosuid,size=256m','--env-file',str(env_file),image]
        container=subprocess.check_output(command,text=True,stderr=subprocess.PIPE).strip()
        report['image']=subprocess.check_output(['docker','inspect','--format','{{.Image}}',container],text=True).strip()
        for _ in range(60):
            if subprocess.run(['docker','exec',container,'pg_isready','-U','suite_owner','-d','suite_test'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
            time.sleep(0.25)
        else:raise RuntimeError('Isolated PostgreSQL did not become ready')
        binding=json.loads(subprocess.check_output(['docker','inspect','--format','{{json .NetworkSettings.Ports}}',container],text=True))['5432/tcp'][0]
        if binding['HostIp']!='127.0.0.1':raise RuntimeError('Test database is not loopback-only')
        port=binding['HostPort']
        env={k:v for k,v in os.environ.items() if not k.startswith(('MAKIT_','LAB_IDENTITY_','FEISHU_'))}
        env.update({'MAKIT_STORAGE':'postgres','LAB_IDENTITY_TENANT_KEY':'isolated-suite-test','MAKIT_MIGRATION_DATABASE_URL':f'postgres://suite_owner:{password}@127.0.0.1:{port}/suite_test','MAKIT_DATABASE_URL':f'postgres://makit_application:{application_password}@127.0.0.1:{port}/suite_test','MAKIT_APPLICATION_PASSWORD':application_password})
        stages=[('migrations',['node','scripts/selfhost/migrate.cjs']),('runtime-role',['node','scripts/selfhost/set-runtime-password.cjs']),('integration',['npm','run','test:selfhost'])]
        for name,command in stages:
            result=subprocess.run(command,cwd=ROOT/'apps/makit',env=env,text=True,capture_output=True,timeout=180)
            output=(result.stdout+result.stderr).replace(password,'[REDACTED]').replace(application_password,'[REDACTED]')
            (LOCAL/f'makit-isolated-{name}.log').write_text(output)
            results.append({'stage':name,'exitCode':result.returncode})
            if result.returncode:break
    finally:
        try:
            if container:
                actual=subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "cobuild.test-owner"}}',container],text=True).strip()
                if actual==owner:
                    cleanup=subprocess.run(['docker','rm','--force',container],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
                else:report['cleanupError']='Ownership changed; refused to remove container'
        except (OSError,subprocess.SubprocessError):
            report['cleanupError']='Owned test container cleanup could not be confirmed'
        finally:
            if env_file:env_file.unlink(missing_ok=True)
        report['containerRemoved']=cleanup
        report['passed']=len(results)==3 and all(row['exitCode']==0 for row in results) and cleanup
        (LOCAL/'makit-isolated-result.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report))
    return 0 if report['passed'] else 1

if __name__=='__main__':raise SystemExit(main())
