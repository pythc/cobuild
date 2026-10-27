/** Render the real Makit detail/form components with deterministic query data.
 * Only platform/network and browser-only rich editors are replaced at the boundary.
 */
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '..');
await mkdir(join(root, '.local'), { recursive: true });
const temp = await mkdtemp(join(root, '.local/ticket-render-'));
const apiSource = await readFile(join(root, 'client/src/api/index.ts'), 'utf8');
const names = [
  ...apiSource.matchAll(/export (?:async )?(?:function|const) (\w+)/g),
].map((m) => m[1]);
const api =
  names
    .map(
      (n) =>
        `export const ${n} = () => { throw new Error('Unexpected API call: ${n}'); };`,
    )
    .join('\n') +
  '\nexport const workspaceEfficiencyApi = {}; export const operationsApi = {}; export const operationsInsightsApi = {};';
const entry = `
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Detail from './client/src/pages/RequirementDetailPage/RequirementDetailPage';
import Form from './client/src/components/RequirementFormDialog';
import Transition from './client/src/components/StatusTransitionDialog';
export { ticketEditInitialState, ticketEditPatch } from './client/src/lib/ticket-edit';
export { ticketPatchError } from './shared/ticket-workflow';
export { prepareOperationInput, mergeOperationPatch } from './shared/requirement-operation';
const people = [{id:'member1',name:'测试处理人'}];
const roles = {handlers:['member1'],productOwners:[],developers:[],testers:[],foOwners:[],proposers:[],followers:[],releaseOwners:[]};
export function requirement(type) { return {
 id:'record1',code:'REQ-TEST',title:'导出图片缺失',url:'/requirements/record1',type,status:'处理中',
 introduction:'用户反馈导出缺少图片',acceptanceCriteria:'截图应完整',selfTestReport:'',defectCause:'',
 gitBranchName:'feature/test',githubPullRequestUrl:'',source:'用户反馈',tags:[],priority:'P2',project:'工单',iterationIds:[],iterationNames:[],
 handlers:people,productOwners:[],developers:[],testers:[],foOwners:[],proposers:people,followers:[],releaseOwners:[],personnelUserIds:roles,
 startAt:null,deadlineAt:null,developmentStartAt:null,developmentEndAt:null,testingAt:null,actualStartAt:null,actualTestingAt:null,actualReleaseAt:null,
 effort:3,latestProgress:'等待补充截图',blocked:false,blocker:'',updatedAt:1,updatedByName:'测试处理人',groupChatId:'test-group',groupLink:'https://example.test/group',groupStatus:'已创建',isMine:true,risks:[],
 allowedStatuses:['处理中','待补充','已解决','已关闭'],capabilities:{canUpdate:true,canArchive:false,canManageGroup:true,canManageAcceptance:true,canManageRelations:true,canComment:true}
 }; }
const workspace = {iterations:[],options:{statuses:['新','待分派','处理中','待补充','已解决','已关闭'],priorities:['P1','P2'],projects:['工单'],types:['产品需求','缺陷','工单'],sources:['用户反馈'],tags:[]}};
export function render(kind, type, extra={}) {
 const r={...requirement(type),...extra};
 const client = new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});
 client.setQueryData(['requirement','record1'],{requirement:r,comments:[],acceptanceItems:[],relations:[],activities:[]});
 client.setQueryData(['requirement-edit-context'],workspace);
 client.setQueryData(['requirement','record1','sections','comments'],{items:[]});
 const child=kind==='detail'?<Routes><Route path='/requirements/:recordId' element={<Detail/>}/></Routes>:kind==='form'?<Form open onOpenChange={()=>{}} workspace={workspace} requirement={r}/>:<Transition open onOpenChange={()=>{}} requirement={r}/>;
 return renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/requirements/record1']}>{child}</MemoryRouter></QueryClientProvider>);
}
`;
await build({
  stdin: { contents: entry, resolveDir: root, loader: 'tsx' },
  outfile: join(temp, 'render.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  jsx: 'automatic',
  tsconfig: join(root, 'tsconfig.app.json'),
  plugins: [
    {
      name: 'test-boundaries',
      setup(b) {
        b.onLoad({ filter: /client\/src\/api\/index\.ts$/ }, () => ({
          contents: api,
          loader: 'ts',
        }));
        b.onLoad(
          {
            filter:
              /client\/src\/components\/business-ui\/(tiptap-editor|user-select)\/index\.tsx?$/,
          },
          (args) => ({
            contents: args.path.includes('tiptap-editor')
              ? `import React from 'react'; export const TiptapEditorComplete=({value})=><div>{value}</div>;`
              : `import React from 'react'; export const UserSelect=()=> <div>成员选择器</div>;`,
            loader: 'tsx',
          }),
        );
        b.onLoad(
          {
            filter:
              /client\/src\/components\/(RequirementClarityReviewPanel|RequirementEngineeringPanel)\.tsx$/,
          },
          () => ({
            contents: `import React from 'react'; export default ()=> <div>研发专用面板</div>;`,
            loader: 'tsx',
          }),
        );
        b.onLoad(
          { filter: /client\/src\/components\/ui\/dialog\.tsx$/ },
          () => ({
            contents: `import React from 'react'; const Box=({children})=><div>{children}</div>; export const Dialog=({open,children})=>open?<div>{children}</div>:null; export const DialogContent=Box,DialogHeader=Box,DialogFooter=Box,DialogTitle=Box,DialogDescription=Box;`,
            loader: 'tsx',
          }),
        );
      },
    },
  ],
});
const {
  render,
  requirement,
  ticketEditInitialState,
  ticketEditPatch,
  ticketPatchError,
  prepareOperationInput,
  mergeOperationPatch,
} = createRequire(import.meta.url)(join(temp, 'render.cjs'));
const unwanted = [
  '需求阶段',
  '开发阶段',
  '测试阶段',
  '部署阶段',
  '发布阶段',
  '所属迭代',
  '工作量',
  'Git 分支',
  'GitHub PR',
  '产品人员',
  '研发人员',
  '测试人员',
  '发布负责人',
  '开发启动',
  '开发结束',
  '预计提测',
  'AI 需求评审',
  '研发资料',
  '验收标准',
];
test('ticket detail has only support fields, discussion and history', () => {
  const html = render('detail', '工单');
  for (const label of unwanted)
    assert.ok(!html.includes(label), 'unexpected ticket field: ' + label);
  for (const label of [
    '问题描述',
    '处理进展',
    '优先级',
    '当前处理人',
    '截止时间',
    '讨论区',
    '变更历史',
    '工单讨论群',
  ])
    assert.ok(html.includes(label), 'missing support field: ' + label);
});
test('standard requirement keeps its engineering workflow and fields', () => {
  const html = render('detail', '产品需求');
  for (const label of unwanted)
    assert.ok(html.includes(label), 'lost normal requirement field: ' + label);
});
test('defect keeps its roles and defect phases', () => {
  const html = render('detail', '缺陷');
  for (const label of [
    '新建',
    '已验证',
    '所属迭代',
    '工作量',
    '研发人员',
    '测试人员',
  ])
    assert.ok(html.includes(label), 'lost defect field: ' + label);
});
test('ticket edit is scoped to support data, including multiple handlers', () => {
  const html = render('form', '工单');
  for (const label of [...unwanted, '自测报告', '关注人', 'FO'])
    assert.ok(!html.includes(label), 'unexpected ticket edit field: ' + label);
  for (const label of [
    '编辑工单',
    '问题描述',
    '处理进展',
    '优先级',
    '所属项目',
    '当前处理人',
    '截止时间',
  ])
    assert.ok(html.includes(label));
});
test('ticket transitions never use inherited iteration or engineering requirements', () => {
  const html = render('transition', '工单', {
    workflow: { version: 1, statuses: ['开发中'], transitions: [] },
  });
  assert.ok(html.includes('更新工单状态'));
  assert.ok(html.includes('待补充'));
  assert.ok(html.includes('已解决'));
  assert.ok(!html.includes('开发中'));
  assert.ok(!html.includes('AI'));
});
test('saving a title preserves hidden legacy fields and the exact deadline', () => {
  const r = {
    ...requirement('工单'),
    deadlineAt: '2026-10-16T12:34:56Z',
    gitBranchName: 'keep-this-branch',
    effort: 8,
  };
  const baseline = ticketEditInitialState(r);
  assert.deepEqual(ticketEditPatch(r, baseline, baseline), {});
  assert.deepEqual(
    ticketEditPatch(r, baseline, { ...baseline, title: '新标题' }),
    { title: '新标题' },
  );
  assert.equal(r.gitBranchName, 'keep-this-branch');
});
test('date can be explicitly cleared without rewriting other fields', () => {
  const r = { ...requirement('工单'), deadlineAt: '2026-10-16T12:34:56Z' };
  const baseline = ticketEditInitialState(r);
  assert.deepEqual(
    ticketEditPatch(r, baseline, { ...baseline, deadline: '' }),
    { deadlineAt: null },
  );
});
test('assigning multiple handlers moves a pending ticket into processing', () => {
  const r = {
    ...requirement('工单'),
    status: '待分派',
    handlers: [],
    personnelUserIds: { ...requirement('工单').personnelUserIds, handlers: [] },
  };
  const baseline = ticketEditInitialState(r);
  const handlers = ticketEditInitialState({
    ...requirement('工单'),
    handlers: [
      { id: 'employee1', name: '甲' },
      { id: 'employee2', name: '乙' },
    ],
    personnelUserIds: {
      ...r.personnelUserIds,
      handlers: ['employee1', 'employee2'],
    },
  }).handlers;
  const patch = ticketEditPatch(r, baseline, { ...baseline, handlers });
  assert.deepEqual(patch, {
    handlerLarkUserIds: ['employee1', 'employee2'],
    status: '处理中',
  });
  assert.equal(ticketPatchError(patch, r), null);
});
test('processing cannot silently lose all handlers', () => {
  const r = requirement('工单');
  const baseline = ticketEditInitialState(r);
  const patch = ticketEditPatch(r, baseline, { ...baseline, handlers: [] });
  assert.match(ticketPatchError(patch, r), /处理人/);
});
test('a background edit to the same field is a conflict, not a silent overwrite', () => {
  const r = requirement('工单');
  const baseline = ticketEditInitialState(r);
  const patch = ticketEditPatch(r, baseline, {
    ...baseline,
    title: '我的修改',
  });
  const input = prepareOperationInput(r, {
    expectedUpdatedAt: r.updatedAt,
    patch,
  });
  const merged = mergeOperationPatch(
    { ...r, title: '其他人的修改', updatedAt: 2 },
    input,
  );
  assert.equal(merged.conflicts.length, 1);
  assert.equal(merged.conflicts[0].field, 'title');
});
test('multi-person assignment preserves another concurrently added handler', () => {
  const r = requirement('工单');
  const input = prepareOperationInput(r, {
    expectedUpdatedAt: r.updatedAt,
    patch: { handlerLarkUserIds: ['member1', 'member2'] },
  });
  const current = {
    ...r,
    personnelUserIds: {
      ...r.personnelUserIds,
      handlers: ['member1', 'member3'],
    },
  };
  const merged = mergeOperationPatch(current, input);
  assert.deepEqual(
    new Set(merged.patch.handlerLarkUserIds),
    new Set(['member1', 'member2', 'member3']),
  );
  assert.deepEqual(merged.conflicts, []);
});
test.after(() => rm(temp, { recursive: true, force: true }));
