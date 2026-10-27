import{tool}from'@opencode-ai/plugin';import{call}from'../lib/call';
export default tool({description:'完成本次客服回复。仅依据本轮真实查询结果回答；查不出、权限未绑定或需要人工时 handoff=true。',args:{answer:tool.schema.string().min(1).max(3000),handoff:tool.schema.boolean()},async execute(args){return call('finish_answer',args);}});
