import {
  employeeUserIds,
  employeeUsers,
  mergeEmployeeUsers,
  sameEmployeeUsers,
  personnelUpdateInput,
} from '../../client/src/lib/personnel-users';
import { selectableUserId } from '../../client/src/lib/user-identifiers';
import {
  prepareOperationInput,
  mergeOperationPatch,
} from '../../shared/requirement-operation';
import type {
  RequirementPersonnelResponse,
  RequirementSummary,
} from '../../shared/api.interface';

describe('personnel user identity handling', () => {
  it.each([
    ['remove', [], []],
    ['replace', ['new'], ['new']],
    ['add', ['old', 'new'], ['old', 'new']],
  ])(
    'preserves %s intent when the list snapshot omits personnel IDs',
    (_action, desired, expected) => {
      const snapshot: RequirementPersonnelResponse = {
        recordId: 'fixture',
        updatedAt: 100,
        personnelUserIds: {
          handlers: [],
          productOwners: [],
          developers: [],
          testers: ['old'],
          foOwners: [],
          proposers: [],
          followers: [],
          releaseOwners: [],
        },
      };
      const input = personnelUpdateInput(
        snapshot,
        'testers',
        desired.map((employee_id) => ({ employee_id })),
      );
      const listRow = {
        updatedAt: 100,
        personnelUserIds: { ...snapshot.personnelUserIds, testers: [] },
      } as RequirementSummary;
      const prepared = prepareOperationInput(listRow, input);
      const current = {
        ...listRow,
        personnelUserIds: { ...snapshot.personnelUserIds },
      };
      expect(
        mergeOperationPatch(current, prepared).patch.testerLarkUserIds,
      ).toEqual(expected);
      // Another editor's simultaneous addition must survive our remove/replace.
      current.personnelUserIds.testers = ['old', 'concurrent'];
      expect(
        mergeOperationPatch(current, prepared).patch.testerLarkUserIds,
      ).toEqual(
        expected.includes('old')
          ? ['old', 'concurrent', ...expected.filter((id) => id !== 'old')]
          : ['concurrent', ...expected],
      );
      expect(input.expectedUpdatedAt).toBe(100);
      expect(snapshot.personnelUserIds.testers).toEqual(['old']);
    },
  );
  it('uses employeeID instead of the unsupported larkUserID for Feishu writes', () => {
    const user = {
      userID: 'miaoda-1',
      larkUserID: 'internal-lark-1',
      employeeID: 'employee-1',
    };

    expect(selectableUserId(user, 'lark')).toBe('employee-1');
    expect(selectableUserId(user, 'apaas')).toBe('miaoda-1');
  });

  it('keeps existing members when one more member is selected', () => {
    const existing = employeeUsers(
      ['employee-1', 'employee-2'],
      [
        { id: 'open-1', name: '成员一' },
        { id: 'open-2', name: '成员二' },
      ],
    );
    const merged = mergeEmployeeUsers(existing, [
      {
        employee_id: 'employee-3',
        name: '成员三',
        user_type: '_employee',
      },
    ]);

    expect(employeeUserIds(merged)).toEqual([
      'employee-1',
      'employee-2',
      'employee-3',
    ]);
    expect(sameEmployeeUsers(existing, merged)).toBe(false);
  });

  it('deduplicates members by employeeID without changing the original order', () => {
    const merged = mergeEmployeeUsers(
      [{ employee_id: 'employee-1', name: '旧名称' }],
      [
        { employee_id: 'employee-1', name: '新名称' },
        { employee_id: 'employee-2', name: '成员二' },
      ],
    );

    expect(employeeUserIds(merged)).toEqual(['employee-1', 'employee-2']);
    expect(merged[0]?.name).toBe('新名称');
  });
});
