import { personalRequirementTodos } from '../../server/modules/requirements/requirement-personal-todos';
import type {
  WorkspaceResponse,
  RequirementSummary,
} from '../../shared/api.interface';

const row = (id: string, isMine = true, status = '开发中') =>
  ({
    id,
    code: id,
    title: '虚构需求',
    isMine,
    status,
    project: '虚构项目',
    deadlineAt: null,
    handlers: [{ id: 'open_fixture', name: '同名成员' }],
    personnelUserIds: { handlers: [] },
    introduction: 'Not part of the todo payload',
  }) as unknown as RequirementSummary;
const workspace = (requirements: RequirementSummary[]) =>
  ({
    requirements,
    currentUser: { miaodaUserId: 'fixture', name: '虚构成员' },
    fetchedAt: '2026-10-05',
    freshness: { stale: false },
  }) as WorkspaceResponse;

describe('personal requirement todos', () => {
  it('uses server-resolved isMine, not empty personnel IDs or same-name handlers', () => {
    const result = personalRequirementTodos(
      workspace([
        row('1'),
        row('2', false),
        row('3', true, '已发布'),
        row('4', true, '已关闭'),
        row('5', true, '已解决'),
      ]),
      { limit: 100 },
    );
    expect(result.requirements.map((r) => r.id)).toEqual(['1', '5']);
    expect(JSON.stringify(result)).not.toMatch(
      /Not part|personnelUserIds|handlers/,
    );
    expect(result.total).toBe(2);
  });
  it('pages beyond 100 without duplication and detects changes or account switches', () => {
    const w = workspace(
      Array.from({ length: 213 }, (_, n) => row(String(n).padStart(4, '0'))),
    );
    const first = personalRequirementTodos(w, { limit: 100 });
    const second = personalRequirementTodos(w, {
      limit: 100,
      cursor: first.nextCursor!,
    });
    const last = personalRequirementTodos(w, {
      limit: 100,
      cursor: second.nextCursor!,
    });
    expect(
      new Set(
        [
          ...first.requirements,
          ...second.requirements,
          ...last.requirements,
        ].map((r) => r.id),
      ).size,
    ).toBe(213);
    expect(last.nextCursor).toBeNull();
    const changed = workspace(w.requirements.slice(1));
    expect(
      personalRequirementTodos(changed, {
        limit: 100,
        cursor: first.nextCursor!,
      }).restartRequired,
    ).toBe(true);
    w.currentUser.miaodaUserId = 'other';
    expect(
      personalRequirementTodos(w, { limit: 100, cursor: first.nextCursor! })
        .restartRequired,
    ).toBe(true);
  });
});
