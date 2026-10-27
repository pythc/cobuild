import type { RequirementPatch } from '@shared/api.interface';
import {
  allowedStatuses,
  hasMeaningfulText,
  isStatusOnlyRequirementPatch,
  normalizeRequirementStatus,
  pruneRequirementPatch,
  resolveRequirementUpdateConflict,
  workflowStatusSortRank,
} from '../../server/modules/requirements/requirements.model';

describe('requirement update conflict resolution', () => {
  const previousUpdatedAt: number = 1_700_000_000_000;
  const currentUpdatedAt: number = 1_700_000_001_000;

  it('proceeds when the version is current', () => {
    expect(
      resolveRequirementUpdateConflict(
        currentUpdatedAt,
        currentUpdatedAt,
        { status: '开发中' },
        '需求已评审',
      ),
    ).toBe('proceed');
  });

  it('rebases a status-only transition after unrelated changes', () => {
    expect(
      resolveRequirementUpdateConflict(
        previousUpdatedAt,
        currentUpdatedAt,
        { status: '开发中' },
        '需求已评审',
      ),
    ).toBe('rebase');
  });

  it('treats an already completed transition as idempotent', () => {
    expect(
      resolveRequirementUpdateConflict(
        previousUpdatedAt,
        currentUpdatedAt,
        { status: '开发中' },
        '开发中',
      ),
    ).toBe('already-applied');
  });

  it('rejects a stale transition when the latest status is incompatible', () => {
    expect(
      resolveRequirementUpdateConflict(
        previousUpdatedAt,
        currentUpdatedAt,
        { status: '开发中' },
        '测试中',
      ),
    ).toBe('conflict');
  });

  it('keeps optimistic locking for multi-field edits', () => {
    const patch: RequirementPatch = {
      status: '开发中',
      priority: 'P1',
    };
    expect(isStatusOnlyRequirementPatch(patch)).toBe(false);
    expect(
      resolveRequirementUpdateConflict(
        previousUpdatedAt,
        currentUpdatedAt,
        patch,
        '需求已评审',
      ),
    ).toBe('conflict');
  });

  it('rejects a stale transition form that also changes content', () => {
    expect(
      resolveRequirementUpdateConflict(
        previousUpdatedAt,
        currentUpdatedAt,
        {
          status: '需求已评审',
          introduction: '<p>需求背景</p>',
          acceptanceCriteria: '验收条件',
        },
        '新',
        '产品需求',
      ),
    ).toBe('conflict');
  });
});

describe('meaningful rich text', () => {
  it('treats empty editor markup as empty', () => {
    expect(hasMeaningfulText('<p></p>')).toBe(false);
    expect(hasMeaningfulText('<p>&nbsp;</p>')).toBe(false);
  });

  it('keeps actual rich-text content', () => {
    expect(hasMeaningfulText('<h2>背景</h2><p>解决流转体验问题</p>')).toBe(
      true,
    );
  });
});

describe('type-specific workflows', () => {
  it('normalizes legacy requirement statuses during migration', () => {
    expect(normalizeRequirementStatus('需求待评审')).toBe('新');
    expect(normalizeRequirementStatus('已评审')).toBe('需求已评审');
    expect(normalizeRequirementStatus('发布中')).toBe('待发布');
    expect(normalizeRequirementStatus('待验证')).toBe('已解决');
  });

  it('keeps the normal requirement workflow adjacent', () => {
    expect(allowedStatuses('开发中', '产品需求')).toEqual([
      '需求已评审',
      '开发中',
      '开发转测试',
    ]);
  });

  it('uses the defect transition graph instead of requirement stages', () => {
    expect(allowedStatuses('处理中', '缺陷')).toEqual([
      '处理中',
      '已解决',
      '已拒绝',
    ]);
    expect(allowedStatuses('已关闭', '缺陷')).toEqual(['已关闭', '重新打开']);
  });

  it('sorts normal and defect statuses in their workflow order', () => {
    expect(workflowStatusSortRank('新')).toBeLessThan(
      workflowStatusSortRank('需求已评审'),
    );
    expect(workflowStatusSortRank('处理中')).toBeLessThan(
      workflowStatusSortRank('已解决'),
    );
  });
});

