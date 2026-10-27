import {AuthController} from './auth.controller';
describe('native authentication controller',()=>{
 test('has no local login, signup, reset or password change handler',()=>{
  const names=Object.getOwnPropertyNames(AuthController.prototype);
  expect(names).toEqual(expect.arrayContaining(['collabToken','logout']));
  expect(names).not.toEqual(expect.arrayContaining(['login']));
 });
 test('collaboration tokens retain the authenticated session ID',()=>{
  const auth:any={getCollabToken:jest.fn()};const c=new AuthController(auth,{} as any);
  c.collabToken({id:'u'} as any,{id:'w'} as any,{raw:{sessionId:'s'}} as any);
  expect(auth.getCollabToken).toHaveBeenCalledWith({id:'u'},'w','s');
 });
 test('logout revokes the current session before clearing its cookie',async()=>{
  const sessions:any={revokeSession:jest.fn()};const reply:any={clearCookie:jest.fn()};
  await new AuthController({} as any,sessions).logout({id:'u',workspaceId:'w'} as any,{raw:{sessionId:'s'}} as any,reply);
  expect(sessions.revokeSession).toHaveBeenCalledWith('s','u','w');expect(reply.clearCookie).toHaveBeenCalledWith('authToken',{path:'/'});
 });
});
