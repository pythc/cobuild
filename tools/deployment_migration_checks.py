"""Real additive migration and interruption checks for the disposable suite."""
import os
import json
from pathlib import Path
import signal
import subprocess
import sys
import time

def run_checks(suite,root,directory,dep,deployments,child_image,retained,check,preserve,base_env):
    def sql(text):
        return suite.docker('exec','-i',dep.project+'-postgres-1','psql','-X','-A','-t','-v','ON_ERROR_STOP=1','-U','suite_admin','-d','makit',input=text.encode()).decode().strip()
    def planned(name,base,steps):
        plan={'format':1,'steps':steps}
        generated=suite.checked_policy(suite.policy.generated_files,plan)
        tag=child_image(name,'USER root\nCOPY --chmod=644 sql/*.sql /suite/apps/makit/migrations/selfhost/\nCOPY --chmod=644 runtime/migrate.mjs /suite/deploy/runtime/migrate.mjs\nUSER node',
            extra_files={**{'sql/'+k:v.encode() for k,v in generated.items()},'runtime/migrate.mjs':(root/'deploy/runtime/migrate.mjs').read_bytes()},from_image=base['retainedImages']['core'])
        path=directory/(name+'.release.json')
        suite.seal(tag,'0.5.0-'+name,path,base,plan)
        release=suite.read(path);retained.append(release['retainedImages']['core'])
        return release,path,generated
    def attempt_failure(release):
        try:
            with dep.lock():dep.upgrade(release)
        except suite.Failure:return
        raise AssertionError('Expected migration rejection/failure')
    def unchanged(release,label):
        started=suite.docker('inspect','--format','{{.State.StartedAt}}',dep.project+'-core-1')
        attempt_failure(release)
        check(suite.docker('inspect','--format','{{.State.StartedAt}}',dep.project+'-core-1')==started,label)
    base=dep.release
    first_changes=[
        {'kind':'create_table','table':'cobuild_upgrade_probe','columns':[{'name':'id','type':'text','primary':True},{'name':'note','type':'text'}]},
        {'kind':'add_nullable_column','table':'portal_project','column':'upgrade_note','type':'text'},
        {'kind':'create_index','name':'cobuild_upgrade_probe_note_idx','table':'cobuild_upgrade_probe','columns':['note']},
    ]
    success,success_path,_=planned('additive-success',base,[{'file':'0091_upgrade_probe.sql','changes':first_changes}])
    with dep.lock():dep.upgrade(success)
    check(dep.schema_state()['status']=='complete' and dep.schema_state()['actualSchema']==success['contract']['schema'],'real generated table/column/index migration completed')
    sql("SET ROLE makit_application; INSERT INTO cobuild_upgrade_probe(id,note) VALUES('after-upgrade','new data'); RESET ROLE;")
    preserve('migration-new-write',dep)
    legacy_path=directory/'legacy-v04.release.json'
    historical=json.loads((root/'provenance/deployment-checks.json').read_text())
    check(suite.image_info('cobuild-suite:recovery-v04-baseline')['id']==historical['artifact']['immutableImageId'],'legacy rollback uses the exact previously verified immutable 0.4 image')
    suite.seal('cobuild-suite:recovery-v04-baseline','0.4.0-legacy-check',legacy_path)
    legacy=suite.read(legacy_path)
    with dep.lock():dep.upgrade(legacy)
    check(dep.release['images']['core']['id']==legacy['images']['core']['id'],'immutable 0.4 application runs after the additive migration')
    check(sql("SELECT note FROM cobuild_upgrade_probe WHERE id='after-upgrade'")=='new data','application rollback retains new table data')
    check(dep.schema_state()['actualSchema']==success['contract']['schema'] and suite.read(dep.path/'state/runtime.json')['schema']==legacy['contract']['schema'],'actual database schema and active binary compatibility are recorded separately')
    preserve('migration-legacy-rollback',dep)
    fork,_,_=planned('additive-fork',legacy,[{'file':'0091_fork.sql','changes':[{'kind':'create_table','table':'cobuild_fork_probe','columns':[{'name':'id','type':'text'}]}]}])
    unchanged(fork,'divergent schema branch rejected before stopping the application')
    with dep.lock():dep.upgrade(success)
    second={'file':'0092_partial_probe.sql','changes':[{'kind':'create_table','table':'cobuild_partial_probe','columns':[{'name':'id','type':'text','primary':True}]}]}
    bad_third={'file':'0093_failure_probe.sql','changes':[
        {'kind':'create_table','table':'cobuild_rolled_back_probe','columns':[{'name':'id','type':'text'}]},
        {'kind':'add_nullable_column','table':'cobuild_missing_probe','column':'note','type':'text'},
    ]}
    failed,_,_=planned('additive-partial',success,[second,bad_third])
    attempt_failure(failed)
    state=dep.schema_state()
    check(state['status']=='partial' and state['applied']==['0092_partial_probe.sql'],'a committed prefix is reconciled after an actual SQL failure')
    check(dep.core_running() and dep.release['images']['core']['id']==success['images']['core']['id'],'SQL failure restores the compatible previous application')
    check(sql("SELECT to_regclass('public.cobuild_partial_probe') IS NOT NULL")=='t','committed first migration remains')
    check(sql("SELECT to_regclass('public.cobuild_rolled_back_probe') IS NULL")=='t','failed file rolls back its earlier DDL in the same transaction')
    sql("SET ROLE makit_application; INSERT INTO cobuild_partial_probe(id) VALUES('prefix-data'); RESET ROLE;")
    applied_at=sql("SELECT applied_at::text FROM makit_schema_migration WHERE name='0092_partial_probe.sql'")
    preserve('migration-partial-old-app',dep)
    partial_backup=directory/'partial-backup'
    with dep.lock():dep.snapshot(partial_backup);dep.down()
    clone=suite.restore(directory/'migration-restored',partial_backup);deployments.append(clone);dep=clone
    with dep.lock():dep.up()
    check(dep.schema_state()['status']=='partial' and sql("SELECT count(*) FROM cobuild_partial_probe WHERE id='prefix-data'")=='1','backup restore preserves partial schema, compatibility and committed data')
    preserve('migration-partial-restored',dep)
    rewritten={'file':second['file'],'changes':[{'kind':'create_table','table':'cobuild_rewritten_probe','columns':[{'name':'id','type':'text'}]}]}
    unsafe,_,_=planned('additive-rewritten-prefix',success,[rewritten,bad_third])
    unchanged(unsafe,'repair cannot rewrite an already-committed migration prefix')
    fixed_third={'file':bad_third['file'],'changes':[
        {'kind':'create_table','table':'cobuild_rolled_back_probe','columns':[{'name':'id','type':'text'}]},
        {'kind':'add_nullable_column','table':'cobuild_partial_probe','column':'note','type':'text'},
    ]}
    repaired,repaired_path,_=planned('additive-repair',success,[second,fixed_third])
    with dep.lock():dep.upgrade(repaired)
    check(dep.schema_state()['status']=='complete','a new retained candidate repairs only the unapplied suffix')
    check(sql("SELECT applied_at::text FROM makit_schema_migration WHERE name='0092_partial_probe.sql'")==applied_at,'repair does not rerun the committed prefix')
    check(sql("SELECT count(*) FROM cobuild_partial_probe WHERE id='prefix-data'")=='1','repair retains the data written before recovery')
    preserve('migration-forward-repair',dep)

    def interrupt(name,base_release,filename,table_name,mode):
        nonlocal dep
        release,path,_=planned(name,base_release,[{'file':filename,'changes':[{'kind':'create_table','table':table_name,'columns':[{'name':'id','type':'text'}]}]}])
        checkpoint=directory/(name+'.checkpoint')
        logfile=root/'.local'/('migration-interrupt-'+name+'.private.log')
        with open(logfile,'wb') as output:
            os.chmod(logfile,0o600)
            process=subprocess.Popen([sys.executable,str(root/'tools/migration_interrupt_worker.py'),str(dep.path),str(path),mode,str(checkpoint)],cwd=root,env=base_env,stdout=output,stderr=output,start_new_session=True)
            try:
                deadline=time.monotonic()+110
                while time.monotonic()<deadline:
                    if process.poll() is not None:raise RuntimeError('Interrupted migration exited before checkpoint; see private log')
                    if checkpoint.exists():
                        if mode=='after-commit':
                            if sql("SELECT count(*) FROM makit_schema_migration WHERE name='"+filename+"'")=='1':break
                        elif sql("SELECT EXISTS(SELECT FROM pg_locks WHERE relation='makit_schema_migration'::regclass AND mode='RowExclusiveLock' AND NOT granted)")=='t':break
                    time.sleep(.1)
                else:raise RuntimeError('Migration interruption checkpoint timeout')
                os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=10)
                if mode=='before-history':
                    dep.stop_migration()
                    sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name='cobuild_migration_test_blocker'")
                check((dep.path/'pending.json').exists(),'killed '+mode+' operation retains its durable journal')
                try:dep.up()
                except suite.Failure:pass
                else:raise AssertionError('Incomplete migration started silently')
                if mode=='before-history':
                    pending=suite.read(dep.path/'pending.json');row=next(iter(pending['migrationEvidence']['baseLedger']));expected=pending['migrationEvidence']['baseLedger'][row]
                    quoted=row.replace("'","''")
                    sql("UPDATE makit_schema_migration SET sha256='"+'0'*64+"' WHERE name='"+quoted+"'")
                    try:
                        try:
                            with dep.lock():dep.recover()
                        except suite.Failure:pass
                        else:raise AssertionError('History tampering accepted during recovery')
                        check(not dep.core_running() and (dep.path/'pending.json').exists(),'uncertain history leaves business consumers stopped')
                    finally:sql("UPDATE makit_schema_migration SET sha256='"+expected+"' WHERE name='"+quoted+"'")
                with dep.lock():dep.recover()
                expected_status='complete' if mode=='after-commit' else 'not_applied'
                check(dep.schema_state()['status']==expected_status,'recovery reconciles '+mode+' against real PostgreSQL history')
                exists=sql("SELECT to_regclass('public."+table_name+"') IS NOT NULL")=='t'
                check(exists==(mode=='after-commit'),'transactional DDL survives only a committed migration')
                preserve('migration-'+name+'-recovered',dep)
            finally:
                if process.poll() is None:os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=10)
        return release,path
    committed,_=interrupt('crash-after-commit',repaired,'0094_commit_probe.sql','cobuild_commit_probe','after-commit')
    with dep.lock():dep.upgrade(committed)
    interrupt('crash-inside-transaction',committed,'0095_transaction_probe.sql','cobuild_transaction_probe','before-history')
    check(sql("SELECT note FROM cobuild_upgrade_probe WHERE id='after-upgrade'")=='new data','all migration failures and interruptions preserve existing business data')
    return dep
