import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeWorkflowSegments } from '../src/workflow-source.js';
import { requirementSnapshot, diffRequirementSnapshots } from '../src/collaboration.js';
const fields=[['status','状态'],['project','项目'],['title','需求名称']];
const marker=(id)=>`op_v1:${id}`;
const snapshot=(status, project='项目', notificationMarker='')=>requirementSnapshot({status,project,notificationMarker});
const changeSegments=(segments)=>segments.map(({previous,snapshot:next})=>diffRequirementSnapshots(previous,next)).filter((changes)=>changes.length);
test('two platform transitions between scans yield no duplicate scanner transition',()=>{
  const previous=snapshot('新'), current=snapshot('测试中','项目',marker('b'));
  const edges=[{operationId:'a',fields:['状态'],before:previous,after:snapshot('开发中','项目',marker('a'))},
    {operationId:'b',fields:['状态'],before:snapshot('开发中','项目',marker('a')),after:current}];
  assert.equal(changeSegments(nativeWorkflowSegments(previous,current,edges,requirementSnapshot,fields)).length,0);
});
test('native edits before, during and after a platform write remain visible',()=>{
  const previous=snapshot('新','A'), before=snapshot('新','B'), after=snapshot('开发中','C',marker('a')),current=snapshot('开发中','D',marker('a'));
  const result=nativeWorkflowSegments(previous,current,[{operationId:'a',fields:['状态'],before,after}],requirementSnapshot,fields);
  assert.deepEqual(changeSegments(result).map((changes)=>changes.map(({key,before,after})=>[key,before,after])),[
    [['project','A','B']],[['project','B','C']],[['project','C','D']],
  ]);
});
test('missing/mismatched source chain never advances the snapshot',()=>{
  assert.throws(()=>nativeWorkflowSegments(snapshot('新'),snapshot('开发中','项目',marker('a')),[],requirementSnapshot,fields));
  assert.throws(()=>nativeWorkflowSegments(snapshot('新'),snapshot('开发中','项目',marker('a')),[{operationId:'a',before:snapshot('新', '项目', marker('b')),after:snapshot('开发中','项目',marker('a'))}],requirementSnapshot,fields));
});
test('renamed users and person ordering are not personnel changes',()=>{
  const previous=requirementSnapshot({handlers:[{id:'ou_a',name:'以前'},{id:'ou_b',name:'B'}]});
  const next=requirementSnapshot({handlers:[{id:'ou_b',name:'B'},{id:'ou_a',name:'现在'}]});
  assert.deepEqual(diffRequirementSnapshots(previous,next),[]);
});
