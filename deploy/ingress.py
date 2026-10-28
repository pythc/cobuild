"""Private, opt-in TLS material and loopback-only verified health transport."""
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import socket
import ssl
import stat
import uuid
from urllib.parse import urlsplit

class IngressError(ValueError): pass

def material(path, secret=False):
    path=Path(path)
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW),'rb') as stream:
        info=os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size>1024*1024 or secret and info.st_mode&0o077:
            raise IngressError('TLS material must be a regular file; private keys require mode 0600')
        value=stream.read(1024*1024+1)
    if not value or len(value)>1024*1024:raise IngressError('Invalid TLS material size')
    return value

def descriptor(directory, override=None):
    directory=Path(directory)
    path=directory/'state/ingress.json'
    if override is None:
        if path.is_symlink():raise IngressError('Unsafe ingress descriptor')
        if not path.exists():
            parent=directory/'state/ingress'
            if parent.is_symlink() or parent.exists() and (not parent.is_dir() or any(parent.iterdir())):raise IngressError('TLS material exists without its committed descriptor; refuse plaintext fallback')
            return None
        if path.stat().st_mode&0o077:raise IngressError('Unsafe ingress descriptor')
        value=json.loads(path.read_text())
    else:value=override
    if not isinstance(value,dict) or set(value)!={'format','mode','generation','sha256'} or type(value['format']) is not int or value['format']!=1 or value['mode']!='tls' or not isinstance(value['generation'],str) or not re.fullmatch('[a-f0-9]{32}',value['generation']):
        raise IngressError('Invalid TLS ingress descriptor')
    hashes=value['sha256']
    if not isinstance(hashes,dict) or set(hashes) not in [{'cert.pem','key.pem'},{'cert.pem','key.pem','ca.pem'}]:raise IngressError('Invalid TLS file inventory')
    bundle=directory/'state/ingress'/value['generation']
    for parent in [directory/'state/ingress',bundle]:
        if parent.is_symlink() or not parent.is_dir() or parent.stat().st_mode&0o077:raise IngressError('Unsafe TLS bundle directory')
    if {p.name for p in bundle.iterdir()}!=set(hashes):raise IngressError('TLS bundle file inventory differs')
    for name,expected in hashes.items():
        if not isinstance(expected,str) or not re.fullmatch('[a-f0-9]{64}',expected) or hashlib.sha256(material(bundle/name,secret=True)).hexdigest()!=expected:raise IngressError('TLS material differs from its descriptor')
    return value

def install(directory, sources, validate, write):
    """Publish one descriptor last. Interrupted preparation cannot replace it."""
    directory=Path(directory);generation=uuid.uuid4().hex
    for parent in [directory,directory/'state']:
        if parent.is_symlink() or not parent.is_dir() or parent.stat().st_mode&0o077:raise IngressError('TLS destination and state directory must be private regular directories')
    if not isinstance(sources,dict) or set(sources) not in [{'cert.pem','key.pem'},{'cert.pem','key.pem','ca.pem'}]:raise IngressError('Provide certificate and private key together')
    data={k:material(v,secret=k=='key.pem') for k,v in sources.items()}
    parent=directory/'state/ingress'
    if parent.is_symlink():raise IngressError('TLS bundle directory must not be a link')
    parent.mkdir(mode=0o700,exist_ok=True)
    if parent.stat().st_mode&0o077:raise IngressError('TLS bundle directory must be private')
    bundle=parent/generation;bundle.mkdir(mode=0o700)
    published=False
    try:
        for name,content in data.items():
            with open(bundle/name,'xb',opener=lambda p,f:os.open(p,f,0o600)) as stream:
                stream.write(content);stream.flush();os.fsync(stream.fileno())
        value={'format':1,'mode':'tls','generation':generation,'sha256':{k:hashlib.sha256(v).hexdigest() for k,v in data.items()}}
        descriptor(directory,value);validate(value)
        # Flush both directory entries before committing the descriptor.
        for path in [bundle,parent]:
            fd=os.open(path,os.O_RDONLY)
            try:os.fsync(fd)
            finally:os.close(fd)
        write(directory/'state/ingress.json',value);published=True
        return value
    finally:
        if not published:
            # A descriptor may have been renamed before a directory fsync error.
            # Never remove material already referenced by a committed record.
            record=directory/'state/ingress.json'
            try:referenced=json.loads(record.read_text()).get('generation')==generation
            except (OSError,ValueError,AttributeError):referenced=False
            if not referenced:shutil.rmtree(bundle)

def gateway_text(config, transport):
    text='{\n admin off\n auto_https off\n}\n'
    for i,app in enumerate(['platform','makit','weknow']):
        if app not in config['modules']:continue
        origin=urlsplit(config['origins'][app]);port=str(4100+i)
        if transport and origin.scheme!='https':raise IngressError('Managed TLS requires HTTPS for every enabled core origin')
        text+=('https://' if transport else '')+':'+port+' {\n'
        if transport:
            text+=' tls /etc/cobuild/tls/cert.pem /etc/cobuild/tls/key.pem\n'
            text+=' @wrongHost not header Host '+origin.netloc+'\n respond @wrongHost 421\n'
        text+=' reverse_proxy core:'+port+' {\n header_up Host {http.request.hostport}\n'
        if transport:text+=' header_up -Forwarded\n header_up X-Forwarded-Host {http.request.hostport}\n header_up X-Forwarded-Proto {http.request.scheme}\n'
        text+=' }\n}\n'
    return text

def probe(directory, instance, config, app, path):
    value=descriptor(directory);origin=urlsplit(config['origins'][app])
    port=instance['ports'][app]
    if value:
        bundle=Path(directory)/'state/ingress'/value['generation']
        context=ssl.create_default_context(cafile=str(bundle/'ca.pem') if 'ca.pem' in value['sha256'] else None)
        class LocalTLS(http.client.HTTPSConnection):
            def connect(self):
                sock=socket.create_connection(('127.0.0.1',port),timeout=2)
                try:self.sock=context.wrap_socket(sock,server_hostname=origin.hostname)
                except BaseException:sock.close();raise
        connection=LocalTLS(origin.hostname,port=port,timeout=2,context=context)
    else:connection=http.client.HTTPConnection('127.0.0.1',port,timeout=2)
    try:
        connection.request('GET',path,headers={'Host':origin.netloc})
        response=connection.getresponse();response.read()
        return response.status==200
    finally:connection.close()
