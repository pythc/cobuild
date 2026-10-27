"""Fail closed until all independent-distribution acceptance criteria are evidenced."""
from pathlib import Path
import json
import subprocess

root=Path(__file__).resolve().parents[1]
result=subprocess.run(['python3',str(root/'tools/audit.py'),'--check'],cwd=root)
if result.returncode: raise SystemExit(result.returncode)
report=json.loads((root/'provenance/audit.json').read_text())
blockers=json.loads((root/'release-blockers.json').read_text())['blockers']
open_items=[]
for item in blockers:
    evidence=item.get('evidence')
    valid_evidence=isinstance(evidence,list) and bool(evidence) and all(isinstance(x,str) and not Path(x).is_absolute() and '..' not in Path(x).parts and (root/x).resolve().is_relative_to(root) and (root/x).is_file() for x in evidence)
    if item['status']!='verified' or not valid_evidence: open_items.append(item['id'])
if report['portabilityFindings'] and 'configuration' not in open_items:open_items.append('configuration')
print(json.dumps({'publicReleaseReady':not open_items,'openBlockers':open_items},ensure_ascii=False,indent=2))
raise SystemExit(2 if open_items else 0)
