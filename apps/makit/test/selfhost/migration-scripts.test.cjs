const {test}=require('node:test');
const assert=require('node:assert/strict');
const {maximumAutoNumber}=require('../../scripts/selfhost/auto-sequence.cjs');
const {managedUserIds}=require('../../scripts/selfhost/export-identities.cjs');
const {importIdentities}=require('../../scripts/selfhost/import-identities.cjs');
const field={name:'编号',property:{auto_serial:{type:'custom',options:[
  {type:'fixed_text',value:'REQ-'},{type:'created_time',value:'yyyyMMdd'},{type:'system_number',value:'4'},
]}}};
const records=(...values)=>values.map(value=>({fields:{编号:value}}));
test('sequence import preserves numbers after width overflow and across dates',()=>{
 assert.equal(maximumAutoNumber(field,records('REQ-202601019999','REQ-2026101610000','REQ-202610150001')),10000);
});
test('sequence import rejects malformed IDs instead of silently reusing an existing number',()=>{
 assert.throws(()=>maximumAutoNumber(field,records('REQ-20261016oops')));
 assert.throws(()=>maximumAutoNumber(field,records('REQ-20261016001')));
 assert.throws(()=>maximumAutoNumber(field,records('REQ-202610169007199254740993')));
});
test('fixed text is a literal rather than a regular expression',()=>{
 const literal=structuredClone(field);literal.property.auto_serial.options[0].value='R[1].';
 assert.equal(maximumAutoNumber(literal,records('R[1].202610160123')),123);
 assert.throws(()=>maximumAutoNumber(literal,records('R1202610160123')));
});
test('unknown or ambiguous number formats stop the migration',()=>{
 const unknown=structuredClone(field);unknown.property.auto_serial.options.push({type:'unexpected',value:'x'});
 assert.throws(()=>maximumAutoNumber(unknown,[]));
 const multiple=structuredClone(field);multiple.property.auto_serial.options.push({type:'system_number',value:'4'});
 assert.throws(()=>maximumAutoNumber(multiple,[]));
});
test('plain integer sequence does not lose precision or accept negative values',()=>{
 assert.equal(maximumAutoNumber({name:'编号'},records(7,10000)),10000);
 assert.throws(()=>maximumAutoNumber({name:'编号'},records(-1)));
 assert.throws(()=>maximumAutoNumber({name:'编号'},records('9007199254740993')));
});
test('identity coverage includes typed owners and composite auditors without scanning user prose',()=>{
 assert.deepEqual(managedUserIds([{_created_by:'(1859972341904474)',owner_user_id:'8000000000000000017',
  title:'User 123456',payload_json:'{"user_id":"77"}',id:'99',reviewer_role_ids:'100'}]),['1859972341904474','8000000000000000017']);
});
test('identity reference parsing preserves precision and rejects malformed or non-user values',()=>{
 assert.deepEqual(managedUserIds([{actor_user_id:'(123',owner_user_id:'456)',_updated_by:'(anonymous_user_id)',
  reviewer_user_id:'000123',another_user_id:null,legacy_user_id:123}]),['000123']);
});
test('an incomplete new identity manifest must fail rather than fall back to legacy imports',async()=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'makit-identity-manifest-'));
 try{
  await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify({version:1,users:1,files:{
   'identity-open-id-to-miaoda.json':'absent','identity-miaoda-to-union-id.json':'absent','effective-roles.json':'absent','identity-directory.json':'absent'}}));
  await assert.rejects(importIdentities(root),error=>error.code==='ENOENT');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
