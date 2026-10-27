import{tool}from'@opencode-ai/plugin';import{call}from'../lib/call';
export default tool({description:'检索当前登录人有权限阅读的已发布操作说明。回答操作方法先查资料，资料为空不编造功能。',args:{query:tool.schema.string().min(1).max(400)},async execute(args){return call('search_knowledge',args);}});
