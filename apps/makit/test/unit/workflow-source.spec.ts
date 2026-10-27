import type { RequirementSummary } from '@shared/api.interface';
import { WorkflowSourceService } from '../../server/modules/notifications/workflow-source.service';
import { notificationIdentities, operationMarker, workflowEdges } from '../../server/modules/notifications/workflow-source.model';
import { requirementDeliveryPlans } from '../../server/modules/notifications/notification-delivery.model';
import { NotificationDeliveryService } from '../../server/modules/notifications/notification-delivery.service';

const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
const snapshot = (marker = '', status = '新'): RequirementSummary => ({
  id: 'recTest', title: '测试', code: 'REQ-TEST', status, notificationMarker: marker,
  handlers: [{ id: 'ou_test', name: '测试' }], productOwners: [], developers: [], testers: [],
  proposers: [], followers: [], foOwners: [], releaseOwners: [], iterationIds: [], iterationNames: [], project:'测试项目', priority:'P2', groupChatId: 'oc_test',
} as unknown as RequirementSummary);
const edge = (id: string, previous = '', status = '开发中') => ({
  operationId: id, fields: ['状态'], before: snapshot(previous), after: snapshot(operationMarker(id), status),
});
describe('same-write workflow source proof', () => {
  it('ticket cards omit legacy engineering roles and iterations and use support wording', () => {
    const before = {...snapshot('', '处理中'), type:'工单', iterationNames:['旧迭代'], developers:[{id:'ou_legacy',name:'旧研发'}]};
    const after = {...before, status:'已解决', developers:[{id:'ou_new',name:'新研发'}]};
    const plans = requirementDeliveryPlans({eventId:'ticket-event',requirementId:'recTest',occurredAt:'now',before,after,fields:['状态','研发人员'],actor:{name:'测试'}});
    expect(plans.map(plan=>plan.targetId).sort()).toEqual(['oc_test','ou_test']);
    const cards=JSON.stringify(plans.map(plan=>plan.payload));
    expect(cards).toContain('工单状态更新');
    expect(cards).toContain('查看工单');
    expect(cards).toContain('处理结果已更新');
    for(const label of ['所属迭代','旧迭代','研发人员','开发阶段','查看需求']) expect(cards).not.toContain(label);
  });
  const environment = { ...process.env };
  afterEach(() => {
    for (const key of ['WORKFLOW_EVENT_SOURCE','WORKFLOW_DELIVERY_OWNER']) {
      if (environment[key] === undefined) delete process.env[key]; else process.env[key] = environment[key];
    }
  });
  it('preserves all confirmed transitions between scans, including a return to the original status', async () => {
    const edges = { [a]: edge(a), [b]: edge(b, operationMarker(a), '新') };
    const result = await workflowEdges('', operationMarker(b), async (id) => edges[id]);
    expect(result.map((item) => item.operationId)).toEqual([a, b]);
  });
  it('an unchanged marker needs no guessed value match', async () => {
    const read = jest.fn();
    expect(await workflowEdges(operationMarker(a), operationMarker(a), read)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
  it.each(['missing', 'mismatched receipt', 'cycle', 'reset marker'])('defers %s instead of advancing a scanner baseline', async (kind) => {
    const read = async () => kind === 'missing' ? null : kind === 'cycle' ? edge(a, operationMarker(a)) :
      { ...edge(a), after: snapshot('') };
    await expect(workflowEdges('', kind === 'reset marker' ? 'invalid' : operationMarker(a), read)).rejects.toThrow();
  });
  it('bounds broken or unbounded chains', async () => {
    await expect(workflowEdges(operationMarker(b), '', async () => edge(a))).rejects.toThrow();
  });
  it('a matching marker does not make old shadow events deliverable without explicit ownership', () => {
    const event = { eventId: `operation:${a}`, operationId: a, requirementId:'recTest', occurredAt:'2026-09-12T00:00:00Z',
      before:snapshot(), after:snapshot(operationMarker(a), '开发中'), fields:['状态'], actor:{name:'测试'} };
    delete process.env.WORKFLOW_EVENT_SOURCE;
    expect(requirementDeliveryPlans(event).every((plan) => plan.owner === 'shadow')).toBe(true);
    process.env.WORKFLOW_EVENT_SOURCE = 'confirmed_operations_v1';
    process.env.WORKFLOW_DELIVERY_OWNER = 'managed_bot';
    expect(requirementDeliveryPlans(event).every((plan) => plan.owner === 'managed_bot' && plan.operationId === a)).toBe(true);
    expect(requirementDeliveryPlans({...event, after:snapshot('', '开发中')}).every((plan) => plan.owner === 'shadow')).toBe(true);
  });
  it('normalizes identities once per distinct employee without modifying stored audit snapshots', async () => {
    const before = snapshot(); before.handlers = [{id:'employee_test',name:'测试'}];
    const resolve = jest.fn().mockResolvedValue('ou_resolved');
    const result = await notificationIdentities([before, before], resolve);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(result[1].handlers[0].id).toBe('ou_resolved');
    expect(before.handlers[0].id).toBe('employee_test');
  });
  it('missing identity cannot fall back to a different namespace or silently omit a recipient', async () => {
    await expect(notificationIdentities([snapshot()], async () => '')).rejects.toThrow('identity_unresolved');
  });
  it('source endpoint refuses unavailable mode and malformed markers before querying', async () => {
    delete process.env.WORKFLOW_EVENT_SOURCE;
    const run = jest.fn(), service = new WorkflowSourceService({run} as never, {} as never);
    await expect(service.reconcile({requirementId:'recTest',previousMarker:'',currentMarker:''})).rejects.toThrow('未启用');
    process.env.WORKFLOW_EVENT_SOURCE='confirmed_operations_v1'; process.env.WORKFLOW_DELIVERY_OWNER='managed_bot';
    await expect(service.reconcile({requirementId:'recTest',previousMarker:'arbitrary',currentMarker:''})).rejects.toThrow('无效');
    expect(run).not.toHaveBeenCalled();
  });
  it('cutover cannot replay legacy queued notifications', async () => {
    process.env.WORKFLOW_EVENT_SOURCE='confirmed_operations_v1';
    const service = new NotificationDeliveryService({} as never);
    await expect(service.ingestWorkflow({eventId:'old-scanner-event',requirementId:'recTest',targetId:'oc_test',kind:'status',
      channel:'feishu_group',localAllowed:true,payload:{type:'interactive',receiveIdType:'chat_id',content:{}}})).rejects.toThrow('旧来源');
  });
  it('actual field labels produce material notifications but do not expose document content', () => {
    const event={eventId:'event',requirementId:'recTest',occurredAt:'now',before:snapshot(),after:{...snapshot(),introduction:'PRIVATE-PRD'},fields:['需求介绍'],actor:{name:'测试'}};
    expect(requirementDeliveryPlans(event).length).toBeGreaterThan(0);
    expect(JSON.stringify(requirementDeliveryPlans(event))).not.toContain('PRIVATE-PRD');
    expect(requirementDeliveryPlans(event).every((plan) => plan.channel === 'feishu_private')).toBe(true);
  });
  it('personnel changes reach the requirement group without expanding routine edit broadcasts', () => {
    const before = snapshot(), after = {...snapshot(), developers:[{id:'ou_new',name:'新增研发'}]};
    const plans = requirementDeliveryPlans({eventId:'e',requirementId:'recTest',occurredAt:'now',before,after,fields:['研发人员'],actor:{name:'测试'}});
    expect(plans.map((plan) => plan.targetId).sort()).toEqual(['oc_test','ou_new']);
  });
});
