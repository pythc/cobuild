import test from 'node:test';
import assert from 'node:assert/strict';
import {connectionFailure} from '../src/connection-error.js';
test('expired login recovers by status even when the old message contains no login word',()=>{
 const v=connectionFailure({status:401,message:'暂时无法核对统一身份，请重试',loginPath:'/relay/auth/start'});
 assert.equal(v.action,'login');assert.equal(v.label,'重新登录');assert.match(v.message,/登录已失效/);
 assert.equal(connectionFailure({status:401},true).label,'重新连接');
});
test('network, provider failures and permission denial do not trigger fresh authorization',()=>{
 for(const status of [403,429,500,503]){
  const v=connectionFailure({status,message:'登录服务暂时不可用'});assert.equal(v.action,'retry');assert.equal(v.label,'重新连接');
 }
 assert.equal(connectionFailure(new Error('Failed to fetch')).action,'retry');
});
