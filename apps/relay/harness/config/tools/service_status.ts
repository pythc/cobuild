import{tool}from'@opencode-ai/plugin';import{call}from'../lib/call';
export default tool({description:'检查批改系统当前 API、认证、日志服务或数据库的就绪状态。当前正常不能证明历史没有故障。',args:{service:tool.schema.enum(['server-api','server-auth','logs','database','all'])},async execute(args){return call('service_status',args);}});
