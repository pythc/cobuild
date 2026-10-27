"""Read-only source boundary audit. Results contain paths and line numbers, never matched values."""
from pathlib import Path
import argparse
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOTS = ['apps/platform', 'apps/makit', 'apps/evalab', 'apps/relay', 'integrations/weknow/source']
GENERATED = {'node_modules', '.git', 'dist', 'build', '.local', '__pycache__', '.nx', 'coverage'}
TEXT = {'.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.html', '.css', '.yaml', '.yml', '.sh', '.md', '.py'}
RULES = {
    'lab-service-address': re.compile(r'(?:[A-Za-z0-9-]+\.)*110-lab\.cn'),
    'absolute-developer-path': re.compile(r'/(?:Users/[^/\s\'"`]+|opt/110lab|data/(?:110lab|cobuild))[/\w-]*'),
    'feishu-app-identifier': re.compile(r'\bcli_[a-z0-9]{8,}\b'),
    'fixed-administrator-name': re.compile(r'周灿宇'),
    'fixed-private-network': re.compile(r'\b(?:10\.16\.6\.247|47\.109\.176\.127|172\.29\.0\.1)\b')
}
SECRET = [
    ('private-key', re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')),
    ('github-token', re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b')),
    ('aws-access-id', re.compile(r'\bAKIA[A-Z0-9]{16}\b'))
]

def files(root):
    if root.is_symlink(): return
    for file in sorted(root.iterdir()):
        if file.name in GENERATED or file.is_symlink(): continue
        if file.is_dir(): yield from files(file)
        elif file.is_file(): yield file

def audit():
    baseline = json.loads((ROOT / 'provenance/source-baselines.json').read_text())
    fixture_file = ROOT / 'provenance/reviewed-test-fixtures.json'
    fixtures = {row['path']:row['sha256'] for row in json.loads(fixture_file.read_text())['files']} if fixture_file.exists() else {}
    changes, missing, violations, findings, reviewed = [], [], [], [], []
    for component, metadata in baseline['components'].items():
        for relative, expected in metadata['files'].items():
            file = ROOT / metadata['path'] / relative
            if not file.is_file(): missing.append(str(file.relative_to(ROOT))); continue
            actual = hashlib.sha256(file.read_bytes()).hexdigest()
            if actual != expected: changes.append({'path':str(file.relative_to(ROOT)), 'baselineSha256':expected, 'currentSha256':actual})
    for name in SOURCE_ROOTS:
        for file in files(ROOT / name):
            relative = str(file.relative_to(ROOT))
            parts = file.relative_to(ROOT).parts
            if 'ee' in parts or 'base-formula' in parts or '.private.' in file.name or file.name.startswith('.env'):
                violations.append({'rule':'restricted-source-or-private-file','path':relative})
            if file.suffix in {'.db','.sqlite','.sqlite3','.key','.pem','.mp4','.apk'}:
                violations.append({'rule':'data-or-private-artifact','path':relative})
            if file.suffix not in TEXT and file.name not in {'LICENSE','NOTICE'}: continue
            text = file.read_text(errors='replace')
            synthetic_fixture = relative in fixtures and hashlib.sha256(file.read_bytes()).hexdigest() == fixtures[relative]
            for number,line in enumerate(text.splitlines(), 1):
                for rule,pattern in RULES.items():
                    if pattern.search(line): findings.append({'rule':rule, 'path':relative, 'line':number})
                for rule,pattern in SECRET:
                    if pattern.search(line):
                        row={'rule':rule, 'path':relative, 'line':number}
                        (reviewed if synthetic_fixture else violations).append(row)
    return {'schemaVersion':1, 'scope':'imported-source-only', 'secretScan':'limited-pattern-screening-not-a-complete-security-review', 'importedFiles':sum(c['fileCount'] for c in baseline['components'].values()), 'changes':changes, 'missing':missing, 'violations':violations, 'reviewedSyntheticFixtures':reviewed, 'portabilityFindings':findings}

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--check',action='store_true');args=parser.parse_args()
    report=audit()
    output=ROOT/'provenance/audit.json'
    if args.check:
        if not output.exists() or json.loads(output.read_text()) != report:
            print('Audit changed; run npm run audit and review the differences.');raise SystemExit(1)
    else: output.write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n')
    print(json.dumps({'importedFiles':report['importedFiles'],'modifiedFiles':len(report['changes']),'missingFiles':len(report['missing']),'boundaryViolations':len(report['violations']),'portabilityFindings':len(report['portabilityFindings'])}))
    if report['violations'] or report['missing']: raise SystemExit(1)
