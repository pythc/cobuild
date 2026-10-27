import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('an invalid later component cannot leave a partially imported earlier component', () => {
  const result = execFileSync('python3', ['-c', `
import runpy,tempfile,pathlib,json
ns=runpy.run_path('tools/import_sources.py');run=ns['run']
with tempfile.TemporaryDirectory() as temporary:
 root=pathlib.Path(temporary);origin=root/'origin';origin.mkdir();(origin/'package.json').write_text('{}')
 destination=root/'destination';destination.mkdir();run.__globals__['ROOT']=destination
 try:run({'platform':str(origin),'makit':str(root/'missing')},True)
 except (FileNotFoundError,KeyError):pass
 else:raise AssertionError('Expected invalid source to fail')
 print(json.dumps({'partial':(destination/'apps/platform').exists(),'original':(origin/'package.json').read_text()}))
`], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(result), { partial: false, original: '{}' });
});
