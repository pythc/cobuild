export const LEGACY_REQUIREMENTS_BASE='https://fcncvoyreb8p.feishuapp.com/app/app_17b6pxwde0x';
export const NATIVE_REQUIREMENTS_BASE='https://makit.110-lab.cn';
export function requirementsBase(value=process.env.PORTAL_REQUIREMENTS_BASE_URL||NATIVE_REQUIREMENTS_BASE){
 if([LEGACY_REQUIREMENTS_BASE,NATIVE_REQUIREMENTS_BASE].includes(value))return value;
 try{
  const u=new URL(value);
  if(process.env.PORTAL_REQUIREMENTS_ALLOW_LOOPBACK==='true'&&process.env.NODE_ENV!=='production'&&u.protocol==='http:'&&
   ['127.0.0.1','localhost'].includes(u.hostname)&&u.port&&u.origin===value&&!u.username&&!u.password)return value;
 }catch{}
 throw Error('Invalid configured Makit endpoint');
}
export const REQUIREMENTS_BASE=requirementsBase();
export const REQUIREMENTS_ENDPOINT=REQUIREMENTS_BASE+'/openapi/mcp';
// Retain stored credentials from the original service, but never accept an
// arbitrary endpoint from a credential file. Tokens are not rotated on migration.
export const compatibleRequirementEndpoint=value=>value===REQUIREMENTS_ENDPOINT||
 value===LEGACY_REQUIREMENTS_BASE+'/openapi/mcp'||value===NATIVE_REQUIREMENTS_BASE+'/openapi/mcp';
