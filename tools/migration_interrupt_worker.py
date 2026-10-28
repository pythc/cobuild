"""Test-only checkpoints around the real migration runner; no runtime hooks."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time

root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('deployment',root/'deploy/suite.py')
suite=importlib.util.module_from_spec(spec);spec.loader.exec_module(suite)
directory,release_file,mode,checkpoint=sys.argv[1:]
if mode not in ['before-history','after-commit']:raise ValueError('Invalid test checkpoint')
dep=suite.Deployment(directory);release=suite.read(release_file)
if mode=='before-history':
    original=dep.apply_migration
    def apply(old,new,evidence,pending):
        dep.start_databases()
        blocker=subprocess.Popen(['docker','exec','-i',dep.project+'-postgres-1','psql','-X','-v','ON_ERROR_STOP=1','-U','suite_admin','-d','makit'],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        blocker.stdin.write(b"SET application_name='cobuild_migration_test_blocker'; BEGIN; LOCK TABLE makit_schema_migration IN SHARE MODE; SELECT pg_sleep(120); ROLLBACK;");blocker.stdin.close()
        query="SELECT EXISTS(SELECT FROM pg_locks WHERE relation='makit_schema_migration'::regclass AND mode='ShareLock' AND granted);"
        for _ in range(100):
            raw=suite.docker('exec',dep.project+'-postgres-1','psql','-X','-A','-t','-U','suite_admin','-d','makit','-c',query)
            if raw.strip()==b't':break
            time.sleep(.05)
        else:raise RuntimeError('Test lock unavailable')
        Path(checkpoint).write_text('ledger-lock-held')
        return original(old,new,evidence,pending)
    dep.apply_migration=apply
else:
    def finish(*args):
        Path(checkpoint).write_text('database-committed-journal-not-finished')
        while True:time.sleep(.1)
    dep.finish_migration_state=finish
with dep.lock():dep.upgrade(release)
