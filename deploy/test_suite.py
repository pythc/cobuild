import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import suite

class SnapshotTests(unittest.TestCase):
    def test_archive_rejects_traversal_and_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive=Path(tmp)/'db.tar'
            for name,kind in [('../escape',tarfile.REGTYPE),('/escape',tarfile.REGTYPE),('link',tarfile.SYMTYPE),('device',tarfile.CHRTYPE)]:
                with tarfile.open(archive,'w') as stream:
                    member=tarfile.TarInfo(name);member.type=kind;stream.addfile(member)
                with self.assertRaises(suite.Failure):suite.validate_tar(archive)
    def test_invalid_postgres_major_and_missing_version_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive=Path(tmp)/'postgres.tar'
            for value in [b'18',b'']:
                with tarfile.open(archive,'w') as stream:
                    m=tarfile.TarInfo('PG_VERSION' if value else 'other');m.size=len(value);stream.addfile(m,io.BytesIO(value))
                with self.assertRaises(suite.Failure):suite.validate_tar(archive)
    def test_duplicate_tar_entries_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive=Path(tmp)/'db.tar'
            with tarfile.open(archive,'w') as stream:
                stream.addfile(tarfile.TarInfo('./item'));stream.addfile(tarfile.TarInfo('item'))
            with self.assertRaises(suite.Failure):suite.validate_tar(archive)
    def test_restore_refuses_existing_target_before_docker_mutations(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker=Path(tmp)/'keep';marker.write_text('existing data')
            with patch.object(suite,'verify_snapshot',return_value={'release':{}}),patch.object(suite,'validate_release'),patch.object(suite,'docker') as docker:
                with self.assertRaises(suite.Failure):suite.restore(tmp,'unused')
                docker.assert_not_called()
            self.assertEqual(marker.read_text(),'existing data')
    def test_symlink_in_source_rejected_before_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'source').mkdir();(root/'source/link').symlink_to('/etc/passwd')
            with self.assertRaises(suite.Failure):suite.copy_private_tree(root/'source',root/'copy')
            self.assertFalse((root/'copy').exists())
    def test_compatibility_gate_precedes_stop_and_backup(self):
        with tempfile.TemporaryDirectory() as tmp:
            dep=object.__new__(suite.Deployment);dep.path=Path(tmp);dep.release={'contract':{'schema':'old'},'images':{'core':{'id':'same'}}}
            candidate={'contract':{'schema':'new'},'images':{'core':{'id':'same'}}}
            with patch.object(suite,'validate_release',return_value=candidate),patch.object(dep,'stop') as stop,patch.object(dep,'snapshot') as backup:
                with self.assertRaises(suite.Failure):dep.upgrade(candidate)
                stop.assert_not_called();backup.assert_not_called()
    def test_upgrade_failure_rolls_back_image_without_restoring_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            dep=object.__new__(suite.Deployment);dep.path=Path(tmp);dep.instance={'id':'a'*16}
            old={'contract':{'schema':'same'},'images':{'core':{'id':'same'},'postgres':{},'redis':{}},'version':'v1'}
            new={**old,'version':'v2'};dep.release=old
            with patch.object(suite,'validate_release',side_effect=lambda v:v),patch.object(dep,'preflight'),patch.object(dep,'activate_runtime'),patch.object(dep,'snapshot',return_value=Path(tmp)/'backup'),patch.object(dep,'stop'),patch.object(dep,'configure') as configure,patch.object(dep,'start_wait',side_effect=[suite.Failure('unhealthy'),None]):
                with self.assertRaises(suite.Failure):dep.upgrade(new)
                self.assertEqual(dep.release,old)
                self.assertFalse((Path(tmp)/'pending.json').exists())
                self.assertEqual(configure.call_args_list[-1].args,(old,))
    def test_backup_stop_failure_attempts_to_restore_prior_running_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);path=root/'team';path.mkdir(mode=0o700)
            (path/'state/platform').mkdir(parents=True);(path/'state/platform/identity.sqlite').touch()
            dep=object.__new__(suite.Deployment);dep.path=path;dep.project='cobuild-fixture'
            with patch.object(dep,'preflight'),patch.object(dep,'configure'),patch.object(dep,'check_owned'),patch.object(dep,'core_running',return_value=True),patch.object(dep,'stop',side_effect=suite.Failure('unclean stop')),patch.object(dep,'start_wait') as resume,patch.object(suite,'docker'):
                with self.assertRaises(suite.Failure):dep.snapshot(root/'backup')
                resume.assert_called_once()
            self.assertFalse((root/'backup').exists())
            self.assertEqual(list(root.glob('.cobuild-backup-*')),[])
    def test_seal_refuses_to_overwrite_an_unexpected_artifact_tag(self):
        with tempfile.TemporaryDirectory() as tmp:
            info={'id':'sha256:'+'a'*64,'architecture':'arm64','os':'linux'}
            conflicting=suite.subprocess.CompletedProcess([],0,stdout=json.dumps([{'Id':'sha256:'+'b'*64}]).encode())
            with patch.object(suite,'image_info',return_value=info),patch.object(suite,'validate_release'),patch.object(suite,'docker',return_value=b'{"format":1}') as docker,patch.object(suite.subprocess,'run',return_value=conflicting):
                with self.assertRaises(suite.Failure):suite.seal('working','v1',Path(tmp)/'release.json')
                self.assertFalse(any(c.args and c.args[0]=='tag' for c in docker.call_args_list))
            self.assertFalse((Path(tmp)/'release.json').exists())

    def test_changed_migration_driver_is_rejected_even_for_compatible_schema(self):
        dep=object.__new__(suite.Deployment)
        dep.release={'contract':{'schema':'same'},'images':{'core':{'id':'old'}}}
        candidate={'contract':{'schema':'same'},'images':{'core':{'id':'new'}}}
        path='apps/makit/scripts/selfhost/migrate.cjs'
        with patch.object(suite,'schema_manifest',side_effect=[{'files':{path:'old'}},{'files':{path:'new'}}]),patch.object(dep,'schema_state') as state:
            with self.assertRaises(suite.Failure):dep.migration_for(candidate)
            state.assert_not_called()

    def test_pending_recovery_stops_consumers_before_rejecting_unavailable_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            dep=object.__new__(suite.Deployment);dep.path=Path(tmp)
            suite.write(dep.path/'pending.json',{'previous':{},'candidate':{}})
            order=[]
            def reject(value):
                order.append('validate');raise suite.Failure('Artifact unavailable')
            with patch.object(dep,'stop',side_effect=lambda:order.append('stop')),patch.object(suite,'validate_release',side_effect=reject):
                with self.assertRaises(suite.Failure):dep.recover()
            self.assertEqual(order,['stop','validate'])
            self.assertTrue((dep.path/'pending.json').exists())

if __name__=='__main__':unittest.main()
