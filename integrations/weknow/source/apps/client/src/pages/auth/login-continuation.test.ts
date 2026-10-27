import {describe,it,expect} from 'vitest';
import {beginAutomaticLogin,clearAutomaticLogin} from './login-continuation';
const storage=()=>{const v=new Map<string,string>();return {getItem:(k:string)=>v.get(k)??null,setItem:(k:string,x:string)=>{v.set(k,x)},removeItem:(k:string)=>{v.delete(k)}}};
describe('first-party login continuation',()=>{
  it('automatically continues once and stops rapid redirect loops',()=>{const s=storage();expect(beginAutomaticLogin('',s,100000)).toBe(true);expect(beginAutomaticLogin('',s,100001)).toBe(false);expect(beginAutomaticLogin('',s,190001)).toBe(true);});
  it('keeps explicit logout and authorization errors on the login page',()=>{for(const query of ['?logout=1','?error=failed','?error=denied','?error=disabled'])expect(beginAutomaticLogin(query,storage(),100000)).toBe(false);});
  it('successful authentication resets the guard for later session renewal',()=>{const s=storage();beginAutomaticLogin('',s,100000);clearAutomaticLogin(s);expect(beginAutomaticLogin('',s,100001)).toBe(true);});
  it('restricted storage leaves manual login available',()=>{const s={getItem(){throw new Error()},setItem(){throw new Error()}};expect(beginAutomaticLogin('',s,100000)).toBe(false);});
});
