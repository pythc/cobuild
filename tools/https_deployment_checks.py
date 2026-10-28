"""Scoped HTTPS transport, certificate lifecycle and browser acceptance helpers."""
import http.client
import hashlib
import json
from pathlib import Path
import socket
import ssl
import shutil
import sys
import uuid
from urllib.parse import urlsplit
from tls_fixture import certificates

NAMES=['workbench.cobuild.test','makit.cobuild.test','weknow.cobuild.test']

def prepare(suite,directory,cfg,release,ports,check):
    valid=certificates(directory,NAMES)
    wrong=certificates(directory,['other.cobuild.test'],tag='wrong-host')
    expired=certificates(directory,NAMES,tag='expired',days='expired')
    cases={'hostname':wrong,'expired':expired,'private-key':{**valid,'key.pem':wrong['key.pem']},'ca':{**valid,'ca.pem':wrong['ca.pem']}}
    for name,sources in cases.items():
        target=directory/('invalid-tls-'+name)
        try:suite.initialize(target,cfg,release,ports,tls_sources=sources)
        except suite.Failure:pass
        else:raise AssertionError('Invalid TLS accepted: '+name)
        check(not target.exists(),'invalid '+name+' TLS material rejected before creating application resources')
    return valid,wrong

def entry_checks(suite,dep,check,ca):
    import ingress
    cfg=suite.read(dep.path/'state/config.json')
    for app,path in [('platform','/healthz'),('makit','/readyz'),('weknow','/api/auth/identity/status')]:
        check(ingress.probe(dep.path,dep.instance,cfg,app,path),app+' published HTTPS verifies CA and public hostname over loopback')
        public=urlsplit(cfg['origins'][app]);port=dep.instance['ports'][app]
        def connect(context,hostname):
            raw=socket.create_connection(('127.0.0.1',port),timeout=3)
            try:return context.wrap_socket(raw,server_hostname=hostname)
            except BaseException:raw.close();raise
        try:connect(ssl.create_default_context(),public.hostname).close()
        except ssl.SSLError:pass
        else:raise AssertionError('Untrusted test CA accepted')
        check(True,app+' rejects an untrusted CA without disabling verification')
        try:connect(ssl.create_default_context(cafile=str(ca)),'other.cobuild.test').close()
        except ssl.SSLError:pass
        else:raise AssertionError('Wrong TLS hostname accepted')
        check(True,app+' rejects the wrong certificate hostname')
        sock=connect(ssl.create_default_context(cafile=str(ca)),public.hostname)
        conn=http.client.HTTPConnection(public.hostname,port,timeout=3);conn.sock=sock
        try:
            conn.request('GET',path,headers={'Host':'other.cobuild.test','X-Forwarded-Host':public.netloc,'X-Forwarded-Proto':'https'})
            res=conn.getresponse();res.read();check(res.status==421,app+' rejects wrong Host despite forged proxy headers')
        finally:conn.close()
        conn=http.client.HTTPConnection('127.0.0.1',port,timeout=3)
        try:
            conn.request('GET',path,headers={'Host':public.netloc});res=conn.getresponse();res.read()
            check(res.status!=200,app+' TLS port does not silently serve plaintext')
        except (OSError,http.client.HTTPException):check(True,app+' TLS port does not silently serve plaintext')
        finally:conn.close()

