import {createHmac,randomBytes} from 'node:crypto';
export function issueWidgetGrant({key,issuer,app,origin,subject,name,challenge,now=Date.now()}) {
  if(typeof key!=='string'||key.length<43)throw Object.assign(Error('客服尚未配置'),{status:503});
  if(!/^[A-Za-z0-9_-]{43}$/.test(challenge||'')||typeof subject!=='string'||!subject||subject.length>200||typeof name!=='string'||!name.trim()||name.length>80||/[\u0000-\u001f]/.test(name))throw Object.assign(Error('客服身份参数无效'),{status:400});
  const claim={aud:'relay-widget-v1',iss:issuer,app,origin,sub:subject,name,challenge,iat:now,exp:now+90000,jti:randomBytes(32).toString('base64url')};
  const payload=Buffer.from(JSON.stringify(claim)).toString('base64url');
  return {grant:payload+'.'+createHmac('sha256',key).update(payload).digest('base64url')};
}
