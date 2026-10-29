#!/usr/bin/env python3
"""Local Docker deployment lifecycle. No production config discovery or shell eval.

Cold snapshots intentionally require the same architecture and pinned database
image. Cross-version database conversion is a separate, explicit migration.
"""
import argparse
import contextlib
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
from functools import lru_cache
sys.path.insert(0,str(Path(__file__).resolve().parent))
import migration_policy as policy
import ingress

ROOT = Path(__file__).resolve().parents[1]
PG = 'postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24'
REDIS = 'redis:8-alpine@sha256:3811787313eba226a2ef38658c6ccb91cd5e110edc89c37767de373120a0e5a0'
GATEWAY = 'caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d'
ID = re.compile(r'^sha256:[a-f0-9]{64}$')

class Failure(Exception): pass

def command(args, *, input=None, output=None, timeout=240):
    result = subprocess.run(args, input=input, stdout=output or subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        # Raw Docker/Nest diagnostics may contain database URLs. Never print them.
        log=ROOT/'.local/deployment-command-error.private.log'
        try:
            log.parent.mkdir(exist_ok=True,mode=0o700)
            with open(log,'wb',opener=lambda p,f:os.open(p,f,0o600)) as stream:
                os.chmod(log,0o600);stream.write(result.stderr)
        except OSError:
            # A read-only source checkout must not prevent rollback handling.
            pass
        raise Failure('Command failed: ' + ' '.join(args[:3]) + ' (exit ' + str(result.returncode) + ')')
    return result.stdout if output is None else b''

def docker(*args, **kwargs): return command(['docker', *map(str, args)], **kwargs)
def read(path): return json.loads(Path(path).read_text())
def write(path, obj):
    path = Path(path)
    temporary = path.with_name(path.name + '.tmp-' + secrets.token_hex(4))
    with open(temporary, 'x', opener=lambda p,f: os.open(p,f,0o600)) as stream:
        json.dump(obj, stream, indent=2); stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, path)
    sync_directory(path.parent)

def sync_directory(path):
    descriptor=os.open(path,os.O_RDONLY)
    try:os.fsync(descriptor)
    finally:os.close(descriptor)

def remove_record(path):
    Path(path).unlink();sync_directory(Path(path).parent)

def private(path):
    path = Path(path)
    if path.is_symlink() or path.stat().st_mode & 0o077: raise Failure('Path must be private: ' + str(path))

def files(directory):
    for path in sorted(Path(directory).rglob('*')):
        if path.is_symlink() or not (path.is_dir() or path.is_file()): raise Failure('Unsupported file in snapshot')
        if path.is_file(): yield path

def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b''): h.update(chunk)
    return h.hexdigest()

def daemon():
    endpoint = docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}').decode().strip()
    # Match actual Docker endpoint, including overrides. Never operate a remote host.
    if os.environ.get('DOCKER_HOST') or os.environ.get('DOCKER_CONTEXT'): raise Failure('Unset Docker environment overrides')
    if not endpoint.startswith('unix://'): raise Failure('Only a local Docker daemon is supported')
    docker('compose', 'version')

def image_info(ref):
    value = json.loads(docker('image', 'inspect', ref))[0]
    return { 'id': value['Id'], 'architecture': value['Architecture'], 'os': value['Os'] }

@lru_cache(maxsize=64)
def schema_manifest(image):
    script=(ROOT/'deploy/runtime/schema-inspect.mjs').read_bytes()
    return json.loads(docker('run','--rm','-i','--network','none','--entrypoint','node',image,'--input-type=module',input=script))

def checked_policy(function,*args):
    try:return function(*args)
    except policy.PolicyError as error:raise Failure(str(error)) from error

def checked_ingress(function,*args):
    try:return function(*args)
    except ingress.IngressError as error:raise Failure(str(error)) from error

def available_subnet(exclude=()):
    ids=docker('network','ls','-q').decode().split()
    networks=json.loads(docker('network','inspect',*ids)) if ids else []
    used=[ipaddress.ip_network(c['Subnet']) for n in networks for c in (n.get('IPAM',{}).get('Config') or []) if c.get('Subnet')]+[ipaddress.ip_network(s) for s in exclude]
    for candidate in ipaddress.ip_network('10.253.0.0/16').subnets(new_prefix=24):
        if not any(candidate.version==n.version and candidate.overlaps(n) for n in used):return str(candidate)
    raise Failure('No free deployment subnet; specify an unused private /24')

def validate_release(value):
    if value.get('format') != 1 or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}', value.get('version','')):
        raise Failure('Invalid release manifest')
    for key in ['core', 'postgres', 'redis', 'gateway']:
        info = value.get('images', {}).get(key, {})
        if not ID.fullmatch(info.get('id','')) or image_info(info['id']) != info: raise Failure('Pinned image unavailable or differs: ' + key)
    if len({(i['architecture'],i['os']) for i in value['images'].values()})!=1: raise Failure('Image architectures differ')
    if value['images']['postgres'] != image_info(PG) or value['images']['redis'] != image_info(REDIS) or value['images']['gateway'] != image_info(GATEWAY):
        raise Failure('Unsupported database image; use an explicit database migration')
    actual = json.loads(docker('run','--rm','--network','none', '--entrypoint','node', value['images']['core']['id'], 'deploy/runtime/contract.mjs'))
    if value.get('contract') != actual: raise Failure('Release contract differs from the pinned image')
    checked_policy(policy.validate_contract,value['contract'])
    if value.get('migration'):
        approved_runner=digest(ROOT/'deploy/runtime/migrate.mjs')
        manifest=schema_manifest(value['images']['core']['id'])
        checked_policy(policy.validate_candidate,value['migration'],value['contract'],manifest,approved_runner)
        if value['migration']['kind'] in ['core-managed-v1','core-runtime-v1','core-project-transfer-v1']:
            reviewed={'core-managed-v1':['core-managed-v1.json'],'core-runtime-v1':['core-runtime-v1.json','core-project-state-v1.json'],'core-project-transfer-v1':['core-project-transfer-v1.json']}[value['migration']['kind']]
            if not any(value['migration']['plan']==read(ROOT/'deploy/migrations'/name) for name in reviewed):raise Failure('Core plan differs from the reviewed release plan')
            if manifest.get('coreRunnerDigest')!=digest(ROOT/'deploy/runtime/core-migrate.mjs'):raise Failure('Core runner differs from reviewed implementation')
    return value

