import {createHmac, createHash, timingSafeEqual} from 'node:crypto';
const opaque = v => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
const fault = (status,message) => Object.assign(Error(message),{status});
export function verifyWidgetGrant(token,verifier,issuers,now=Date.now()) {
  if(typeof token!=='string'||token.length>4096||!opaque(verifier))throw fault(401,'客服身份交接无效');
  const parts=token.split('.');if(parts.length!==2)throw fault(401,'客服身份交接无效');
  let claim;try{claim=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));}catch{throw fault(401,'客服身份交接无效');}
  const issuer=issuers?.[claim.iss];
  if(!issuer||typeof issuer.key!=='string'||issuer.key.length<43)throw fault(401,'应用未接入客服');
  const expected=createHmac('sha256',issuer.key).update(parts[0]).digest('base64url');
  if(!opaque(parts[1])||!timingSafeEqual(Buffer.from(parts[1]),Buffer.from(expected)))throw fault(401,'客服身份签名无效');
  const fields='app,aud,challenge,exp,iat,iss,jti,name,origin,sub';
  if(Object.keys(claim).sort().join(',')!==fields||claim.aud!=='relay-widget-v1'||!issuer.apps.includes(claim.app)||!issuer.origins.includes(claim.origin)||!opaque(claim.jti)||!opaque(claim.challenge)||typeof claim.sub!=='string'||!claim.sub||claim.sub.length>200||typeof claim.name!=='string'||!claim.name.trim()||claim.name.length>80||/[\u0000-\u001f]/.test(claim.name)||!Number.isSafeInteger(claim.iat)||!Number.isSafeInteger(claim.exp)||claim.exp<=now||claim.iat>now+5000||claim.iat<now-120000||claim.exp>claim.iat+120000)throw fault(401,'客服身份交接已失效');
  if(createHash("sha256").update(verifier).digest("base64url")!==claim.challenge)throw fault(401,"客服身份交接不匹配");
  return claim;
}
