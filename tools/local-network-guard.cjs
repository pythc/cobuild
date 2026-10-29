// Local acceptance processes must not connect to production, SMTP or Feishu.
const net = require('node:net');
// The optional public code reader is the only local-preview egress exception.
// Runtime schema validation still runs before the application starts.
let publicCode = false;
try {
  const c = JSON.parse(require('node:fs').readFileSync(process.env.COBUILD_CONFIG, 'utf8'));
  publicCode = c.codeSources?.githubPublic === true && c.modules?.includes('kick') &&
    c.integrations && Object.values(c.integrations).every(v => v === false) && c.delivery?.externalMessages === false;
} catch {}

const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const input=Array.isArray(args[0])?args[0]:args;
  const host=typeof input[0]==='object'?input[0]?.host:typeof input[1]==='string'?input[1]:undefined;
  const path=typeof input[0]==='object'?input[0]?.path:typeof input[0]==='string'&&!/^\d+$/.test(input[0])?input[0]:undefined;
  const port=typeof input[0]==='object'?input[0]?.port:input[0];
  const codeHost=publicCode && host==='api.github.com' && Number(port)===443;
  if(path||host&&!['127.0.0.1','localhost','::1'].includes(host)&&!codeHost)throw new Error('Local suite blocked a non-loopback connection');
  return original.apply(this,args);
};
