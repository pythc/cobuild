import type {
  RequirementDetailResponse,
  RequirementListResponse,
  RequirementSummary,
} from '@shared/api.interface';
import {
  applyOptimisticRequirementUpdate,
  updateRequirementDetail,
  updateRequirementList,
} from '../../client/src/lib/optimistic-requirement';

function requirement(
  id: string,
  overrides: Partial<RequirementSummary> = {},
): RequirementSummary {
  return {
    id,
    title: `需求 ${id}`,
    priority: 'P2',
    status: '新',
    type: '产品需求',
    iterationIds: [],
    iterationNames: [],
    handlers: [],
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
    ...overrides,
  } as RequirementSummary;
}

describe('optimistic requirement cache updates', () => {
  it('applies direct fields and explicit display overrides only', () => {
    const current = requirement('req-1');
    const result = applyOptimisticRequirementUpdate(
      current,
      {
        priority: 'P0',
        iterationIds: ['iteration-1'],
        handlerLarkUserIds: ['employee-1'],
      },
      {
        iterationNames: ['迭代 1'],
        handlers: [{ id: 'employee-1', name: '测试成员' }],
      },
    );

    expect(result).toMatchObject({
      priority: 'P0',
      iterationIds: ['iteration-1'],
      iterationNames: ['迭代 1'],
      handlers: [{ id: 'employee-1', name: '测试成员' }],
    });
    expect(current.priority).toBe('P2');
    expect('handlerLarkUserIds' in result).toBe(false);
  });

  it('updates both flat and grouped requirement list entries', () => {
    const first = requirement('req-1');
    const second = requirement('req-2');
    const list = {
      items: [first, second],
      groups: [
        { key: 'all', label: '全部', items: [first, second], totalCount: 2 },
      ],
    } as RequirementListResponse;

    const result = updateRequirementList(list, 'req-2', {
      type: '缺陷',
      status: '处理中',
    });

    expect(result?.items[0]).toBe(first);
    expect(result?.items[1]).toMatchObject({
      type: '缺陷',
      status: '处理中',
    });
    expect(result?.groups?.[0].items[1]).toMatchObject({
      type: '缺陷',
      status: '处理中',
    });
  });

  it('leaves a different requirement detail untouched', () => {
    const detail = {
      requirement: requirement('req-1'),
    } as RequirementDetailResponse;

    expect(updateRequirementDetail(detail, 'req-2', { priority: 'P0' })).toBe(
      detail,
    );
  });
});
