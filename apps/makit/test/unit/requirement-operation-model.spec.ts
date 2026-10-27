import type {
  RequirementSummary,
  RequirementUpdateInput,
} from '../../shared/api.interface';
import {
  currentPatchValues,
  mergeOperationPatch,
  operationValuesEqual,
  prepareOperationInput,
} from '../../shared/requirement-operation';
import {
  mcpMutationHash,
  operationRequestHash,
  validateOperationEnvelope,
} from '../../server/modules/requirements/requirement-operation.model';

const current = (extra: Partial<RequirementSummary> = {}) =>
  ({
    updatedAt: 2,
    priority: 'P1',
    project: '项目',
    personnelUserIds: { handlers: ['a', 'b'] },
    ...extra,
  }) as RequirementSummary;
describe('immutable operation intent', () => {
  it('merges another field without a timestamp-only conflict', () => {
    expect(
      mergeOperationPatch(current(), {
        expectedUpdatedAt: 1,
        patch: { project: '新项目' },
        baseValues: { project: '项目' },
      }).conflicts,
    ).toEqual([]);
  });
  it('rejects actual same-field conflict; identical intended value is a no-op', () => {
    expect(
      mergeOperationPatch(current(), {
        expectedUpdatedAt: 1,
        patch: { priority: 'P0' },
        baseValues: { priority: 'P2' },
      }).conflicts,
    ).toHaveLength(1);
    expect(
      mergeOperationPatch(current(), {
        expectedUpdatedAt: 1,
        patch: { priority: 'P1' },
        baseValues: { priority: 'P2' },
      }).conflicts,
    ).toEqual([]);
  });
  it('preserves concurrent additions and explicit removals', () => {
    const original = current({
      personnelUserIds: {
        handlers: ['a'],
      } as RequirementSummary['personnelUserIds'],
    });
    const prepared = prepareOperationInput(original, {
      expectedUpdatedAt: 1,
      patch: { handlerLarkUserIds: ['c'] },
    });
    expect(mergeOperationPatch(current(), prepared)).toEqual({
      patch: { handlerLarkUserIds: ['b', 'c'] },
      conflicts: [],
    });
  });
  it('does not turn explicit add into an empty diff if a concurrent actor already added it', () => {
    const input: RequirementUpdateInput = {
      patch: { handlerLarkUserIds: ['c'] },
      personnelChanges: {
        handlers: { add: ['c'], remove: [], identityType: 'feishu' },
      },
    };
    const prepared = prepareOperationInput(current(), input);
    expect(prepared.personnelChanges).toEqual(input.personnelChanges);
    expect(
      mergeOperationPatch(current(), prepared).patch.handlerLarkUserIds,
    ).toEqual(['a', 'b', 'c']);
  });
  it('never compares Miaoda IDs against Feishu employee IDs', () => {
    expect(currentPatchValues(current(), { handlerUserIds: ['123'] })).toEqual(
      {},
    );
    expect(
      mergeOperationPatch(current(), {
        expectedUpdatedAt: 1,
        patch: { handlerUserIds: ['123'] },
      }).conflicts,
    ).toHaveLength(1);
  });
  it.each([
    [null, ''],
    ['  ', null],
    [
      ['b', 'a'],
      ['a', 'b', 'a'],
    ],
  ])('normalizes empty/set values %j %j', (a, b) =>
    expect(operationValuesEqual(a, b)).toBe(true),
  );
  it('hash ignores object order and key itself, not baseline or intent', () => {
    const a = {
      patch: { priority: 'P1', project: '项目' },
      baseValues: { priority: 'P2' },
    };
    expect(operationRequestHash('recA', a)).toBe(
      operationRequestHash('recA', {
        baseValues: a.baseValues,
        patch: { project: '项目', priority: 'P1' },
        clientMutationId: 'different',
      }),
    );
    expect(operationRequestHash('recA', a)).not.toBe(
      operationRequestHash('recB', a),
    );
    expect(
      mcpMutationHash('fields', {
        requirement: 'recA',
        priority: 'P1',
        clientMutationId: 'first',
      }),
    ).toBe(
      mcpMutationHash('fields', {
        priority: 'P1',
        requirement: 'recA',
        clientMutationId: 'retry',
      }),
    );
  });
  it.each([
    { patch: [] },
    { patch: {}, baseValues: [] },
    { patch: {}, personnelChanges: 'bad' },
    { patch: { handlerUserIds: ['1'], handlerLarkUserIds: ['a'] } },
    {
      patch: {},
      personnelChanges: {
        handlers: { identityType: 'feishu', add: ['a'], remove: ['a'] },
      },
    },
    { patch: {}, baseValues: { handlerUserIds: ['1'] } },
    { patch: {}, clientMutationId: '../x' },
    { patch: {}, source: 'forged' },
  ])('rejects malformed or ambiguous envelope %j', (input) =>
    expect(() =>
      validateOperationEnvelope(input as unknown as RequirementUpdateInput),
    ).toThrow(),
  );
});
