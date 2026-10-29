import {ProjectOverviewController} from '../../server/common/selfhost/project-overview.controller';
import {RequirementsQueryService} from '../../server/modules/requirements/requirements-query.service';
import {RequirementAccessService} from '../../server/modules/requirements/requirement-access.service';
import {serviceRequest} from '../../server/common/selfhost/suite-channel';
jest.mock('../../server/common/selfhost/suite-channel',()=>({serviceRequest:jest.fn()}));
const org='550e8400-e29b-41d4-a716-446655440000',userId='550e8400-e29b-41d4-a716-446655440001',projectId='550e8400-e29b-41d4-a716-446655440002';
const subject=org+':'+userId,input={organizationId:org,subject,projectId};
function setup(){
  process.env.LAB_IDENTITY_TENANT_KEY=org;process.env.COBUILD_IDENTITY_ORIGIN='http://127.0.0.1:4100';
  (serviceRequest as jest.Mock).mockReset().mockResolvedValue({subject});
  let active=true;
  const client=jest.fn(async(strings:TemplateStringsArray)=>{
    const sql=strings.join('?');
    if(/INSERT|UPDATE|DELETE|CREATE/.test(sql))throw Error('Unexpected write');
    if(sql.includes('suite_organization'))return [{organization_id:org,issuer:process.env.COBUILD_IDENTITY_ORIGIN}];
    if(sql.includes('user_role'))return [{role_id:'viewer'}];
    return [{id:'42',name:'Reader',employee_id:userId,open_id:userId,active,directory_active:true}];
  });
  const projects={list:jest.fn().mockResolvedValue([{projectId,projectName:'Example',revision:5,snapshot:{aliases:['Old']}}])};
  const query={projectOverviewAs:jest.fn().mockResolvedValue({counts:{total:0},stale:false})};
  return {service:new ProjectOverviewController({client} as never,projects as never,query as never,new RequirementAccessService()),client,projects,query,revoke:()=>{active=false;}};
}
test('signed overview uses an existing active business identity and never provisions',async()=>{
  const h=setup();await expect(h.service.read(input)).resolves.toMatchObject({projectId,revision:5});
  expect(h.query.projectOverviewAs).toHaveBeenCalledWith(expect.objectContaining({miaodaUserId:'42',roles:['viewer']}),'Example');
  expect(serviceRequest).toHaveBeenCalledTimes(2);
});
test('invalid actor and caller supplied filters are rejected before data reads',async()=>{
  const h=setup();for(const v of [{...input,subject:'foreign:user'},{...input,project:'Other'},{...input,organizationId:userId}])await expect(h.service.read(v)).rejects.toThrow();
  expect(h.client).not.toHaveBeenCalled();
});
test('local deactivation and in-flight central revocation clear results',async()=>{
  const h=setup();h.revoke();await expect(h.service.read(input)).rejects.toThrow('停用');expect(h.query.projectOverviewAs).not.toHaveBeenCalled();
  const k=setup();k.query.projectOverviewAs.mockImplementation(async()=>{k.revoke();return {counts:{total:9}};});await expect(k.service.read(input)).rejects.toThrow('停用');
  const j=setup();(serviceRequest as jest.Mock).mockResolvedValueOnce({subject}).mockRejectedValueOnce(Error('revoked'));await expect(j.service.read(input)).rejects.toThrow('revoked');
});
test('unknown or ambiguous legacy project names never merge requirement totals',async()=>{
  const h=setup();h.projects.list.mockResolvedValueOnce([]);await expect(h.service.read(input)).rejects.toThrow('尚未同步');
  h.projects.list.mockResolvedValueOnce([{projectId,projectName:'Example',snapshot:{aliases:['Old']}},{projectId:userId,projectName:'Old',snapshot:null}] as never);
  await expect(h.service.read(input)).rejects.toThrow('冲突');expect(h.query.projectOverviewAs).not.toHaveBeenCalled();
});
test('project rename during a read discards the old project summary',async()=>{
  const h=setup();h.query.projectOverviewAs.mockImplementation(async()=>{
    h.projects.list.mockResolvedValue([{projectId,projectName:'Renamed',revision:6,snapshot:{aliases:['Example']}}]);
    return {counts:{total:9}};
  });
  await expect(h.service.read(input)).rejects.toThrow('正在更新');
});
test('project counts reuse workflow completion, preserve freshness, and exclude unrelated projects',async()=>{
  const service=Object.create(RequirementsQueryService.prototype);
  service.parsedWorkspace=jest.fn().mockResolvedValue({requirements:[
    {project:'Example',status:'开发中',type:'产品需求',blocked:true,risks:['开发逾期']},
    {project:'Example',status:'已发布',type:'产品需求',blocked:false,risks:[]},
    {project:'Unrelated',status:'开发中',type:'产品需求',blocked:true,risks:[]},
  ],freshness:{loadedAt:'2026-10-29T00:00:00.000Z',stale:true}});
  const result=await service.projectOverviewAs({miaodaUserId:'42'},'Example');
  expect(result).toEqual({counts:{total:2,inProgress:1,completed:1,blocked:1,overdue:1},fetchedAt:'2026-10-29T00:00:00.000Z',stale:true});
  expect(result).not.toHaveProperty('requirements');
});
