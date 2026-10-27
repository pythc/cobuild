// Isolated production-bundle UI test: every request is fulfilled or blocked.
// No application backend, credentials, notifications or database are used.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'audits/2026-09-12-operations');
fs.mkdirSync(out, { recursive: true });

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const errors = [],
    writes = [],
    recordRequests = [];
  let role = 'super_admin',
    pendingStatus = 'running';
  const owner = '185000000000000001',
    member = '185000000000000002',
    runtimeAdmin = '185000000000000003';
  let roleUsers = [
    { userID: runtimeAdmin, name: { zh_cn: '测试运行管理员' } },
    { userID: '185000000000000004', name: { zh_cn: '测试被授权成员' } },
  ];
  const memberChanges = [];
  let roleReads = 0;
  const businessCalls = [], views = [], batches = new Map();
  let batchSequence = 0;
  const requirement = (id, title) => ({
    id, title, code:`REQ-${id}`, url:`/requirements/${id}`, introduction:'隔离测试需求正文', acceptanceCriteria:'可验证的测试目标',
    selfTestReport:'', defectCause:'', gitBranchName:'', githubPullRequestUrl:'', type:'产品需求', source:'产品规划', tags:[],
    status:'新', allowedStatuses:['需求已评审'], priority:'P2', project:'隔离测试项目', iterationIds:[], iterationNames:[],
    handlers:[{id:'qa-employee',name:'隔离测试用户'}], productOwners:[], developers:[], testers:[], foOwners:[], proposers:[],followers:[],releaseOwners:[],
    personnelUserIds:{handlers:['qa-employee'],productOwners:[],developers:[],testers:[],foOwners:[],proposers:[],followers:[],releaseOwners:[]},
    startAt:null,deadlineAt:null,developmentStartAt:null,developmentEndAt:null,testingAt:null,actualStartAt:null,actualTestingAt:null,actualReleaseAt:null,
    effort:null,latestProgress:'',blocked:false,blocker:'',updatedAt:123,updatedByName:'隔离测试用户',groupChatId:'',groupLink:'',groupStatus:'未创建',isMine:true,risks:[],
    capabilities:{canUpdate:true,canDelete:true,canTransition:true,canCreateGroup:false},
  });
  const requirements=[requirement('recQaOnlyA','隔离测试需求 A'),requirement('recQaOnlyB','隔离测试需求 B')];
  const options={statuses:['新','需求已评审'],priorities:['P0','P1','P2'],projects:['隔离测试项目'],types:['产品需求','缺陷'],sources:['产品规划'],tags:[]};
  const userId = () =>
    role === 'super_admin'
      ? owner
      : role === 'operations_admin'
        ? runtimeAdmin
        : member;
  const row = (id, status, actorUserId = owner) => ({
    id,
    status,
    requirementId: 'recQaOperations01',
    actorUserId,
    actorName: '测试用户',
    attempts: 1,
    result:
      status === 'succeeded' ? { success: true, message: '已修改' } : null,
    errorMessage:
      status === 'failed' ? '需求状态已变化，请查看最新内容后修正' : '',
    createdAt: '2026-09-12T08:00:00Z',
    finishedAt: status === 'running' ? null : '2026-09-12T08:00:05Z',
    intent:
      id === '11111111-1111-4111-8111-111111111111'
        ? 'status-transition'
        : 'edit',
    fields: ['当前处理人', '优先级'],
    targetStatus: id === '11111111-1111-4111-8111-111111111111' ? '开发中' : '',
    errorCode: status === 'failed' ? 'CONFLICT' : '',
    stages: [
      {
        key: 'write',
        label: '数据保存',
        status:
          status === 'succeeded'
            ? 'succeeded'
            : status === 'failed'
              ? 'failed'
              : 'pending',
        detail: status === 'succeeded' ? '字段已保存' : '检查保存结果',
      },
      {
        key: 'history',
        label: '变更记录',
        status: 'unknown',
        detail: '历史操作未记录此阶段回执',
      },
      {
        key: 'review',
        label: 'AI 评审',
        status: 'unknown',
        detail: '请查看评审记录',
      },
      {
        key: 'notification',
        label: '协作通知',
        status: 'unknown',
        detail: '事件执行结果不等于逐人送达或已读',
      },
    ],
  });

  await context.addInitScript(() => {
    window._IS_Spark_RUNTIME = false;
    window._userInfo = {
      user_id: '185000000000000001',
      name: '测试高级管理员',
    };
  });
  await context.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const json = (data, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(data),
      });
    if (url.hostname !== '127.0.0.1') return route.abort();
    if (request.resourceType() === 'document')
      return route.fulfill({
        contentType: 'text/html',
        body: fs
          .readFileSync(path.join(root, 'dist/client/index.html'), 'utf8')
          .replace(/\{\{\{?[^}]+\}\}\}?/g, '')
          .replace(
            '<head>',
            `<head><script>window._IS_Spark_RUNTIME=false;window._userInfo=${JSON.stringify({ user_id: userId(), name: '隔离测试用户' })};</script>`,
          ),
      });
    if (url.pathname.includes('/assets/')) {
      const asset = path.join(
        root,
        'dist/client/assets',
        path.basename(url.pathname),
      );
      if (fs.existsSync(asset))
        return route.fulfill({
          contentType:
            {
              '.js': 'application/javascript',
              '.css': 'text/css',
              '.woff2': 'font/woff2',
            }[path.extname(asset)] || 'application/octet-stream',
          body: fs.readFileSync(asset),
        });
    }
    if (url.pathname.endsWith('/api/workspace/current-user'))
      return json({
        miaodaUserId: userId(),
        employeeId: 'qa-employee',
        name: '测试用户',
        roles: [],
        capabilities: { canCreate: false },
      });
    if (url.pathname.endsWith('/api/workspace/requirements') && request.method()==='GET') {
      businessCalls.push({path:url.pathname,query:Object.fromEntries(url.searchParams)});
      const items=requirements.filter((item)=>!url.searchParams.get('q')||item.title.includes(url.searchParams.get('q')));
      return json({fetchedAt:new Date().toISOString(),currentUser:{miaodaUserId:userId(),employeeId:'qa-employee',name:'隔离测试用户',accessLevel:'editor',capabilities:{canCreate:true}},
        stats:{total:2,mine:2,inProgress:0,blocked:0,overdue:0,completed:0},iterations:[],options,
        peopleOptions:{handlers:requirements[0].handlers,productOwners:[],developers:[],testers:[],foOwners:[]},
        items,total:items.length,rowTotal:items.length,page:1,pageSize:50,pageCount:1,sortBy:'risk',sortOrder:'desc'});
    }
    if (url.pathname.endsWith('/api/workspace/views')) {
      if(request.method()==='GET')return json({userId:userId(),items:views,canManageTeamViews:role==='super_admin'});
      const input=request.postDataJSON();businessCalls.push({path:url.pathname,body:input});
      const view={...input,id:'11111111-1111-4111-8111-111111111111',ownerId:userId(),version:1,canEdit:true,canDelete:true};views.push(view);return json(view);
    }
    if (url.pathname.includes('/api/workspace/requirement-batches/')) {
      const action=url.pathname.split('/').at(-1),input=request.postDataJSON();
      if(request.method()==='GET')return json(batches.get(action));
      businessCalls.push({path:url.pathname,body:input});
      if(action==='preview'||action==='retry-preview') {
        const id=`qa-batch-${++batchSequence}`;
        const batch={id,state:'preview',expiresAt:new Date(Date.now()+600000).toISOString(),patch:input.patch||{priority:'P1'},
          items:(action==='preview'?requirements:[requirements[1]]).map((item)=>({recordId:item.id,code:item.code,title:item.title,status:'allowed',reason:'',input:{patch:{priority:'P1'},expectedUpdatedAt:123}}))};
        batches.set(id,batch);return json(batch);
      }
      if(action==='execute') {
        const id=url.pathname.split('/').at(-2),previous=batches.get(id);
        const batch={...previous,state:'submitted',items:previous.items.map((item,index)=>({...item,status:index===1?'failed':'succeeded',reason:index===1?'测试冲突，请查看最新值':''}))};
        batches.set(id,batch);return json(batch);
      }
    }
    if (url.pathname.endsWith('/api/operations/access'))
      return json({
        userId: userId(),
        role,
        canViewAll: role !== 'member',
        canManageAdmins: role === 'super_admin',
        canViewNotifications: role !== 'member',
      });
    if (url.pathname.endsWith('/api/operations/roles')) {
      roleReads += 1;
      if (role !== 'super_admin')
        return json({ error: { message: '仅高级管理员可访问' } }, 403);
      return json([
        {
          bizID: 'operations_super_admin',
          name: '高级管理员',
          description: '全局运行记录与管理员授权',
          roleMembers: {
            userList: [{ userID: owner, name: { zh_cn: '测试高级管理员' } }],
          },
        },
        {
          bizID: 'operations_viewer',
          name: '运行管理员',
          description: '全局运行记录只读，不增加编辑或补发权限',
          roleMembers: { userList: roleUsers },
        },
      ]);
    }
    if (url.pathname.endsWith('/api/operations/roles/members')) {
      if (role !== 'super_admin')
        return json({ error: { message: '仅高级管理员可访问' } }, 403);
      const input = request.postDataJSON();
      memberChanges.push(input);
      roleUsers = roleUsers.filter((user) => user.userID !== input.userId);
      return json({ success: true, message: '已撤销' });
    }
    if (url.pathname.endsWith('/api/operations/records')) {
      recordRequests.push(Object.fromEntries(url.searchParams));
      if (role === 'member' && url.searchParams.get('scope') === 'all')
        return json({ message: '禁止越权' }, 403);
      const allRows = [
        row('11111111-1111-4111-8111-111111111111', pendingStatus),
        row('22222222-2222-4222-8222-222222222222', 'failed'),
        row('33333333-3333-4333-8333-333333333333', 'succeeded', member),
      ];
      const scoped =
        url.searchParams.get('scope') === 'all'
          ? allRows
          : allRows.filter((item) => item.actorUserId === userId());
      let items = scoped;
      const status = url.searchParams.get('status'),
        operationId = url.searchParams.get('operationId');
      if (status && status !== 'all')
        items = items.filter((item) => item.status === status);
      if (operationId) items = items.filter((item) => item.id === operationId);
      const pageNumber = Number(url.searchParams.get('page') || 1);
      const pageSize = Number(url.searchParams.get('pageSize') || 25);
      const stats = Object.fromEntries(
        ['queued', 'running', 'failed', 'succeeded'].map((status) => [
          status,
          scoped.filter((item) => item.status === status).length,
        ]),
      );
      return json({
        fetchedAt: new Date().toISOString(),
        scope: url.searchParams.get('scope') || 'mine',
        items: items.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
        stats: { ...stats, total: scoped.length },
        page: pageNumber,
        pageSize,
        total: items.length,
        pageCount: 1,
      });
    }
    if (url.pathname.endsWith('/api/operations/ai-reviews'))
      return json({
        items: [
          {
            id: 'review-qa',
            requirementId: 'recQaOperations01',
            reviewType: 'clarity',
            status: 'failed',
            score: null,
            attempts: 2,
            errorMessage: '模型调用超时',
            updatedAt: new Date().toISOString(),
          },
        ],
        page: 1,
        pageSize: 25,
        total: 1,
        pageCount: 1,
      });
    if (url.pathname.endsWith('/api/operations/health')) return json({
      fetchedAt:new Date().toISOString(), since:'2026-09-11T08:00:00Z',database:{available:true,durationMs:8},process:{uptimeSeconds:600,buildVersion:'qa'},
      dependencies:[{dependency:'feishu',operation:'records',count:40,failures:2,validationRejections:1,p50Ms:120,p95Ms:450,outcomes:{timeout:1,permission:0,rate_limited:1}}],
      scanners:[{scanner:'requirement_jobs',instanceId:'qa',lastStartedAt:new Date().toISOString(),lastFinishedAt:new Date().toISOString(),lastSuccessAt:new Date().toISOString(),status:'success',stale:false,errorCode:null,buildVersion:'qa'}],
      business:{accepted:20,confirmed:18,failed:1,unknown:1,queued:0,oldestQueuedAt:null,aiQueued:0,aiRunning:0,aiSuperseded:2,stalePrSnapshots:0,notificationUnknown:1},
      probe:{configured:false,externalRunnerVerified:false,path:'/openapi/operations/probe'},sampling:{retainedDays:14,droppedSinceStart:0}
    });
    if (url.pathname.endsWith('/api/operations/executions')) return json({
      items:[{id:'11111111-1111-4111-8111-111111111111',reviewId:'qa',requirementId:'recQaOperations01',batchId:'qa',attempt:1,reviewType:'clarity',sourceHash:'sha',model:'test-model',ruleSetVersion:'qa-v1',status:'completed',startedAt:'2026-09-12T08:00:00Z',finishedAt:'2026-09-12T08:00:05Z',inputTokens:null,outputTokens:null,cacheHitTokens:null,pricingVersion:null,estimatedCost:null,currency:null,errorCode:null,errorMessage:null,feedback:null,feedbackReason:null}],
      total:1,page:1,pageCount:1,usage:{executionCount:1,inputTokens:0,outputTokens:0,unknownUsageCount:1,unknownCostCount:1,estimatedCosts:[],budgetExceeded:false}
    });
    if (url.pathname.endsWith('/api/operations/alerts')) return json([{id:'qa-alert',ruleKey:'operation_unknown',scope:'platform',status:'open',firstSeenAt:'2026-09-12T08:00:00Z',lastSeenAt:'2026-09-12T08:05:00Z',openedAt:'2026-09-12T08:03:00Z',recoveredAt:null,consecutiveWindows:5,notificationState:'disabled',evidence:{title:'需求写入结果待核实',actual:1,threshold:1,unit:'项'}}]);
    if (url.pathname.endsWith('/api/operations/notification-deliveries')) return json({items:[{id:'qa-delivery',eventId:'qa-event',operationId:null,source:'requirement_workflow',owner:'managed_bot',kind:'change',requirementId:'recQaOperations01',repository:null,pullNumber:null,channel:'feishu_group',targetName:'隔离测试群',platformUrl:'https://example.invalid/requirements/recQaOperations01',state:'unknown',attempts:1,maxAttempts:8,messageId:null,lastErrorCode:'receipt_missing_after_lease',confirmedAt:null,updatedAt:'2026-09-12T08:05:00Z'}],total:1,page:1,pageSize:25,pageCount:1,coverageNote:'隔离回执样本，未外发'});
    if (url.pathname.endsWith('/api/operations/workflow-notifications'))
      return json({
        items: [
          {
            id: 'event-qa',
            requirementIds: ['recQaOperations01'],
            eventType: '需求变更',
            source: '服务监听',
            status: '已发送',
            attempts: 1,
            errorMessage: '',
            summary: '开发中 → 开发转测试',
            updatedAt: new Date().toISOString(),
          },
        ],
        page: 1,
        pageSize: 25,
        total: 1,
        pageCount: 1,
        coverageNote:
          '仅展示最近 500 条工作流通知事件；执行结果不等于逐人送达或已读。',
      });
    if (
      request.method() !== 'GET' &&
      /\/api\/(operations|workspace)\//.test(url.pathname)
    )
      if (url.pathname.endsWith('/api/operations/experience')) return json({success:true});
      else
      writes.push(url.pathname);
    // Component SDK lookups are isolated too; no outbound identity lookup occurs.
    if (['xhr', 'fetch'].includes(request.resourceType()))
      return json({ data: {}, code: 0 });
    return route.abort();
  });
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto('http://127.0.0.1:8091/app/app_17b6pxwde0x/operations');
    await page
      .getByRole('heading', { name: '操作记录', exact: true })
      .waitFor({ timeout: 15000 });
    await page.getByText('流转至开发中', { exact: true }).waitFor();
    await page.screenshot({
      path: path.join(out, '01-desktop.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await page
      .getByRole('button', { name: '详情', exact: true })
      .nth(1)
      .click();
    await page.getByRole('dialog').waitFor();
    assert.equal(
      await page.getByRole('dialog').getByText('本次修改未完成').count(),
      1,
    );
    assert.equal(
      await page.getByRole('dialog').getByRole('listitem').count(),
      4,
    );
    assert.match(
      await page
        .getByRole('link', { name: '查看最新值 / 修正' })
        .getAttribute('href'),
      /\/requirements\/recQaOperations01\?recoveryOf=22222222-2222-4222-8222-222222222222$/,
    );
    await page.screenshot({
      path: path.join(out, '02-failure-detail.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Close' })
      .click();
    await page.getByRole('tab', { name: 'AI 评审', exact: true }).click();
    await page.getByText('模型调用超时', { exact: true }).waitFor();
    await page.getByRole('tab', { name: '工作流通知', exact: true }).click();
    await page.getByText(/执行结果不等于逐人送达/).waitFor();
    await page.getByRole('tab', {name:'依赖健康',exact:true}).click();
    await page.getByText('450 ms',{exact:true}).waitFor();
    await page.screenshot({path:path.join(out,'07-runtime-health.png'),fullPage:true,animations:'disabled'});
    await page.getByRole('tab', {name:'AI 用量',exact:true}).click();
    await page.getByText('test-model',{exact:true}).waitFor();
    await page.screenshot({path:path.join(out,'08-ai-usage.png'),fullPage:true,animations:'disabled'});
    await page.getByRole('tab', {name:'异常与恢复',exact:true}).click();
    await page.getByText('需求写入结果待核实',{exact:true}).waitFor();
    await page.getByRole('tab', {name:'通知投递',exact:true}).click();
    await page.getByText('隔离测试群',{exact:true}).waitFor();
    assert.equal(await page.getByRole('checkbox').first().isDisabled(),true,'Uncertain notification must not be selectable for resend');
    await page.screenshot({path:path.join(out,'09-notification-ledger.png'),fullPage:true,animations:'disabled'});
    await page.getByRole('tab', { name: '需求操作', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(out, '03-mobile.png'),
      fullPage: true,
      animations: 'disabled',
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    await page
      .getByRole('heading', { name: '操作记录', exact: true })
      .waitFor();
    await page.getByText('流转至开发中', { exact: true }).waitFor();
    pendingStatus = 'succeeded';
    await page.getByRole('button', { name: '刷新操作记录' }).click();
    await page.getByRole('cell', { name: '已完成', exact: true }).waitFor();
    await page
      .getByRole('link', { name: '1 条操作处理中', exact: true })
      .waitFor({ state: 'hidden', timeout: 15000 });
    assert.equal(writes.length, 0, 'Refresh must not replay a mutation');
    await page.getByRole('link', { name: '管理员设置', exact: true }).click();
    await page
      .getByRole('heading', { name: '管理员设置', exact: true })
      .waitFor();
    await page.getByRole('cell', { name: '高级管理员', exact: true }).waitFor();
    await page.getByRole('cell', { name: '运行管理员', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: '编辑成员', exact: true }).count(),
      1,
    );
    await page.screenshot({
      path: path.join(out, '05-admins.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '编辑成员', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '移除 测试被授权成员', exact: true })
      .click();
    await page.getByRole('button', { name: '确认撤销', exact: true }).click();
    await page.getByText('已撤销', { exact: true }).waitFor();
    assert.deepEqual(memberChanges, [
      { userId: '185000000000000004', action: 'remove' },
    ]);
    assert.equal(roleUsers.length, 1);
    await page.screenshot({
      path: path.join(out, '06-admin-member-edit.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await page.getByRole('link', { name: '操作记录', exact: true }).click();
    role = 'operations_admin';
    await page.evaluate(() => {
      window._userInfo = {
        user_id: '185000000000000003',
        name: '测试运行管理员',
      };
      window.dispatchEvent(new Event('MiaoDaMetaInfoChanged'));
    });
    await page.getByRole('combobox', { name: '操作范围' }).waitFor();
    await page
      .getByRole('link', { name: '管理员设置', exact: true })
      .waitFor({ state: 'hidden' });
    assert.equal(
      await page.getByRole('tab', { name: '工作流通知', exact: true }).count(),
      1,
    );
    await page.getByRole('combobox', { name: '操作范围' }).click();
    await page.getByRole('option', { name: '全部操作', exact: true }).click();
    await page.getByText('流转至开发中', { exact: true }).waitFor();
    const roleReadsBeforeDenied = roleReads;
    await page.goto(
      'http://127.0.0.1:8091/app/app_17b6pxwde0x/operations/admins',
    );
    await page
      .getByRole('heading', { name: '仅高级管理员可访问', exact: true })
      .waitFor();
    assert.equal(roleReads, roleReadsBeforeDenied);
    await page.getByRole('link', { name: '返回运行中心', exact: true }).click();
    // Same-page identity switch: privileged cache must disappear without a reload.
    await page.getByRole('combobox', { name: '操作范围' }).click();
    await page.getByRole('option', { name: '全部操作', exact: true }).click();
    await page.getByText('流转至开发中', { exact: true }).waitFor();
    role = 'member';
    const requestStart = recordRequests.length;
    await page.evaluate(() => {
      window._userInfo = {
        user_id: '185000000000000002',
        name: '测试普通成员',
      };
      window.dispatchEvent(new Event('MiaoDaMetaInfoChanged'));
    });
    await page.getByText('我的操作', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[role=tab]'));
    assert.equal(
      await page.getByText('流转至开发中', { exact: true }).count(),
      0,
    );
    assert.equal(
      await page.getByRole('link', { name: '管理员设置' }).count(),
      0,
    );
    assert.ok(
      recordRequests
        .slice(requestStart)
        .every((request) => request.scope === 'mine'),
    );
    await page.screenshot({
      path: path.join(out, '04-member.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await page.goto(
      'http://127.0.0.1:8091/app/app_17b6pxwde0x/operations/admins',
    );
    await page
      .getByRole('heading', { name: '仅高级管理员可访问', exact: true })
      .waitFor();
    assert.equal(roleReads, roleReadsBeforeDenied);
    role='super_admin';
    await page.goto('http://127.0.0.1:8091/app/app_17b6pxwde0x/requirements');
    await page.getByRole('heading',{name:'需求池',exact:true}).waitFor();
    await page.getByText('隔离测试需求 A',{exact:true}).waitFor();
    assert.ok(businessCalls.filter((call)=>call.query).every((call)=>call.query.includeContent==='0'));
    await page.getByRole('button',{name:'保存视图',exact:true}).click();
    await page.getByPlaceholder('例如：本迭代待测试').fill('隔离保存视图');
    await page.getByRole('button',{name:'保存',exact:true}).click();
    await page.getByText('视图已保存',{exact:true}).waitFor();
    assert.equal(views.length,1);
    // Fresh document with local storage cleared: the shared simulated server is authoritative.
    await page.evaluate(()=>localStorage.clear());
    await page.reload();
    await page.getByRole('button',{name:'保存视图',exact:true}).click();
    await page.getByRole('button',{name:'隔离保存视图',exact:true}).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('checkbox',{name:'选择需求 隔离测试需求 A',exact:true}).click();
    await page.getByRole('checkbox',{name:'选择需求 隔离测试需求 B',exact:true}).click();
    await page.getByRole('button',{name:'批量修改',exact:true}).click();
    let dialog=page.getByRole('dialog');
    await dialog.getByRole('combobox').nth(0).click();
    await page.getByRole('option',{name:'优先级',exact:true}).click();
    await dialog.getByRole('combobox').nth(1).click();
    await page.getByRole('option',{name:'P1',exact:true}).click();
    await dialog.getByRole('button',{name:'预览影响',exact:true}).click();
    await dialog.getByText('影响预览 · 2 项可修改',{exact:true}).waitFor();
    assert.equal(businessCalls.filter((call)=>call.path.endsWith('/execute')).length,0);
    await dialog.getByRole('button',{name:'确认修改可执行项',exact:true}).click();
    await dialog.getByText('逐项结果',{exact:true}).waitFor();
    await dialog.getByText('测试冲突，请查看最新值',{exact:true}).waitFor();
    await dialog.getByRole('button',{name:'仅预览失败项重试',exact:true}).click();
    await dialog.getByText('影响预览 · 1 项可修改',{exact:true}).waitFor();
    assert.equal(await dialog.getByText(/隔离测试需求 A/).count(),0);
    assert.equal(businessCalls.filter((call)=>call.path.endsWith('/execute')).length,1);
    await page.screenshot({path:path.join(out,'10-bulk-retry-preview.png'),fullPage:true,animations:'disabled'});
    await dialog.getByRole('button',{name:'取消',exact:true}).click();
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, []);
    console.log(
      JSON.stringify({
        passed: true,
        checks: [
          'desktop',
          'mobile',
          'failure-stage-detail',
          'requirement-deep-link',
          'runtime-tabs',
          'dependency-health',
          'ai-usage',
          'alerts-recovery',
          'notification-ledger',
          'refresh-without-write',
          'same-page-user-isolation',
          'super-admin-member-delta',
          'runtime-admin-global-readonly',
          'member-admin-route-denied',
          'lightweight-requirement-list', 'saved-view-create', 'saved-view-without-local-storage',
          'bulk-preview-without-write', 'bulk-partial-result', 'retry-failed-only-preview',
        ],
        recordRequests: recordRequests.length,
        writes,
        simulatedMemberChanges: memberChanges,
        simulatedBusinessCalls:businessCalls,
        errors,
        screenshots: out,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        browserErrors: errors,
        recordRequests,
        body: await page
          .locator('body')
          .innerText()
          .catch(() => ''),
      }),
    );
    await page
      .screenshot({ path: path.join(out, 'failure-debug.png'), fullPage: true })
      .catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
