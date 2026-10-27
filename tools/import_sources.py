"""Import explicit source roots without dependencies, deployed data or restricted code.

The source-map file belongs in .local/ and is deliberately not committed.
No directories are overwritten. Symbolic links are never followed.
"""
from pathlib import Path, PurePosixPath
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
COMPONENTS = {
    'platform': ('apps/platform', ['server', 'src', 'tests', 'scripts', 'vendor'], ['package.json', 'package-lock.json', 'README.md']),
    'makit': ('apps/makit', ['server', 'client', 'shared', 'migrations', 'scripts', 'test', 'integrations/iteration-bot'], ['package.json', 'package-lock.json', 'README.md', 'tsconfig.json', 'tsconfig.node.json', 'tsconfig.app.json', 'nest-cli.json', 'vite.selfhost.config.ts', 'vite.config.ts', 'tailwind.config.ts', 'postcss.config.js', 'components.json', 'eslint.config.js', 'Dockerfile.selfhost']),
    'weknow': ('integrations/weknow/source', ['apps/server/src', 'apps/server/test', 'apps/client/src', 'apps/client/public', 'packages/editor-ext'], ['package.json', 'pnpm-workspace.yaml', 'apps/server/package.json', 'apps/server/nest-cli.json', 'apps/server/tsconfig.json', 'apps/server/tsconfig.build.json', 'apps/client/package.json', 'apps/client/index.html', 'apps/client/vite.config.ts', 'apps/client/vitest.config.ts', 'apps/client/tsconfig.json', 'apps/client/tsconfig.node.json', 'apps/client/postcss.config.js']),
    'evalab': ('apps/evalab', ['server/src', 'server/test', 'server/migrations', 'client/src', 'client/tests', 'client/public', 'context-bridge/src', 'context-bridge/test', 'tests'], ['package.json', 'package-lock.json', 'README.md', 'server/package.json', 'server/tsconfig.json', 'server/tsconfig.build.json', 'client/package.json', 'client/index.html', 'client/env.d.ts', 'client/tsconfig.json', 'client/vite.config.ts', 'context-bridge/package.json', 'context-bridge/tsconfig.json', 'docs/CONTRACT.md']),
    'relay': ('apps/relay', ['server', 'shared', 'src', 'test', 'scripts', 'public/assets', 'integrations', 'harness'], ['package.json', 'package-lock.json', 'index.html', 'unread.html', 'tsconfig.json'])
}
BLOCKED_DIRS = {'node_modules', '.git', '.local', '.work', '.embed-work', 'dist', 'build', 'coverage', 'data', 'uploads', 'backups', '__pycache__', '.nx', '.spark', '.agents', '.claude', 'ee', 'base-formula'}
BLOCKED_SUFFIXES = {'.log', '.db', '.sqlite', '.sqlite3', '.pem', '.key', '.p12', '.pfx', '.zip', '.gz', '.tgz', '.mp4', '.apk', '.pdf', '.docx', '.xlsx', '.tsbuildinfo', '.pyc'}
BLOCKED_NAMES = {'runtime.mjs', '.DS_Store', 'knowledge-helper.py', 'recruitment-pdf-worker-6.4.299.mjs', 'recruitment-pdf-preview-v1.mjs'}
LICENSE_MARKER = 'Files in this directory are subject to the Docmost Enterprise Edition license.'

def permitted(relative):
    p = PurePosixPath(relative)
    if any(part in BLOCKED_DIRS for part in p.parts): return False
    if any(part.startswith('.test') or '.private.' in part or part.endswith('.private') for part in p.parts): return False
    if p.name in BLOCKED_NAMES or p.suffix.lower() in BLOCKED_SUFFIXES: return False
    if p.name.startswith('.env') or p.name.startswith('vite.quality') or p.name.startswith('vite.math-qa'): return False
    if p.name.endswith(('.bak', '.old', '.backup')): return False
    # Product marketing assets are outside the suite source boundary.
    if len(p.parts) > 2 and p.parts[:2] == ('src', 'assets'):
        return p.parts[2] in {'cobuild', 'icons'}
    return True