def lifecycle_checks(suite,root,directory,dep,sources,wrong,check,preserve,run,env,browser,deployments):
    old=suite.read(dep.path/'state/ingress.json')
    try:dep.configure_tls(sources)
    except suite.Failure:pass
    else:raise AssertionError('Live TLS changed without stopping')
    check(suite.read(dep.path/'state/ingress.json')==old,'live certificate replacement refuses changes before stopping services')
    with dep.lock():
        dep.stop()
        try:dep.configure_tls({**sources,'key.pem':wrong['key.pem']})
        except suite.Failure:pass
        else:raise AssertionError('Mismatched replacement accepted')
        check(suite.read(dep.path/'state/ingress.json')==old,'failed certificate replacement retains the old committed descriptor')
        rotated=certificates(directory,NAMES,tag='rotated',ca_source=sources['ca.pem'].parent)
        dep.configure_tls(rotated)
        check(not dep.core_running(),'valid certificate replacement stays stopped until explicit startup')
        dep.up()
    check(suite.read(dep.path/'state/ingress.json')['generation']!=old['generation'],'certificate replacement commits a new private generation')
    preserve('https-rotated-session-files',dep)
    entry_checks(suite,dep,check,rotated['ca.pem'])
    # Test-only expired material models expiry while an upgrade is pending.
    # Product commands never accept this material through their installer.
    with dep.lock():
        dep.stop()
        suite.write(dep.path/'pending.json',{'previous':dep.release,'candidate':dep.release,'phase':'prepared','migrationEvidence':None})
        generation=uuid.uuid4().hex;bundle=dep.path/'state/ingress'/generation;bundle.mkdir(mode=0o700)
        hashes={}
        for name in ['cert.pem','key.pem','ca.pem']:
            shutil.copyfile(directory/'expired'/name,bundle/name);(bundle/name).chmod(0o600)
            hashes[name]=hashlib.sha256((bundle/name).read_bytes()).hexdigest()
        suite.write(dep.path/'state/ingress.json',{'format':1,'mode':'tls','generation':generation,'sha256':hashes})
    from local_process import captured
    failed=captured([sys.executable,'deploy/suite.py','recover',str(dep.path)],cwd=root,env=env,timeout=90)
    log=root/'.local/https-expired-pending.private.log';log.write_text(failed.stdout+failed.stderr);log.chmod(0o600)
    check(failed.returncode!=0 and (dep.path/'pending.json').exists(),'expired TLS blocks pending recovery without clearing its journal')
    check(all(suite.docker('inspect','--format','{{.State.Running}}',dep.project+'-'+s+'-1').strip()==b'false' for s in ['core','gateway','postgres','redis']),'failed TLS recovery leaves every business writer stopped')
    run('https-pending-transport-repair',[sys.executable,'deploy/suite.py','tls-configure',str(dep.path),
        '--tls-cert',str(rotated['cert.pem']),'--tls-key',str(rotated['key.pem']),'--tls-ca',str(rotated['ca.pem'])],env)
    check((dep.path/'pending.json').exists() and not dep.core_running(),'stopped pending recovery permits certificate repair without starting apps or granting schema compatibility')
    run('https-pending-recover',[sys.executable,'deploy/suite.py','recover',str(dep.path)],env)
    check(not (dep.path/'pending.json').exists() and dep.core_running(),'explicit recovery succeeds after certificate repair')
    preserve('https-pending-recovered-files',dep)
    snapshot=directory/'https-final-snapshot'
    with dep.lock():dep.snapshot(snapshot)
    expired_snapshot=directory/'https-expired-snapshot';shutil.copytree(snapshot,expired_snapshot)
    record=suite.read(expired_snapshot/'state/ingress.json');bundle=expired_snapshot/'state/ingress'/record['generation']
    for name in record['sha256']:
        shutil.copyfile(directory/'expired'/name,bundle/name);(bundle/name).chmod(0o600)
        record['sha256'][name]=hashlib.sha256((bundle/name).read_bytes()).hexdigest()
    suite.write(expired_snapshot/'state/ingress.json',record)
    manifest=suite.read(expired_snapshot/'manifest.json')
    for name,info in manifest['files'].items():
        path=expired_snapshot/name;info.update(size=path.stat().st_size,sha256=hashlib.sha256(path.read_bytes()).hexdigest())
    suite.write(expired_snapshot/'manifest.json',manifest)
    failed_target=directory/'https-expired-restore'
    try:suite.restore(failed_target,expired_snapshot)
    except suite.Failure:pass
    else:raise AssertionError('Expired snapshot started without certificate replacement')
    check((failed_target/'restore-failed.json').exists(),'restore with expired certificate remains marked failed')
    instance=suite.read(failed_target/'instance.json')
    check(not suite.docker('ps','-aq','--filter','label=cobuild.deployment='+instance['id']).strip(),'expired-certificate restore creates no application containers')
    with dep.lock():dep.down()
    dep=suite.restore(directory/'https-cert-restored',expired_snapshot,tls_sources=rotated);deployments.append(dep)
    with dep.lock():dep.up()
    preserve('https-new-cert-restored-files',dep)
    check(suite.verify_snapshot(expired_snapshot)['files']==manifest['files'],'replacement-certificate restore leaves the source snapshot unchanged')
    if browser:
        import os
        module=os.environ.get('COBUILD_PLAYWRIGHT_MODULE')
        if not module or not Path(module).is_file():raise RuntimeError('Set COBUILD_PLAYWRIGHT_MODULE to an installed Playwright entry point for browser acceptance')
        executable=os.environ.get('COBUILD_CHROMIUM_EXECUTABLE')
        if executable and not Path(executable).is_file():raise RuntimeError('Configured Chromium executable is unavailable')
        environment={**env,'COBUILD_CONFIG':str(dep.path/'state/config.json'),'COBUILD_DATA_DIR':str(dep.path/'state/platform'),
            **({'COBUILD_CHROMIUM_EXECUTABLE':executable} if executable else {}),
            'COBUILD_PLAYWRIGHT_MODULE':module,'COBUILD_TEST_TLS_CERT':str(rotated['cert.pem']),
            'COBUILD_BROWSER_STATE':str(directory/'browser.private.json'),'COBUILD_BROWSER_SCREENSHOT':str(root/'.local/https-browser.png')}
        run('https-browser',['node','tests/https-browser.mjs'],environment)
    return dep