describe('requirement patch pruning', () => {
  it('removes semantically unchanged values before writing to Base', () => {
    const current = {
      title: '测试需求',
      introduction: '<p>介绍</p>',
      acceptanceCriteria: '验收',
      selfTestReport: '已通过核心场景验证',
      defectCause: '',
      gitBranchName: 'feature/REQ-1',
      githubPullRequestUrl: 'https://github.com/pythc/repo/pull/1',
      type: '未设置',
      source: '产品规划',
      tags: ['稳定性', '易用性'],
      status: '开发中',
      priority: 'P1',
      project: '测试项目',
      iterationIds: ['iteration-b', 'iteration-a'],
      startAt: null,
      deadlineAt: 1_700_000_000_000,
      developmentStartAt: null,
      developmentEndAt: null,
      testingAt: null,
      actualStartAt: null,
      actualTestingAt: null,
      actualReleaseAt: null,
      effort: 3,
      latestProgress: '进行中',
      blocked: false,
      blocker: '',
      personnelUserIds: {
        handlers: ['handler-1'],
        productOwners: ['product-1'],
        developers: ['developer-1'],
        testers: ['tester-1'],
        foOwners: ['fo-1'],
        proposers: ['proposer-1'],
        followers: ['follower-1'],
        releaseOwners: ['release-1'],
      },
    };
    expect(
      pruneRequirementPatch(
        {
          title: ' 测试需求 ',
          introduction: '<p>介绍</p>',
          acceptanceCriteria: '验收',
          selfTestReport: '已通过核心场景验证',
          defectCause: '',
          gitBranchName: 'feature/REQ-1',
          githubPullRequestUrl: 'https://github.com/pythc/repo/pull/1',
          type: '',
          source: '产品规划',
          tags: ['易用性', '稳定性'],
          status: '开发中',
          priority: 'P1',
          project: '测试项目',
          iterationIds: ['iteration-a', 'iteration-b'],
          startAt: null,
          deadlineAt: 1_700_000_000_000,
          effort: 3,
          latestProgress: '进行中',
          blocked: false,
          blocker: '',
          handlerLarkUserIds: ['handler-1'],
          productOwnerLarkUserIds: ['product-1'],
          developerLarkUserIds: ['developer-1'],
          testerLarkUserIds: ['tester-1'],
          foOwnerLarkUserIds: ['fo-1'],
          proposerLarkUserIds: ['proposer-1'],
          followerLarkUserIds: ['follower-1'],
          releaseOwnerLarkUserIds: ['release-1'],
        },
        current,
      ),
    ).toEqual({});
  });

  it('keeps only the fields that truly changed', () => {
    const current = {
      title: '测试需求',
      introduction: '',
      acceptanceCriteria: '',
      selfTestReport: '',
      defectCause: '',
      gitBranchName: '',
      githubPullRequestUrl: '',
      type: '产品需求',
      source: '产品规划',
      tags: [],
      status: '开发中',
      priority: 'P1',
      project: '测试项目',
      iterationIds: [],
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
      personnelUserIds: {
        handlers: [],
        productOwners: [],
        developers: [],
        testers: [],
        foOwners: [],
        proposers: [],
        followers: [],
        releaseOwners: [],
      },
    };
    expect(
      pruneRequirementPatch(
        { priority: 'P0', project: '测试项目', iterationIds: [] },
        current,
      ),
    ).toEqual({ priority: 'P0' });
  });
});

describe('Bitable linked cell compatibility',()=>{
  it('normalizes list/search shapes without dropping iteration links',()=>{
    const {linkedIds}=require('../../server/modules/requirements/requirements.model');
    for(const cell of [['recA'],[{record_id:'recA'}],[{record_ids:['recA']}],{link_record_ids:['recA']},[{link_record_ids:['recA']}]] )
      expect(linkedIds(cell)).toEqual(['recA']);
    expect(linkedIds([{link_record_ids:['recA','recA',null]},null])).toEqual(['recA']);
  });
  it('preserves real Feishu avatars and rejects unsafe avatar URLs',()=>{
    const {people}=require('../../server/modules/requirements/requirements.model');
    expect(people([{id:'ou_test',name:'测试',avatar_url:'https://cdn.example/avatar.png'}])[0].avatarUrl).toBe('https://cdn.example/avatar.png');
    expect(people([{id:'ou_test',name:'测试',avatar_url:'javascript:alert(1)'}])[0].avatarUrl).toBeUndefined();
  });
});