def walk(path):
    if path.is_symlink(): return
    if path.is_file():
        yield path
    elif path.is_dir():
        for child in sorted(path.iterdir()):
            if child.name not in BLOCKED_DIRS and not child.is_symlink(): yield from walk(child)

def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()

def git_revision(path):
    result = subprocess.run(['git', '-C', str(path), 'rev-parse', 'HEAD'], capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else None

def run(mapping, apply=False):
    report = {'schemaVersion': 1, 'status': 'private-source-baseline-not-public-release', 'components': {}}
    plans = []
    if (ROOT / 'provenance/source-baselines.json').exists(): raise RuntimeError('An import baseline already exists; refusing to overwrite')
    for component, (destination, directories, files) in COMPONENTS.items():
        origin = Path(mapping[component]).resolve(strict=True)
        target = ROOT / destination
        if target.exists(): raise RuntimeError(f'{component}: destination already exists; refusing to overwrite')
        candidates = {file for name in directories for file in walk(origin / name)}
        candidates.update(origin / name for name in files if (origin / name).is_file() and not (origin / name).is_symlink())
        selected = {str(file.relative_to(origin)): file for file in candidates if permitted(str(file.relative_to(origin)))}
        if component == 'weknow':
            upstream = Path(mapping['docmostUpstream']).resolve(strict=True)
            # Supplement missing build metadata only when dependency manifests match exactly.
            for name in ['package.json', 'pnpm-workspace.yaml', 'apps/client/package.json', 'apps/server/package.json']:
                if digest(origin / name) != digest(upstream / name): raise RuntimeError('WeKnow upstream dependency manifests differ; lockfile cannot be reused')
            for name in ['pnpm-lock.yaml', 'nx.json', 'LICENSE', 'README.md', 'patches/scimmy@1.3.5.patch']:
                selected[name] = upstream / name
        hashes = {}
        for relative, file in sorted(selected.items()):
            if not file.is_file() or file.is_symlink(): raise RuntimeError(f'{component}: invalid source entry')
            # A component with its own restrictive directory license must be reviewed separately.
            if file.name == 'LICENSE' and LICENSE_MARKER in file.read_text(errors='replace'):
                raise RuntimeError(f'{component}: restricted license found in selected files')
            hashes[relative] = digest(file)
        report['components'][component] = {'path': destination, 'sourceRevision': git_revision(origin), 'fileCount': len(hashes), 'bytes': sum(p.stat().st_size for p in selected.values()), 'files': hashes}
        plans.append((component, target, selected, hashes))
    if apply:
        # Validate every component before the first copy; failed imports remove only
        # directories created by this run and never touch the original source roots.
        local = ROOT / '.local'
        local.mkdir(mode=0o700, exist_ok=True)
        committed = []
        with tempfile.TemporaryDirectory(prefix='source-import-', dir=local) as staging:
            stage = Path(staging)
            try:
                for component, target, selected, hashes in plans:
                    for relative, file in selected.items():
                        output = stage / component / relative
                        output.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copyfile(file, output)
                        output.chmod(0o755 if file.suffix == '.sh' else 0o644)
                        if digest(output) != hashes[relative]: raise RuntimeError('Source changed during import; refusing inconsistent baseline')
                for component, target, selected, hashes in plans:
                    if target.exists() or target.is_symlink(): raise RuntimeError('Destination appeared during import; refusing overwrite')
                    target.parent.mkdir(parents=True, exist_ok=True)
                    (stage / component).rename(target)
                    committed.append(target)
                manifest = ROOT / 'provenance/source-baselines.json'
                manifest.parent.mkdir(exist_ok=True)
                temporary = stage / 'source-baselines.json'
                temporary.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
                # A concurrently created baseline must not be replaced.
                os.link(temporary, manifest)
            except BaseException:
                for target in reversed(committed): shutil.rmtree(target)
                raise
    print(json.dumps({name: {k:v for k,v in value.items() if k != 'files'} for name,value in report['components'].items()}, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source_map')
    parser.add_argument('--apply', action='store_true')
    arguments = parser.parse_args()
    run(json.loads(Path(arguments.source_map).read_text()), arguments.apply)