def seal(image, version, output, base_release=None, migration_plan=None):
    if Path(output).exists(): raise Failure('Release manifest already exists')
    value = {'format':1,'version':version,'images':{'core':image_info(image),'postgres':image_info(PG),'redis':image_info(REDIS),'gateway':image_info(GATEWAY)},
             'contract': json.loads(docker('run','--rm','--network','none','--entrypoint','node',image,'deploy/runtime/contract.mjs'))}
    if (base_release is None)!=(migration_plan is None):raise Failure('Base release and migration plan are required together')
    if base_release is not None:
        validate_release(base_release)
        value['migration']={'format':1,'kind':migration_plan.get('kind','makit-additive-v1'),'fromImage':base_release['images']['core']['id'],'fromContract':base_release['contract'],'plan':migration_plan}
        value['migration']['planDigest']=policy.digest({'fromImage':value['migration']['fromImage'],'fromContract':base_release['contract'],'toContract':value['contract'],'plan':migration_plan})
        checked_policy(policy.authorize_transition,base_release,value,schema_manifest(base_release['images']['core']['id']),schema_manifest(value['images']['core']['id']))
    validate_release(value)
    value['retainedImages']={}
    for role,info in value['images'].items():
        tag='cobuild-artifact:sha256-'+info['id'][7:]
        existing=subprocess.run(['docker','image','inspect',tag],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        if existing.returncode==0 and json.loads(existing.stdout)[0]['Id']!=info['id']:raise Failure('Artifact retention tag belongs to a different image')
        docker('tag',info['id'],tag)
        value['retainedImages'][role]=tag
    write(output, value)

def compose_value(directory, instance, release):
    owner = instance['id']; project = 'cobuild-' + owner
    labels = {'cobuild.deployment':owner}
    cfg = read(directory/'state/config.json')
    transport=checked_ingress(ingress.descriptor,directory)
    gateway_volumes=[str(directory/'Caddyfile')+':/etc/caddy/Caddyfile:ro']
    if transport:gateway_volumes.append(str(directory/'state/ingress'/transport['generation'])+':/etc/cobuild/tls:ro')
    port_bindings = [f"127.0.0.1:{instance['ports'][app]}:{4100+i}" for i,app in enumerate(['platform','makit','weknow']) if app in cfg['modules']]
    return {'name':project, 'services':{
      'postgres':{'image':release['images']['postgres']['id'], 'labels':labels,
        'environment':{'POSTGRES_USER':'suite_admin','POSTGRES_DB':'makit','POSTGRES_PASSWORD_FILE':'/run/secrets/db-password'},
        'volumes':['postgres:/var/lib/postgresql/data',str(directory/'db-password')+':/run/secrets/db-password:ro'],
        'healthcheck':{'test':['CMD-SHELL','pg_isready -U suite_admin -d makit'],'interval':'2s','timeout':'3s','retries':60},
        'stop_grace_period':'60s','mem_limit':'768m','restart':'no'},
      'redis':{'image':release['images']['redis']['id'], 'labels':labels,'command':['redis-server','--appendonly','no','--save','60','1'],
        'volumes':['redis:/data'],'healthcheck':{'test':['CMD','redis-cli','ping'],'interval':'2s','timeout':'3s','retries':30},'stop_grace_period':'30s','mem_limit':'256m','restart':'no'},
      'core':{'image':release['images']['core']['id'], 'labels':labels,'user':str(os.getuid())+':'+str(os.getgid()),
        'init':True,'volumes':[str(directory/'state')+':/state'],
        'depends_on':{'postgres':{'condition':'service_healthy'},'redis':{'condition':'service_healthy'}},
        'healthcheck':{'test':['CMD','node','deploy/runtime/health.mjs'],'interval':'3s','timeout':'12s','retries':60,'start_period':'90s'},
        'stop_grace_period':'40s','mem_limit':'3g','restart':'no','security_opt':['no-new-privileges:true'], 'cap_drop':['ALL']},
      'gateway':{'image':release['images']['gateway']['id'],'labels':labels,'user':str(os.getuid())+':'+str(os.getgid()),
        'command':['caddy','run','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'],
        'environment':{'XDG_CONFIG_HOME':'/tmp/config','XDG_DATA_HOME':'/tmp/data'},
        'tmpfs':['/config','/data'],
        'volumes':gateway_volumes,'ports':port_bindings,
        'networks':['default','ingress'],'depends_on':{'core':{'condition':'service_healthy'}},
        # Official Caddy binary carries this file capability. Its bounding set
        # must include it even when listening on unprivileged container ports.
        'mem_limit':'128m','restart':'no','security_opt':['no-new-privileges:true'],'cap_drop':['ALL'],'cap_add':['NET_BIND_SERVICE']}},
      'networks':{'default':{'name':project+'-net','internal':True,'labels':labels,'ipam':{'config':[{'subnet':instance['subnet']}]}},
        'ingress':{'name':project+'-ingress','labels':labels,'ipam':{'config':[{'subnet':instance['ingressSubnet']}]}}},
      'volumes':{key:{'name':project+'-'+key,'labels':labels} for key in ['postgres','redis']}}

class Deployment:
    def __init__(self, directory):
        self.path = Path(directory).absolute()
        if self.path.is_symlink(): raise Failure('Deployment directory must not be a link')
        private(self.path)
        self.instance = read(self.path/'instance.json')
        if not re.fullmatch(r'[a-f0-9]{16}', self.instance.get('id','')): raise Failure('Invalid deployment identity')
        self.release = read(self.path/'release.json')
        self.project = 'cobuild-' + self.instance['id']
    @contextlib.contextmanager
    def lock(self):
        with open(self.path/'operation.lock','a') as stream:
            os.chmod(stream.name,0o600)
            try: fcntl.flock(stream,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError: raise Failure('Another deployment operation is running')
            try: yield
            finally: fcntl.flock(stream,fcntl.LOCK_UN)
    def check_owned(self):
        for kind, names in [('container',[self.project+'-'+s+'-1' for s in ['core','postgres','redis','gateway']]+[self.project+'-migration']),
                            ('volume',[self.project+'-'+s for s in ['postgres','redis']]),('network',[self.project+'-net',self.project+'-ingress'])]:
            for name in names:
                result = subprocess.run(['docker',kind,'inspect',name],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
                if result.returncode: continue
                value = json.loads(result.stdout)[0]
                labels = value.get('Config',value).get('Labels') or {}
                if labels.get('cobuild.deployment') != self.instance['id']: raise Failure('Resource ownership mismatch: '+name)
    def compose(self, *args, timeout=240):
        self.check_owned()
        return docker('compose','--project-name',self.project,'--file',self.path/'compose.json',*args,timeout=timeout)
    def configure(self, release=None):
        config=read(self.path/'state/config.json')
        transport=checked_ingress(ingress.descriptor,self.path)
        text=checked_ingress(ingress.gateway_text,config,transport)
        with open(self.path/'Caddyfile','w',opener=lambda p,f:os.open(p,f,0o600)) as stream:stream.write(text)
        write(self.path/'compose.json',compose_value(self.path,self.instance,release or self.release))
    def status(self):
        return self.compose('ps','-a','--format','json').decode()
    def stop(self, require_clean=False):
        self.stop_migration()
        self.compose('stop',timeout=180)
        for service in ['core','postgres','redis','gateway']:
            name=self.project+'-'+service+'-1'
            result=subprocess.run(['docker','inspect',name],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
            if result.returncode:continue
            state=json.loads(result.stdout)[0]['State']
            if state['Running'] or require_clean and (state.get('OOMKilled') or state['ExitCode'] not in [0,143]):
                raise Failure('Service did not stop cleanly: '+service+'; inspect its private logs')
    def schema_state(self):
        path=self.path/'state/schema-state.json'
        if not path.exists():return None
        private(path)
        value=read(path)
        checked_policy(policy.validate_state,value)
        return value
    def schema_allowed(self, release):
        state=self.schema_state()
        if state:
            if state['status']=='migrating' or release['contract']['schema'] not in state['compatibleSchemas']:
                raise Failure('Database schema is not compatible with this application; recover or complete its migration')
        elif not policy.same_schema(release['contract'],self.release['contract']):
            raise Failure('Schema change requires an explicit migration plan')
        elif (self.path/'state/runtime.json').exists() and not policy.same_schema(read(self.path/'state/runtime.json'),self.release['contract']):
            raise Failure('Stored runtime contract differs from the active release')
    def preflight(self, release=None, for_migration=False, ingress_override=None):
        release = validate_release(release or self.release)
        private(self.path/'state'); private(self.path/'state/secrets.json')
        if not for_migration:self.schema_allowed(release)
        # Static validation must not edit the live compatibility grant. It also
        # works with the immutable 0.4 runtime, which checks exact contracts.
        with tempfile.TemporaryDirectory(prefix='.cobuild-preflight-',dir=self.path.parent) as tmp:
            tmp=Path(tmp);os.chmod(tmp,0o700)
            for name in ['config.json','secrets.json']:shutil.copyfile(self.path/'state'/name,tmp/name);os.chmod(tmp/name,0o600)
            write(tmp/'runtime.json',release['contract'])
            docker('run','--rm','--network','none','--user',str(os.getuid())+':'+str(os.getgid()),
                   '--mount','type=bind,src='+str(tmp)+',dst=/state,readonly',
                   '--entrypoint','node',release['images']['core']['id'],'deploy/runtime/start.mjs','--check')
        transport=checked_ingress(ingress.descriptor,self.path,ingress_override)
        if transport:
            self.ingress_check('-i','--network','none','--user',str(os.getuid())+':'+str(os.getgid()),
                '--cap-drop','ALL','--security-opt','no-new-privileges:true','--read-only','--memory','256m','--pids-limit','64',
                '--mount','type=bind,src='+str(self.path/'state')+',dst=/state,readonly',
                '--entrypoint','node',release['images']['core']['id'],'--input-type=module','-',json.dumps(transport),
                input=(ROOT/'deploy/runtime/check-tls.mjs').read_bytes())
            with tempfile.TemporaryDirectory(prefix='.cobuild-ingress-',dir=self.path.parent) as tmp:
                tmp=Path(tmp);os.chmod(tmp,0o700)
                (tmp/'Caddyfile').write_text(checked_ingress(ingress.gateway_text,read(self.path/'state/config.json'),transport))
                os.chmod(tmp/'Caddyfile',0o600)
                self.ingress_check('--network','none','--user',str(os.getuid())+':'+str(os.getgid()),
                    '--cap-drop','ALL','--cap-add','NET_BIND_SERVICE','--security-opt','no-new-privileges:true',
                    '--read-only','--tmpfs','/tmp:rw,nosuid,size=16m','-e','XDG_DATA_HOME=/tmp/data','-e','XDG_CONFIG_HOME=/tmp/config',
                    '--mount','type=bind,src='+str(tmp)+',dst=/check,readonly',
                    '--mount','type=bind,src='+str(self.path/'state/ingress'/transport['generation'])+',dst=/etc/cobuild/tls,readonly',
                    '--entrypoint','timeout',release['images']['gateway']['id'],'30','caddy','validate','--config','/check/Caddyfile','--adapter','caddyfile')
    def ingress_check(self,*arguments,input=None):
        name=self.project+'-tls-check-'+uuid.uuid4().hex[:16]
        try:
            return docker('run','--rm','--name',name,'--label','cobuild.deployment='+self.instance['id'],
                '--label','cobuild.tls-check=true',*arguments,input=input,timeout=40)
        finally:
            result=subprocess.run(['docker','container','inspect',name],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
            if result.returncode==0:
                value=json.loads(result.stdout)[0]
                if (value['Config'].get('Labels') or {}).get('cobuild.deployment')!=self.instance['id']:raise Failure('TLS check ownership differs')
                docker('rm','-f',name)
    def configure_tls(self,sources):
        pending=(self.path/'pending.json').exists()
        self.check_owned()
        for name in [self.project+'-'+s+'-1' for s in ['core','gateway','postgres','redis']]+[self.project+'-migration']:
            result=subprocess.run(['docker','inspect','--format','{{.State.Running}}',name],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
            if result.returncode==0 and result.stdout.strip()==b'true':raise Failure('Stop this deployment before changing TLS')
        # Transport repair is safe while pending only because every owned
        # writer is stopped. It never grants schema compatibility or clears pending.
        value=checked_ingress(ingress.install,self.path,sources,lambda v:self.preflight(for_migration=pending,ingress_override=v),write)
        self.configure()
        return {'mode':'tls','generation':value['generation']}
    def up(self):
        if (self.path/'pending.json').exists(): raise Failure('Interrupted upgrade: run recover before starting')
        self.preflight(); self.configure(); self.activate_runtime(self.release); self.start_wait()
    def activate_runtime(self,release):
        self.schema_allowed(release)
        write(self.path/'state/runtime.json',release['contract'])
    def start_databases(self):
        self.compose('up','-d','--pull','never','--wait','--wait-timeout','90','postgres','redis',timeout=120)
        # Initialize only absent database/role, never change existing credentials.
        s=read(self.path/'state/secrets.json')
        password=s['weknowDatabase']
        if not re.fullmatch(r'[a-f0-9]{64}',password): raise Failure('Invalid database secret')
        sql="SELECT 'CREATE ROLE weknow_owner LOGIN PASSWORD ''"+password+"''' WHERE NOT EXISTS(SELECT FROM pg_roles WHERE rolname='weknow_owner');\n\\gexec\nSELECT 'CREATE DATABASE weknow OWNER weknow_owner' WHERE NOT EXISTS(SELECT FROM pg_database WHERE datname='weknow');\n\\gexec\n"
        docker('exec','-i',self.project+'-postgres-1','psql','-v','ON_ERROR_STOP=1','-U','suite_admin','-d','makit',input=sql.encode())
    def start_wait(self, release=None):
        self.schema_allowed(release or self.release)
        self.start_databases()
        self.compose('up','-d','--pull','never','--wait','--wait-timeout','210',timeout=240)
        cfg=read(self.path/'state/config.json')
        for app,path in [('platform','/healthz'),('makit','/readyz'),('weknow','/api/auth/identity/status')]:
            if app not in cfg['modules']:continue
            for attempt in range(20):
                try:
                    if checked_ingress(ingress.probe,self.path,self.instance,cfg,app,path):break
                except OSError:pass
                time.sleep(.25)
            else:raise Failure('Published entry is not healthy: '+app)
    def down(self):
        self.stop_migration()
        self.compose('down', '--timeout','40',timeout=180)
    def snapshot(self, output, resume=True):
        output = Path(output).absolute()
        if output.exists() or output.is_relative_to(self.path): raise Failure('Backup destination must be new and outside the deployment')
        if not output.parent.is_dir(): raise Failure('Backup parent does not exist')
        if (self.path/'pending.json').exists(): raise Failure('Finish interrupted upgrade before taking a backup')
        self.preflight(); self.configure()
        if not (self.path/'state/platform/identity.sqlite').is_file(): raise Failure('Initialize the suite before taking a backup')
        self.check_owned()
        for key in ['postgres','redis']:
            docker('volume','inspect',self.project+'-'+key)
        # Establish a consistent cut across both databases, SQLite, files and Redis.
        was_running = self.core_running()
        staging = Path(tempfile.mkdtemp(prefix='.cobuild-backup-',dir=output.parent)); os.chmod(staging,0o700)
        completed=False
        try:
            self.stop(require_clean=True)
            copy_private_tree(self.path/'state', staging/'state')
            write(staging/'release.json',self.release)
            write(staging/'instance.json',self.instance)
            for key in ['postgres','redis']:
                with open(staging/(key+'.tar'),'xb') as target:
                    os.chmod(target.name,0o600)
                    docker('run','--rm','--network','none','--mount',f'type=volume,src={self.project}-{key},dst=/volume,readonly',
                           '--entrypoint','tar',self.release['images'][key]['id'],'-C','/volume','-cf','-','.',output=target)
                validate_tar(staging/(key+'.tar'))
            manifest = {'format':1,'kind':'cold-core-snapshot','createdAt':int(time.time()),'release':self.release,
              'files':{str(p.relative_to(staging)):{'sha256':digest(p),'size':p.stat().st_size} for p in files(staging)}}
            write(staging/'manifest.json',manifest); verify_snapshot(staging)
            for path in files(staging):
                with open(path,'rb') as stream:os.fsync(stream.fileno())
            os.rename(staging,output)
            sync_directory(output.parent)
            completed=True
        except BaseException:
            shutil.rmtree(staging,ignore_errors=True); raise
        finally:
            if was_running and (resume or not completed): self.start_wait()
        return output
    def core_running(self):
        result = subprocess.run(['docker','inspect','--format','{{.State.Running}}',self.project+'-core-1'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        return result.returncode == 0 and result.stdout.strip()==b'true'
    def recover_owner(self):
        if (self.path/'pending.json').exists():raise Failure('Finish the interrupted upgrade before owner recovery')
        self.preflight()
        output=docker('run','--rm','--network','none','--user',str(os.getuid())+':'+str(os.getgid()),
            '--mount','type=bind,src='+str(self.path/'state')+',dst=/state',
            '-e','COBUILD_CONFIG=/state/config.json','-e','COBUILD_DATA_DIR=/state/platform',
            '--entrypoint','node',self.release['images']['core']['id'],'tools/recover-owner.mjs')
        result=json.loads(output)
        name=result.get('recoveryFile','')
        if not re.fullmatch(r'/state/platform/owner-recovery-[0-9]+\.private\.txt',name):raise Failure('Unexpected recovery receipt')
        return {'recoveryFile':str(self.path/name.lstrip('/')),'expiresAt':result['expiresAt']}
    def stop_migration(self):
        name=self.project+'-migration'
        result=subprocess.run(['docker','container','inspect',name],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        if result.returncode:return
        value=json.loads(result.stdout)[0]
        if (value['Config'].get('Labels') or {}).get('cobuild.deployment')!=self.instance['id']:raise Failure('Migration helper ownership differs')
        docker('rm','-f',name)
    def migration_history(self, release=None):
        release=release or self.release
        if release.get('migration',{}).get('kind') in ['core-managed-v1','core-runtime-v1','core-project-transfer-v1']:
            if self.core_running():raise Failure('Stop core writers before inspecting migration state')
            raw=docker('run','--rm','--network',self.project+'-net','--user',str(os.getuid())+':'+str(os.getgid()),
                '--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','512m','--pids-limit','128','--read-only',
                '--mount','type=bind,src='+str(self.path/'state')+',dst=/state',
                '--entrypoint','node',release['images']['core']['id'],'deploy/runtime/migrate.mjs','--inspect-core',timeout=60)
            return json.loads(raw)

        query="SELECT COALESCE(json_object_agg(name,sha256),'{}'::json) FROM makit_schema_migration;"
        raw=docker('exec','-i',self.project+'-postgres-1','psql','-X','-A','-t','-v','ON_ERROR_STOP=1','-U','suite_admin','-d','makit',input=query.encode())
        return json.loads(raw)
    def finish_migration_state(self, old, new, evidence):
        progress=checked_policy(policy.reconcile_history,evidence['baseLedger'],evidence['newLedger'],self.migration_history(new))
        state={'format':1,'baseContract':old['contract'],'targetContract':new['contract'],
            'targetImage':new['images']['core']['id'],'transition':new['migration'],**evidence,**progress}
        state['status']='complete' if progress['complete'] else 'partial' if progress['applied'] else 'not_applied'
        state['compatibleSchemas']=policy.compatible_schemas(new['migration'],old['contract']['schema'],new['contract']['schema'],progress['applied'],progress['complete'])
        state['actualSchema']=new['contract']['schema'] if progress['complete'] else None if progress['applied'] else old['contract']['schema']
        write(self.path/'state/schema-state.json',state)
        return state
    def migration_for(self, release):
        before=after=None
        if release['images']['core']['id']!=self.release['images']['core']['id']:
            before=schema_manifest(self.release['images']['core']['id']);after=schema_manifest(release['images']['core']['id'])
            drivers=['apps/makit/scripts/selfhost/migrate.cjs','apps/makit/scripts/selfhost/set-runtime-password.cjs']
            if any(before['files'].get(p)!=after['files'].get(p) for p in drivers):raise Failure('Migration drivers changed without a reviewed lifecycle update')
        if policy.same_schema(release['contract'],self.release['contract']):
            if before is not None:
                if before['files']!=after['files']:raise Failure('Schema inventory or migration drivers changed without an explicit supported transition')
            self.schema_allowed(release);return None
        state=self.schema_state()
        if state and state['status']!='migrating' and release['contract']['schema'] in state['compatibleSchemas']:
            return None
        if not release.get('migration'):raise Failure('Schema change requires an explicit additive migration plan')
        if release['migration']['kind'] in ['core-managed-v1','core-runtime-v1','core-project-transfer-v1'] and not {'kick','weknow'}<=set(read(self.path/'state/config.json')['modules']):raise Failure('Core migration requires initialized Kick and WeKnow')
        if release['migration']['kind']=='makit-additive-v1' and 'makit' not in read(self.path/'state/config.json')['modules']:raise Failure('Enable Makit and initialize its database before migrating its schema')
        evidence=checked_policy(policy.authorize_transition,self.release,release,schema_manifest(self.release['images']['core']['id']),schema_manifest(release['images']['core']['id']))
        if state:
            if state['status']=='migrating':raise Failure('Migration state needs recovery')
            if state['status']=='partial':
                checked_policy(policy.validate_repair,state,evidence)
            elif state['actualSchema']!=self.release['contract']['schema']:
                raise Failure('First return to the application matching the materialized database schema')
        return evidence
    def apply_migration(self, old, new, evidence, pending):
        self.start_databases()
        # Check the entire old ledger and any previously committed prefix before
        # executing another statement. Existing migration files are immutable.
        checked_policy(policy.reconcile_history,evidence['baseLedger'],evidence['newLedger'],self.migration_history(new))
        state={'format':1,'status':'migrating','baseContract':old['contract'],'targetContract':new['contract'],
            'targetImage':new['images']['core']['id'],'transition':new['migration'],**evidence,
            'applied':[],'complete':False,'actualSchema':None,'compatibleSchemas':[]}
        write(self.path/'state/schema-state.json',state)
        write(self.path/'state/schema-release.json',new)
        pending['phase']='migrating';write(self.path/'pending.json',pending)
        try:
            docker('run','--rm','--name',self.project+'-migration','--label','cobuild.deployment='+self.instance['id'],
                '--network',self.project+'-net','--user',str(os.getuid())+':'+str(os.getgid()),
                '--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','512m','--pids-limit','128','--read-only',
                '--mount','type=bind,src='+str(self.path/'state')+',dst=/state'+('' if new['migration']['kind'] in ['core-managed-v1','core-runtime-v1','core-project-transfer-v1'] else ',readonly'),
                '--entrypoint','node',new['images']['core']['id'],'deploy/runtime/migrate.mjs',*(['--core'] if new['migration']['kind'] in ['core-managed-v1','core-runtime-v1','core-project-transfer-v1'] else []),timeout=180)
        finally:self.stop_migration()
        state=self.finish_migration_state(old,new,evidence)
        if state['status']!='complete':raise Failure('Candidate did not finish the declared migration history')
        pending['phase']='migrated';write(self.path/'pending.json',pending)
    def upgrade(self, release):
        release = validate_release(release)
        if (self.path/'pending.json').exists(): raise Failure('Another upgrade needs recovery')
        if any(release['images'].get(k) != self.release['images'].get(k) for k in ['postgres','redis','gateway']):raise Failure('Infrastructure image changes need a separate migration')
        evidence=self.migration_for(release)
        self.preflight(release,for_migration=evidence is not None)
        previous = self.release
        backups=self.path.parent/'upgrade-backups';backups.mkdir(exist_ok=True,mode=0o700);private(backups)
        backup=self.snapshot(backups/(self.instance['id']+'-'+str(time.time_ns())),resume=False)
        pending={'previous':previous,'candidate':release,'phase':'prepared','backup':str(backup),'migrationEvidence':evidence}
        write(self.path/'pending.json',pending)
        try:
            self.stop(); self.configure(release)
            if evidence:self.apply_migration(previous,release,evidence,pending)
            self.activate_runtime(release);self.start_wait(release)
            write(self.path/'previous.json',previous); write(self.path/'release.json',release)
            self.release=release; remove_record(self.path/'pending.json')
        except BaseException:
            # Only validated additive migrations may retain new schema while
            # returning to an older application. Never restore an old snapshot.
            self.recover(); raise
    def resume_upgrade(self, replacement=None):
        pending=read(self.path/'pending.json')
        # An interrupted readiness check may have left writers alive. Stop only
        # this deployment, even when the supplied repair artifact is invalid.
        self.stop()
        old=validate_release(pending['previous']);new=validate_release(pending['candidate'])
        evidence=checked_policy(policy.authorize_transition,old,new,schema_manifest(old['images']['core']['id']),schema_manifest(new['images']['core']['id']))
        if evidence!=pending.get('migrationEvidence'):raise Failure('Resume evidence differs')
        try:
            if replacement is not None:
                replacement=validate_release(replacement)
                checked_policy(policy.validate_runtime_repair,new,replacement,
                    schema_manifest(new['images']['core']['id']),schema_manifest(replacement['images']['core']['id']))
                self.preflight(replacement,for_migration=True)
                repairs=pending.get('repairs',[])
                if len(repairs)>=32:raise Failure('Too many repair attempts; inspect retained recovery history')
                pending['repairs']=[*repairs,{'candidate':new,'replacement':replacement,'at':time.time_ns()}]
                pending['candidate']=replacement
                # Atomic pending update precedes any new runtime activation.
                write(self.path/'pending.json',pending)
                new=replacement
            self.preflight(new,for_migration=True);self.configure(new)
            self.apply_migration(old,new,evidence,pending)
            self.activate_runtime(new);self.start_wait(new)
            write(self.path/'previous.json',old);write(self.path/'release.json',new)
            if pending.get('repairs'):write(self.path/'last-recovery.json',pending)
            self.release=new;remove_record(self.path/'pending.json')
        except BaseException:
            # A readiness failure can leave partially running writers. Preserve
            # pending, stop this deployment, and require explicit forward retry.
            self.stop()
            raise
    def recover(self):
        pending = read(self.path/'pending.json')
        # A pending controller may have died after starting the candidate.
        # Quiesce owned consumers even if its artifacts or evidence now fail validation.
        self.stop()
        old=validate_release(pending['previous']); new=validate_release(pending['candidate'])
        evidence=pending.get('migrationEvidence')
        if evidence:
            expected=checked_policy(policy.authorize_transition,old,new,schema_manifest(old['images']['core']['id']),schema_manifest(new['images']['core']['id']))
            if evidence!=expected:raise Failure('Recovery migration evidence differs')
        elif not policy.same_schema(old['contract'],new['contract']):
            state=self.schema_state()
            if not state or state['status']=='migrating' or any(v['contract']['schema'] not in state['compatibleSchemas'] for v in [old,new]):raise Failure('No compatible application recovery path')
        # Certificate failure must leave writers stopped, with a repairable
        # pending record rather than starting an unreachable business service.
        self.preflight(old,for_migration=True)
        self.configure(old)
        if evidence:
            self.start_databases()
            state=self.finish_migration_state(old,new,evidence)
            if old['contract']['schema'] not in state['compatibleSchemas']:raise Failure('Core security migration committed; old runtime remains stopped. Repair the candidate and use resume-upgrade; data and backup are retained.')
        self.activate_runtime(old);self.start_wait(old)
        write(self.path/'release.json',old); self.release=old; remove_record(self.path/'pending.json')

def copy_private_tree(source, target):
    list(files(source))  # Reject links before copying anything.
    shutil.copytree(source,target)
    for p in [target,*target.rglob('*')]: os.chmod(p,0o700 if p.is_dir() else 0o600)

def validate_tar(path):
    with tarfile.open(path,'r:') as archive:
        members=archive.getmembers()
        if not members: raise Failure('Empty database snapshot')
        seen=set()
        for m in members:
            p=PurePosixPath(m.name)
            if p.is_absolute() or '..' in p.parts or not (m.isfile() or m.isdir()): raise Failure('Unsafe snapshot archive')
            if str(p) in seen: raise Failure('Duplicate snapshot archive path')
            seen.add(str(p))
        if Path(path).name=='postgres.tar':
            version=next((m for m in members if str(PurePosixPath(m.name))=='PG_VERSION'),None)
            if not version or archive.extractfile(version).read(32).strip()!=b'17': raise Failure('Unsupported or incomplete PostgreSQL snapshot')

def verify_snapshot(directory):
    directory = Path(directory); private(directory)
    manifest = read(directory/'manifest.json')
    if manifest.get('format')!=1 or manifest.get('kind')!='cold-core-snapshot': raise Failure('Unsupported snapshot')
    expected=manifest.get('files',{})
    required={'state/config.json','state/secrets.json','state/runtime.json','state/platform/identity.sqlite','release.json','instance.json','postgres.tar','redis.tar'}
    if not required.issubset(expected): raise Failure('Incomplete snapshot')
    actual={str(p.relative_to(directory)) for p in files(directory)}-{'manifest.json'}
    if actual!=set(expected): raise Failure('Snapshot file list differs')
    for name, info in expected.items():
        p=PurePosixPath(name)
        if p.is_absolute() or '..' in p.parts or str(p)!=name: raise Failure('Invalid snapshot path')
        path=directory/name
        private(path)
        if path.stat().st_size != info['size'] or digest(path)!=info['sha256']: raise Failure('Snapshot integrity check failed')
    if read(directory/'release.json') != manifest['release']: raise Failure('Snapshot release mismatch')
    for key in ['postgres','redis']: validate_tar(directory/(key+'.tar'))
    return manifest

def initialize(directory, config, release, ports, subnet=None, tls_sources=None):
    directory=Path(directory).absolute()
    if directory.exists() or directory.is_symlink(): raise Failure('Deployment destination already exists')
    validate_release(release)
    if len(set(ports.values()))!=3 or any(not isinstance(p,int) or p<1024 or p>65535 for p in ports.values()): raise Failure('Use three distinct unprivileged ports')
    subnet=ipaddress.ip_network(subnet or available_subnet())
    if subnet.version!=4 or subnet.prefixlen!=24 or not subnet.is_private:raise Failure('Use a private IPv4 /24')
    directory.mkdir(mode=0o700)
    try:
        (directory/'state').mkdir(mode=0o700)
        write(directory/'state/config.json',config)
        write(directory/'state/secrets.json',{k:secrets.token_hex(32) for k in ['database','makitDatabase','weknowDatabase','makitSession','weknowSession']})
        write(directory/'release.json',release)
        write(directory/'instance.json',{'format':1,'id':uuid.uuid4().hex[:16],'ports':ports,'subnet':str(subnet),'ingressSubnet':available_subnet([subnet])})
        prepare_private_files(directory)
        dep=Deployment(directory)
        if tls_sources:checked_ingress(ingress.install,directory,tls_sources,lambda v:dep.preflight(ingress_override=v),write)
        else:dep.preflight()
        dep.configure()
    except BaseException:
        shutil.rmtree(directory); raise
    return dep

def prepare_private_files(directory):
    s=read(directory/'state/secrets.json')
    with open(directory/'db-password','w',opener=lambda p,f:os.open(p,f,0o600)) as f: f.write(s['database'])
    # Strong generated hexadecimal values only; no caller-supplied SQL fragments.
    if not all(re.fullmatch(r'[a-f0-9]{64}',s[k]) for k in ['database','weknowDatabase']): raise Failure('Invalid database secret')
    sql="CREATE ROLE weknow_owner LOGIN PASSWORD '"+s['weknowDatabase']+"';\nCREATE DATABASE weknow OWNER weknow_owner;\n"
    with open(directory/'init.sql','w',opener=lambda p,f:os.open(p,f,0o600)) as f:f.write(sql)

def restore(directory, backup, tls_sources=None):
    backup=Path(backup).absolute(); manifest=verify_snapshot(backup); validate_release(manifest['release'])
    directory=Path(directory).absolute()
    if directory.exists() or directory.is_symlink(): raise Failure('Restore requires a new empty destination')
    directory.mkdir(mode=0o700)
    try:
        copy_private_tree(backup/'state',directory/'state')
        write(directory/'release.json',manifest['release'])
        instance=read(backup/'instance.json'); instance['id']=uuid.uuid4().hex[:16];instance['subnet']=available_subnet();instance['ingressSubnet']=available_subnet([instance['subnet']]);write(directory/'instance.json',instance)
        prepare_private_files(directory)
        dep=Deployment(directory)
        if tls_sources:checked_ingress(ingress.install,directory,tls_sources,lambda v:dep.preflight(ingress_override=v),write)
        else:dep.preflight()
        dep.configure();dep.check_owned()
        # Create containers/volumes without starting any database or application.
        dep.compose('create','--pull','never')
        for key in ['postgres','redis']:
            with open(backup/(key+'.tar'),'rb') as source:
                result=subprocess.run(['docker','run','--rm','--network','none','-i','--mount',f'type=volume,src={dep.project}-{key},dst=/volume',
                    '--entrypoint','sh',dep.release['images'][key]['id'],'-c','test -z "$(ls -A /volume)" && tar -C /volume -xf -'],stdin=source,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=240)
            if result.returncode:raise Failure('Database restore failed; isolated target retained stopped')
        write(directory/'restored.json',{'verified':True,'createdAt':int(time.time())})
    except BaseException:
        # Never start a partially restored target; preserve it for inspection.
        write(directory/'restore-failed.json',{'failed':True})
        raise
    return dep

def tls_arguments(args):
    requested=any(value is not None for value in [args.tls_cert,args.tls_key,args.tls_ca])
    if requested or args.action=='tls-configure':
        if not args.tls_cert or not args.tls_key or args.tls_ca is not None and not args.tls_ca:
            raise Failure('Provide nonempty --tls-cert and --tls-key together, with optional --tls-ca')
        return {'cert.pem':args.tls_cert,'key.pem':args.tls_key,**({'ca.pem':args.tls_ca} if args.tls_ca else {})}
    return None

def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='action',required=True)
    p=sub.add_parser('seal');p.add_argument('--image',required=True);p.add_argument('--version',required=True);p.add_argument('--output',required=True);p.add_argument('--base-release');p.add_argument('--migration-plan')
    p=sub.add_parser('migration-sql');p.add_argument('--plan',required=True);p.add_argument('--output',required=True)
    p=sub.add_parser('init');p.add_argument('directory');p.add_argument('--release',required=True);p.add_argument('--config');p.add_argument('--ports',default='8080,8081,8082');p.add_argument('--subnet')
    p=sub.add_parser('restore');p.add_argument('directory');p.add_argument('--backup',required=True)
    p=sub.add_parser('verify-backup');p.add_argument('directory')
    for action in ['up','stop','down','status','backup','upgrade','rollback','recover','recover-owner','resume-upgrade','schema-status','tls-configure']:
        p=sub.add_parser(action);p.add_argument('directory')
        if action=='backup':p.add_argument('--output',required=True)
        if action=='upgrade':p.add_argument('--release',required=True)
        if action=='resume-upgrade':p.add_argument('--release')
    for action in ['init','restore','tls-configure']:
        target=sub.choices[action]
        for kind in ['cert','key','ca']:target.add_argument('--tls-'+kind)
    args=parser.parse_args()
    tls_sources=None
    if args.action in ['init','restore','tls-configure']:
        tls_sources=tls_arguments(args)
    if args.action=='migration-sql':
        entries=checked_policy(policy.generated_files,read(args.plan));directory=Path(args.output)
        if directory.is_symlink():raise Failure('Migration directory must not be a link')
        for name,sql in entries.items():
            path=directory/name
            if path.is_symlink() or path.exists() and path.read_text()!=sql:raise Failure('Migration source already exists and differs')
        directory.mkdir(parents=True,exist_ok=True,mode=0o700)
        for name,sql in entries.items():
            path=directory/name
            if not path.exists():
                with open(path,'x',opener=lambda p,f:os.open(p,f,0o600)) as stream:stream.write(sql)
        print('Generated '+str(len(entries))+' append-only SQL migration files');return
    if args.action=='verify-backup':verify_snapshot(args.directory);print('Backup integrity verified');return
    daemon()
    if args.action=='seal':seal(args.image,args.version,args.output,read(args.base_release) if args.base_release else None,read(args.migration_plan) if args.migration_plan else None);print('Release manifest sealed');return
    if args.action=='init':
        values=list(map(int,args.ports.split(',')))
        if len(values)!=3:raise Failure('Provide platform, Makit and WeKnow ports')
        ports=dict(zip(['platform','makit','weknow'],values))
        cfg=read(args.config) if args.config else {'schemaVersion':1,'organization':{'name':'My Team','slug':'my-team'},
            'origins':{k:'http://127.0.0.1:'+str(v) for k,v in ports.items()},'modules':['platform','kick','makit','weknow'],
            'identity':{'providers':['local'],'sessionDays':30,'selfRegistration':False},
            'integrations':dict.fromkeys(['feishu','github','mail','ai'],False),'delivery':{'externalMessages':False}}
        initialize(args.directory,cfg,read(args.release),ports,args.subnet,tls_sources);print('Deployment initialized; run up to start');return
    if args.action=='restore':restore(args.directory,args.backup,tls_sources);print('Restored into a new stopped deployment; run up after freeing its ports');return
    dep=Deployment(args.directory)
    with dep.lock():
        if (dep.path/'restore-failed.json').exists() and args.action not in ['status','down','stop']:raise Failure('Partial restore cannot start')
        if args.action=='backup':print(str(dep.snapshot(args.output)))
        elif args.action=='upgrade':dep.upgrade(read(args.release));print('Upgrade healthy; data retained')
        elif args.action=='rollback':dep.upgrade(read(dep.path/'previous.json'));print('Compatible application rollback healthy; data retained')
        elif args.action=='status':print(dep.status())
        elif args.action=='recover-owner':print(json.dumps(dep.recover_owner()))
        elif args.action=='resume-upgrade':dep.resume_upgrade(read(args.release) if args.release else None);print('Forward recovery healthy; data retained')
        elif args.action=='schema-status':print(json.dumps(dep.schema_state() or {'status':'base','actualSchema':dep.release['contract']['schema']},indent=2))
        elif args.action=='tls-configure':print(json.dumps(dep.configure_tls(tls_sources)))
        else:getattr(dep,args.action)();print(args.action+' completed')

if __name__=='__main__':
    try:main()
    except (Failure,ValueError,OSError,subprocess.TimeoutExpired) as error:
        print('Error: '+str(error),file=sys.stderr);raise SystemExit(1)
