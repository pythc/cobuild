import {test} from 'node:test'
import assert from 'node:assert/strict'
import {landingPath,redirectQuery} from '../src/lib/nav.ts'
test('account connection callback survives login/register for candidates and exam admins',()=>{
 const path='/api/public-identity/authorize?client_id=dagedui&state=fixture'
 for(const role of ['CANDIDATE','ADMIN'])assert.equal(landingPath(role,path),path)
 assert.deepEqual(redirectQuery(path),{redirect:path})
})
test('account bridge does not broaden external or administrative redirects',()=>{
 for(const path of ['https://evil.example','//evil.example','/login','/register'])assert.deepEqual(redirectQuery(path),{})
 assert.equal(landingPath('ADMIN','/api/unrelated'),'/admin')
 assert.equal(landingPath('CANDIDATE','/admin'),'/recruitment')
 assert.equal(landingPath('ADMIN','/admin/questions'),'/admin/questions')
})
