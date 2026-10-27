// Local acceptance processes must not connect to production, SMTP or Feishu.
const net = require('node:net');
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const input=Array.isArray(args[0])?args[0]:args;
  const host=typeof input[0]==='object'?input[0]?.host:typeof input[1]==='string'?input[1]:undefined;
  const path=typeof input[0]==='object'?input[0]?.path:typeof input[0]==='string'&&!/^\d+$/.test(input[0])?input[0]:undefined;
  if(path||host&&!['127.0.0.1','localhost','::1'].includes(host))throw new Error('Local suite blocked a non-loopback connection');
  return original.apply(this,args);
};
