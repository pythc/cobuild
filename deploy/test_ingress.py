import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
import ingress
import suite

class IngressTests(unittest.TestCase):
    def test_empty_explicit_tls_arguments_cannot_silently_select_plaintext(self):
        from types import SimpleNamespace
        self.assertIsNone(suite.tls_arguments(SimpleNamespace(action='init',tls_cert=None,tls_key=None,tls_ca=None)))
        for cert,key,ca in [('', '',None),('cert',None,None),(None,None,'ca'),('cert','key','')]:
            with self.assertRaises(suite.Failure):suite.tls_arguments(SimpleNamespace(action='init',tls_cert=cert,tls_key=key,tls_ca=ca))
        self.assertEqual(suite.tls_arguments(SimpleNamespace(action='init',tls_cert='cert',tls_key='key',tls_ca=None)),{'cert.pem':'cert','key.pem':'key'})
    def fixtures(self,root):
        (root/'state').mkdir(mode=0o700)
        sources={}
        for name in ['cert.pem','key.pem','ca.pem']:
            path=root/name;path.write_text('synthetic '+name);path.chmod(0o600);sources[name]=path
        return sources
    def test_failed_validation_preserves_previous_descriptor(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);sources=self.fixtures(root)
            old=ingress.install(root,sources,lambda v:None,suite.write)
            def reject(value):raise ingress.IngressError('rejected')
            with self.assertRaises(ingress.IngressError):ingress.install(root,sources,reject,suite.write)
            self.assertEqual(ingress.descriptor(root),old)
            self.assertEqual(len(list((root/'state/ingress').iterdir())),1)
    def test_publish_fsync_failure_keeps_referenced_material(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);sources=self.fixtures(root)
            def write_then_fail(path,value):suite.write(path,value);raise OSError('directory fsync failed')
            with self.assertRaises(OSError):ingress.install(root,sources,lambda v:None,write_then_fail)
            self.assertIsNotNone(ingress.descriptor(root))
    def test_tampered_unexpected_and_linked_material_rejected(self):
        for change in ['bytes','extra','symlink','mode']:
            with self.subTest(change=change),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);sources=self.fixtures(root);value=ingress.install(root,sources,lambda v:None,suite.write)
                bundle=root/'state/ingress'/value['generation']
                if change=='bytes':(bundle/'cert.pem').write_text('changed')
                if change=='extra':(bundle/'extra').touch()
                if change=='symlink':(bundle/'key.pem').unlink();(bundle/'key.pem').symlink_to(root/'key.pem')
                if change=='mode':(bundle/'key.pem').chmod(0o644)
                with self.assertRaises((ingress.IngressError,OSError)):ingress.descriptor(root)
    def test_unsafe_descriptor_cannot_escape_bundle_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);sources=self.fixtures(root);value=ingress.install(root,sources,lambda v:None,suite.write)
            for key,changed in [('format',True),('mode','insecure'),('generation','../../outside'),('sha256',{'key.pem':'f'*64})]:
                bad=copy.deepcopy(value);bad[key]=changed
                with self.assertRaises(ingress.IngressError):ingress.descriptor(root,bad)
    def test_private_key_source_cannot_be_world_readable_or_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);sources=self.fixtures(root);sources['key.pem'].chmod(0o644)
            with self.assertRaises(ingress.IngressError):ingress.install(root,sources,lambda v:None,suite.write)
            sources['key.pem'].chmod(0o600);link=root/'link';link.symlink_to(sources['key.pem']);sources['key.pem']=link
            with self.assertRaises(OSError):ingress.install(root,sources,lambda v:None,suite.write)
            self.assertFalse((root/'state/ingress.json').exists())
    def test_missing_or_dangling_descriptor_cannot_fall_back_to_plaintext(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);sources=self.fixtures(root)
            ingress.install(root,sources,lambda v:None,suite.write)
            (root/'state/ingress.json').unlink()
            with self.assertRaises(ingress.IngressError):ingress.descriptor(root)
            (root/'state/ingress.json').symlink_to(root/'missing.json')
            with self.assertRaises(ingress.IngressError):ingress.descriptor(root)
    def test_linked_state_directory_is_rejected_before_copying_material(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);sources=self.fixtures(root);outside=root/'outside';outside.mkdir(mode=0o700)
            (root/'state').rmdir();(root/'state').symlink_to(outside)
            with self.assertRaises(ingress.IngressError):ingress.install(root,sources,lambda v:None,suite.write)
            self.assertEqual(list(outside.iterdir()),[])
    def test_managed_tls_cannot_be_mixed_with_plaintext_public_origins(self):
        cfg={'modules':['platform','makit'],'origins':{'platform':'https://workbench.example.test','makit':'http://127.0.0.1:8081'}}
        with self.assertRaises(ingress.IngressError):ingress.gateway_text(cfg,{'mode':'tls'})
        self.assertIn(':4101 {',ingress.gateway_text(cfg,None))
    def test_running_deployment_refuses_certificate_changes_before_writes(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as tmp:
            dep=object.__new__(suite.Deployment);dep.path=Path(tmp);dep.project='owned-fixture'
            result=suite.subprocess.CompletedProcess([],0,stdout=b'true\n')
            with patch.object(dep,'check_owned'),patch.object(suite.subprocess,'run',return_value=result),patch.object(ingress,'install') as install:
                with self.assertRaises(suite.Failure):dep.configure_tls({})
                install.assert_not_called()
    def test_stopped_pending_can_repair_transport_without_clearing_recovery(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);sources=self.fixtures(root)
            dep=object.__new__(suite.Deployment);dep.path=root;dep.project='owned-fixture'
            suite.write(root/'pending.json',{'phase':'migrating'})
            absent=suite.subprocess.CompletedProcess([],1,stdout=b'')
            with patch.object(dep,'check_owned'),patch.object(suite.subprocess,'run',return_value=absent),patch.object(dep,'preflight') as preflight,patch.object(dep,'configure'):
                dep.configure_tls(sources)
                self.assertTrue(preflight.call_args.kwargs['for_migration'])
            self.assertEqual(suite.read(root/'pending.json'),{'phase':'migrating'})
    def test_validation_timeout_removes_only_its_owned_container(self):
        from unittest.mock import patch
        dep=object.__new__(suite.Deployment);dep.project='owned-fixture';dep.instance={'id':'a'*16}
        inspected=suite.subprocess.CompletedProcess([],0,stdout=json.dumps([{'Config':{'Labels':{'cobuild.deployment':'a'*16}}}]).encode())
        with patch.object(suite,'docker',side_effect=[suite.subprocess.TimeoutExpired('docker',40),b'']) as docker,patch.object(suite.subprocess,'run',return_value=inspected):
            with self.assertRaises(suite.subprocess.TimeoutExpired):dep.ingress_check('image')
            self.assertEqual(docker.call_args_list[-1].args[:2],('rm','-f'))
    def test_validation_cleanup_refuses_foreign_ownership(self):
        from unittest.mock import patch
        dep=object.__new__(suite.Deployment);dep.project='owned-fixture';dep.instance={'id':'a'*16}
        inspected=suite.subprocess.CompletedProcess([],0,stdout=json.dumps([{'Config':{'Labels':{'cobuild.deployment':'foreign'}}}]).encode())
        with patch.object(suite,'docker',return_value=b'') as docker,patch.object(suite.subprocess,'run',return_value=inspected):
            with self.assertRaises(suite.Failure):dep.ingress_check('image')
            self.assertEqual(len(docker.call_args_list),1)

if __name__=='__main__':unittest.main()
