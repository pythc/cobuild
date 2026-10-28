"""Disposable test CA only. No OS trust, DNS or real certificate operations."""
import os
from pathlib import Path
import subprocess
import shutil

def certificates(directory,names,tag='valid',days='2',ca_source=None):
    directory=Path(directory)/tag;directory.mkdir(mode=0o700)
    def run(*args):
        result=subprocess.run(['openssl',*map(str,args)],cwd=directory,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
        if result.returncode:
            log=directory/'failure.private.log';log.write_bytes(result.stderr);log.chmod(0o600)
            raise RuntimeError('Disposable certificate generation failed; see fixture private log')
    if ca_source:
        for name in ['ca.key','ca.pem']:shutil.copyfile(Path(ca_source)/name,directory/name)
    else:
        run('req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','2','-subj','/CN=CoBuild isolated test CA',
            '-keyout','ca.key','-out','ca.pem')
    run('req','-new','-newkey','rsa:2048','-nodes','-sha256','-subj','/CN='+names[0],'-keyout','key.pem','-out','server.csr')
    (directory/'extensions.cnf').write_text('[server_ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName='+','.join('DNS:'+n for n in names)+'\n')
    if days=='expired':
        (directory/'index.txt').touch();(directory/'serial').write_text('1000\n')
        (directory/'ca.cnf').write_text('[ca]\ndefault_ca=test_ca\n[test_ca]\ndatabase=index.txt\nserial=serial\nnew_certs_dir=.\ncertificate=ca.pem\nprivate_key=ca.key\ndefault_md=sha256\npolicy=names\n[names]\ncommonName=supplied\n')
        run('ca','-batch','-config','ca.cnf','-in','server.csr','-out','cert.pem','-notext','-startdate','20200101000000Z',
            '-enddate','20200102000000Z','-extfile','extensions.cnf','-extensions','server_ext')
    else:
        run('x509','-req','-in','server.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out','cert.pem',
            '-days',days,'-sha256','-extfile','extensions.cnf','-extensions','server_ext')
    for p in directory.iterdir():p.chmod(0o600)
    return {name:directory/name for name in ['cert.pem','key.pem','ca.pem']}
