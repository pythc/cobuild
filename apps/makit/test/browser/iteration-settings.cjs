// Run with only Vite. Every API response is mocked; no backend or real credentials are used.
// PLAYWRIGHT_MODULE may point to an isolated Playwright installation.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const { defaultIterationConfiguration } = require(
  path.join(root, 'dist/shared/iteration-workflow.js'),
);
const fs = require('node:fs');
const assert = require('node:assert/strict');
const out = path.join(root, 'audits/2026-09-07-iteration-settings');
fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const errors = [];
  const writes = [];
  const unexpected = new Set();
  const actor = {
    miaodaUserId: 'qa-user',
    employeeId: 'qa-employee',
    name: '测试管理员',
    accessLevel: 'admin',
    roles: ['admin'],
    capabilities: {},
  };
  const options = {
    statuses: ['新', '开发中', '已发布'],
    priorities: ['P2'],
    projects: ['测试项目'],
    types: ['产品需求'],
    sources: [],
    tags: [],
    relationTypes: [],
  };
  const people = Object.fromEntries(
    [
      'handlers',
      'productOwners',
      'developers',
      'testers',
      'foOwners',
      'proposers',
      'followers',
      'releaseOwners',
    ].map((key) => [
      key,
      key === 'handlers' ? [{ id: 'qa-employee', name: '测试管理员' }] : [],
    ]),
  );
  const personIds = Object.fromEntries(
    Object.entries(people).map(([key, value]) => [
      key,
      value.map((person) => person.id),
    ]),
  );
  const flow = {
    iterationId: 'qa-iteration',
    version: 1,
    statuses: ['新', '开发中', '已发布'],
    transitions: [
      {
        from: '新',
        to: '开发中',
        requiredFields: ['handlers'],
        reviews: [],
        releaseChecks: [],
        assigneeRole: 'handlers',
      },
      {
        from: '开发中',
        to: '已发布',
        requiredFields: ['handlers'],
        reviews: [],
        releaseChecks: [],
        assigneeRole: 'handlers',
      },
    ],
  };
  let requirement = {
    ...people,
    personnelUserIds: personIds,
    id: 'qa-requirement',
    code: 'REQ-QA',
    title: '隔离测试需求',
    url: '#',
    introduction: '仅用于隔离的浏览器交互测试',
    acceptanceCriteria: '',
    selfTestReport: '',
    defectCause: '',
    gitBranchName: '',
    githubPullRequestUrl: '',
    type: '产品需求',
    source: '',
    tags: [],
    status: '新',
    allowedStatuses: ['开发中'],
    priority: 'P2',
    project: '测试项目',
    iterationIds: ['qa-iteration'],
    iterationNames: ['工作流测试'],
    workflow: flow,
    startAt: null,
    deadlineAt: null,
    developmentStartAt: null,
    developmentEndAt: null,
    testingAt: null,
    actualStartAt: null,
    actualTestingAt: null,
    actualReleaseAt: null,
    effort: null,
    latestProgress: '',
    blocked: false,
    blocker: '',
    updatedAt: 1,
    updatedByName: '测试管理员',
    groupChatId: '',
    groupLink: '',
    groupStatus: '',
    isMine: true,
    risks: [],
    capabilities: {
      canUpdate: true,
      canArchive: false,
      canManageGroup: false,
      canManageAcceptance: false,
      canManageRelations: false,
      canComment: false,
    },
  };
  let submitted = null;
  let readinessChecks = [];
  let readinessError = false;
  let readinessBarrier = Promise.resolve();
  let updateMode = 'success';
  let updateBarrier = Promise.resolve();
  let updateCount = 0;
  let state = {
    iterationId: 'qa-iteration',
    iterationName: '工作流测试',
    revision: 0,
    draft: defaultIterationConfiguration([
      { id: 'release', name: '正式发布', dueAt: null },
    ]),
    published: null,
    history: [],
  };
  await context.route('**/*', async (route) => {
    const r = route.request(),
      u = new URL(r.url());
    const json = (data) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(data),
      });
    if (u.hostname !== '127.0.0.1') return route.abort();
    const assetPrefix = '/app/app_17b6pxwde0x/assets/';
    if (u.pathname.startsWith(assetPrefix)) {
      const asset = path.join(
        root,
        'dist/client/assets',
        path.basename(u.pathname),
      );
      if (fs.existsSync(asset)) {
        const ext = path.extname(asset);
        return route.fulfill({
          contentType:
            {
              '.js': 'application/javascript',
              '.css': 'text/css',
              '.woff2': 'font/woff2',
              '.woff': 'font/woff',
            }[ext] || 'application/octet-stream',
          body: fs.readFileSync(asset),
        });
      }
    }
    if (r.resourceType() === 'document')
      return route.fulfill({
        contentType: 'text/html',
        body: fs
          .readFileSync(path.join(root, 'dist/client/index.html'), 'utf8')
          .replace(/\{\{\{?[^}]+\}\}\}?/g, ''),
      });
    if (u.pathname.endsWith('/api/workspace/current-user')) return json(actor);
    if (
      u.pathname.includes('/__runtime__/') ||
      u.pathname.includes('/api/sdk_innerapi/') ||
      u.pathname.includes('/api/authnpaas/') ||
      u.pathname.includes('/dev/')
    )
      return json({ code: 0, data: {} });
    if (u.pathname.endsWith('.map'))
      return route.fulfill({ status: 404, body: '' });
    if (u.pathname.endsWith('/api/workspace/requirements/edit-context'))
      return json({
        currentUser: actor,
        options,
        iterations: [
          { id: 'qa-iteration', name: '工作流测试' },
          { id: 'qa-source', name: '来源迭代' },
        ],
      });
    if (u.pathname.endsWith('/api/pull-requests/requirements/qa-requirement'))
      return json([]);
    if (
      u.pathname.endsWith(
        '/api/workspace/requirements/qa-requirement/release-readiness',
      )
    ) {
      await readinessBarrier;
      if (readinessError)
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: '发布检查暂时不可用' }),
        });
      const blockingReasons = readinessChecks
        .filter((check) => check.blocking && !check.passed)
        .map((check) => check.label);
      return json({
        requirementId: requirement.id,
        targetStatus: u.searchParams.get('targetStatus'),
        ready: !blockingReasons.length,
        checks: readinessChecks,
        blockingReasons,
      });
    }
    if (
      u.pathname.endsWith(
        '/api/workspace/requirements/qa-requirement/engineering',
      )
    )
      return json({
        requirementId: 'qa-requirement',
        artifacts: {},
        reviews: {
          clarity: {
            id: '',
            type: 'clarity',
            status: 'not_started',
            verdict: null,
            score: null,
            summary: '',
            dimensions: [],
            findings: [],
            current: false,
            model: '',
            errorMessage: '',
            overridden: false,
            createdAt: null,
            finishedAt: null,
          },
        },
        history: [],
        canUpdate: false,
        canOverride: false,
      });
    if (
      u.pathname.endsWith(
        '/api/workspace/requirements/qa-requirement/update-jobs',
      )
    ) {
      submitted = r.postDataJSON();
      updateCount += 1;
      await updateBarrier;
      if (updateMode === 'admission-failed')
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ message: '迭代规则已更新，请重试' }),
        });
      if (updateMode === 'success') {
        requirement = {
          ...requirement,
          ...submitted.patch,
          updatedAt: requirement.updatedAt + 1,
          allowedStatuses: ['已发布'],
        };
      }
      return json({
        success: true,
        message: '已修改',
        jobId: 'qa-job',
        jobStatus: 'queued',
      });
    }
    if (u.pathname.endsWith('/api/workspace/requirement-update-jobs/qa-job'))
      return json({
        id: 'qa-job',
        requirementId: requirement.id,
        status: updateMode === 'worker-failed' ? 'failed' : 'succeeded',
        attempts: 1,
        result: { success: true, message: '已修改' },
        errorMessage:
          updateMode === 'worker-failed'
            ? '发布检查未通过：合并请求状态有效'
            : '',
        createdAt: 1,
        finishedAt: 2,
      });
    if (u.pathname.endsWith('/api/workspace/requirements/qa-requirement'))
      return json({
        requirement,
        comments: [],
        acceptanceItems: [],
        relations: [],
        activities: [],
      });
    if (
      u.pathname.includes('/api/workspace/iterations/qa-iteration/settings')
    ) {
      if (r.method() === 'GET') return json(state);
      const input = r.postDataJSON();
      writes.push(u.pathname);
      if (u.pathname.endsWith('/validate'))
        return json({
          valid: true,
          requirementCount: 2,
          errors: [],
          changes: ['需求工作流将更新'],
        });
      assert.equal(input.expectedRevision, state.revision);
      state = {
        ...state,
        revision: state.revision + 1,
        draft: input.configuration,
      };
      if (u.pathname.endsWith('/publish')) {
        const published = {
          version: (state.published?.version || 0) + 1,
          publishedAt: new Date().toISOString(),
          publishedBy: '测试管理员',
          configuration: state.draft,
        };
        state.published = published;
        state.history.push(published);
      }
      return json(state);
    }
    if (
      ['fetch', 'xhr'].includes(r.resourceType()) &&
      !u.pathname.includes('/@') &&
      !u.pathname.endsWith('.js') &&
      !u.pathname.endsWith('.tsx') &&
      !u.pathname.endsWith('.ts')
    ) {
      unexpected.add(u.pathname);
      return json({ data: {}, code: 0 });
    }
    return route.continue();
  });
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(
      'http://127.0.0.1:8091/app/app_17b6pxwde0x/iterations/qa-iteration/settings',
    );
    await page
      .getByRole('heading', { name: '工作流测试 · 迭代设置' })
      .waitFor({ timeout: 45000 });
    await page.getByRole('combobox', { name: '添加一条流转' }).click();
    await page
      .getByRole('option', { name: '新 → 开发中', exact: true })
      .click();
    await page.getByText('未保存', { exact: true }).waitFor();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: out + '/01-workflow-desktop.png',
      fullPage: true,
      animations: 'disabled',
    });
    const git = page.getByText('Git 分支', { exact: true });
    await git.click();
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await page.getByText('草稿已保存', { exact: true }).waitFor();
    assert.equal(state.published, null);
    await page.getByRole('button', { name: '检查并发布', exact: true }).click();
    await page.getByRole('button', { name: '确认发布', exact: true }).click();
    await page.getByText('配置已发布', { exact: true }).waitFor();
    assert.equal(state.published.version, 1);
    assert.ok(
      state.published.configuration.workflows.requirement.transitions.some(
        (edge) => edge.from === '新' && edge.to === '开发中',
      ),
    );
    await page.getByRole('tab', { name: '里程碑', exact: true }).click();
    await page.getByRole('button', { name: '添加里程碑' }).click();
    await page.getByLabel('里程碑 2 名称').fill('灰度验收');
    await page.screenshot({
      path: out + '/02-milestones-desktop.png',
      fullPage: true,
    });
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await page
      .getByText('未保存', { exact: true })
      .waitFor({ state: 'hidden' });
    assert.equal(state.draft.milestones[1].name, '灰度验收');
    assert.equal(state.published.configuration.milestones.length, 1);
    await page.getByRole('tab', { name: '版本记录', exact: true }).click();
    await page.getByRole('button', { name: '恢复为草稿' }).click();
    await page.getByRole('button', { name: '替换草稿' }).click();
    await page.getByRole('tab', { name: '需求工作流', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: out + '/03-workflow-mobile.png',
      fullPage: true,
    });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    assert.equal(overflow, false, 'page should not overflow horizontally');
    assert.equal(
      writes.some((url) => !url.includes('/settings/')),
      false,
    );
    await page.goto(
      'http://127.0.0.1:8091/app/app_17b6pxwde0x/requirements/qa-requirement',
    );
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.getByRole('heading', { name: '隔离测试需求' }).waitFor();
    await page.getByRole('button', { name: '新', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.getByText('技术方案', { exact: true }).count(), 0);
    await page.screenshot({
      path: out + '/04-configured-transition.png',
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '确认流转', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByText('已修改', { exact: true }).first().waitFor();
    assert.equal(submitted.patch.status, '开发中');

    // Release-gate regressions. Requests never leave this isolated context.
    const releaseEdge = {
      from: '产品体验中',
      to: '待发布',
      requiredFields: ['handlers'],
      reviews: [],
      releaseChecks: ['acceptance_complete'],
      assigneeRole: 'handlers',
    };
    requirement = {
      ...requirement,
      status: '产品体验中',
      allowedStatuses: ['待发布'],
      workflow: {
        ...flow,
        version: 2,
        statuses: ['产品体验中', '待发布', '已发布'],
        transitions: [releaseEdge],
      },
    };
    const openRelease = async () => {
      await page.reload();
      await page.getByRole('heading', { name: '隔离测试需求' }).waitFor();
      await page
        .getByRole('button', { name: '产品体验中', exact: true })
        .click();
      await page.getByRole('dialog').waitFor();
    };
    const confirm = page.getByRole('button', { name: '确认流转', exact: true });
    const initialCount = updateCount;
    let releaseReadiness;
    readinessBarrier = new Promise((resolve) => {
      releaseReadiness = resolve;
    });
    readinessChecks = [
      {
        key: 'acceptance_complete',
        label: '验收项全部完成',
        passed: false,
        blocking: true,
        detail: '2 项尚未完成',
      },
    ];
    await openRelease();
    await page.getByText('正在检查发布条件…', { exact: true }).waitFor();
    assert.equal(await confirm.isEnabled(), false);
    releaseReadiness();
    await page.getByText('2 项尚未完成', { exact: true }).waitFor();
    await confirm.click();
    await page
      .getByText('发布检查未通过：验收项全部完成：2 项尚未完成', {
        exact: true,
      })
      .waitFor();
    assert.equal(await page.getByRole('dialog').isVisible(), true);
    assert.equal(
      updateCount,
      initialCount,
      'known failures must never be submitted',
    );
    await page.screenshot({
      path: out + '/05-release-blocked.png',
      fullPage: true,
    });

    readinessError = true;
    await page.getByRole('button', { name: '重新检查', exact: true }).click();
    await page
      .getByRole('alert')
      .filter({ hasText: '发布检查失败' })
      .waitFor({ timeout: 20000 });
    await confirm.click();
    await page.getByText('发布检查失败，请重试', { exact: true }).waitFor();
    assert.equal(updateCount, initialCount);
    readinessError = false;
    readinessChecks = [
      {
        key: 'self_test_report',
        label: '自测报告已填写',
        passed: true,
        blocking: true,
        detail: '已填写',
      },
    ];
    // New published policy disables acceptance checks, but keeps report checks.
    releaseEdge.releaseChecks = ['self_test_report'];
    await openRelease();
    await page.getByText('✓ 自测报告已填写', { exact: true }).waitFor();
    assert.equal(
      await page.getByText('验收项全部完成', { exact: false }).count(),
      0,
    );
    let releaseUpdate;
    updateBarrier = new Promise((resolve) => {
      releaseUpdate = resolve;
    });
    updateMode = 'worker-failed';
    await confirm.click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByText('已修改', { exact: true }).first().waitFor();
    await page.getByRole('button', { name: '待发布', exact: true }).waitFor();
    assert.equal(
      requirement.status,
      '产品体验中',
      'UI updates before the HTTP response or persistence',
    );
    await page.screenshot({
      path: out + '/06-release-optimistic.png',
      fullPage: true,
    });
    releaseUpdate();
    await page
      .getByText('修改失败：发布检查未通过：合并请求状态有效', { exact: true })
      .waitFor();
    await page
      .getByRole('button', { name: '产品体验中', exact: true })
      .waitFor();
    assert.equal(updateCount, initialCount + 1);
    await page.screenshot({
      path: out + '/07-release-restored.png',
      fullPage: true,
    });

    updateMode = 'admission-failed';
    await openRelease();
    await page.getByText('✓ 自测报告已填写', { exact: true }).waitFor();
    await confirm.click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByText('迭代规则已更新，请重试', { exact: true }).waitFor();
    await page
      .getByRole('button', { name: '产品体验中', exact: true })
      .waitFor();

    updateMode = 'success';
    await openRelease();
    await page.getByText('✓ 自测报告已填写', { exact: true }).waitFor();
    await confirm.click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '待发布', exact: true }).waitFor();
    assert.equal(requirement.status, '待发布');
    await page.reload();
    await page.getByRole('button', { name: '待发布', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    assert.deepEqual([...unexpected], []);
    console.log(
      JSON.stringify(
        {
          success: true,
          tested: [
            'add-transition',
            'draft',
            'publish',
            'milestone-edit',
            'history-to-draft',
            'mobile-no-overflow',
            'configured-transition',
            'dialog-close',
            'release-check-loading',
            'release-check-blocked-no-submit',
            'release-check-error-retry',
            'disabled-acceptance-checks',
            'optimistic-before-response',
            'worker-failure-restores-state',
            'admission-failure-restores-state',
            'release-success-survives-reload',
          ],
          writes,
          screenshots: out,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    await page.screenshot({ path: out + '/failure.png', fullPage: true });
    console.log(
      'page',
      (await page.locator('body').innerText()).slice(0, 5000),
    );
    console.log('errors', errors);
    console.log('unexpected', [...unexpected]);
    throw e;
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
