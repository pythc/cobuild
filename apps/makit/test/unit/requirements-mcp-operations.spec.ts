const mockTools = new Map<
  string,
  {
    schema: { parse: (input: unknown) => unknown };
    call: (input: unknown) => Promise<unknown>;
  }
>();
jest.mock('@modelcontextprotocol/server', () => ({
  McpServer: class {
    registerTool(
      name: string,
      options: { inputSchema: { parse: (input: unknown) => unknown } },
      callback: (input: unknown) => Promise<unknown>,
    ) {
      mockTools.set(name, { schema: options.inputSchema, call: callback });
    }
  },
}));
import { RequirementsMcpService } from '../../server/modules/requirements/requirements-mcp.service';
import { mergeOperationPatch } from '../../shared/requirement-operation';
import type { RequirementSummary } from '../../shared/api.interface';
describe('MCP mutation routing', () => {
  function setup() {
    mockTools.clear();
    const user = { miaodaUserId: 'test-only' };
    const current = {
      id: 'recTest',
      title: 'old title',
      code: 'REQ-TEST',
      updatedAt: 1,
      personnelUserIds: { handlers: ['existing'] },
    };
    const query = {
      workspaceAs: jest.fn().mockResolvedValue({ requirements: [current] }),
      requirementPersonnel: jest
        .fn()
        .mockResolvedValue({ personnelUserIds: current.personnelUserIds }),
    };
    const jobs = {
      replayMcpAs: jest.fn().mockResolvedValue(null),
      enqueueAs: jest
        .fn()
        .mockResolvedValue({ jobId: 'test-operation', jobStatus: 'queued' }),
    };
    const prs = { detail: jest.fn() };
    new RequirementsMcpService(
      query as never,
      {} as never,
      prs as never,
      {} as never,
      {} as never,
      jobs as never,
    ).createServer(user as never);
    return { jobs, query, user, current, prs };
  }
  const call = (name: string, input: unknown) => {
    const tool = mockTools.get(name)!;
    return tool.call(tool.schema.parse(input));
  };
  it.each([
    'requirement_update_fields',
    'requirement_update_personnel',
    'requirement_transition_status',
  ])('resolves replay before rereading a changed title: %s', async (name) => {
    const { jobs, query, user } = setup();
    jobs.replayMcpAs.mockResolvedValue({
      jobId: 'original',
      jobStatus: 'succeeded',
    });
    await call(name, {
      requirement: 'title no longer exists',
      clientMutationId: 'same-retry-key',
      role: 'handlers',
      userIds: ['new'],
      status: '开发中',
      priority: 'P1',
    });
    expect(jobs.replayMcpAs).toHaveBeenCalledWith(
      'same-retry-key',
      expect.stringMatching(/^[a-f0-9]{64}$/),
      user,
    );
    expect(query.workspaceAs).not.toHaveBeenCalled();
    expect(jobs.enqueueAs).not.toHaveBeenCalled();
  });
  it.each(['add', 'remove'])(
    'preserves explicit personnel %s intent through the common queue',
    async (mode) => {
      const { jobs, user, current } = setup();
      await call('requirement_update_personnel', {
        requirement: 'recTest',
        clientMutationId: 'new-personnel-key',
        role: 'handlers',
        userIds: ['new'],
        mode,
      });
      const [id, input, actor, hash] = jobs.enqueueAs.mock.calls[0];
      expect(id).toBe('recTest');
      expect(actor).toBe(user);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      expect(input.source).toBe('mcp');
      expect(input.personnelChanges.handlers).toEqual({
        identityType: 'feishu',
        add: mode === 'add' ? ['new'] : [],
        remove: mode === 'remove' ? ['new'] : [],
      });
      expect(
        mergeOperationPatch(
          {
            ...current,
            personnelUserIds: { handlers: ['existing', 'concurrent', 'new'] },
          } as RequirementSummary,
          input,
        ).patch.handlerLarkUserIds,
      ).toEqual(
        mode === 'add'
          ? ['existing', 'concurrent', 'new']
          : ['existing', 'concurrent'],
      );
    },
  );
  it.each([
    'requirement_get',
    'requirement_update_fields',
    'requirement_update_personnel',
    'requirement_transition_status',
  ])('rejects ambiguous titles before any write: %s', async (name) => {
    const { query, jobs, current } = setup();
    query.workspaceAs.mockResolvedValue({
      requirements: [
        current,
        { ...current, id: 'recOther', code: 'REQ-OTHER' },
      ],
    });
    await expect(
      call(name, {
        requirement: current.title,
        clientMutationId: 'ambiguous-key',
        role: 'handlers',
        userIds: [],
        status: '开发中',
        priority: 'P1',
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'ambiguous_requirement',
        candidates: [
          { id: 'recTest', code: 'REQ-TEST', title: 'old title' },
          { id: 'recOther', code: 'REQ-OTHER', title: 'old title' },
        ],
      },
    });
    expect(jobs.enqueueAs).not.toHaveBeenCalled();
    expect(query.requirementPersonnel).not.toHaveBeenCalled();
  });
  it.each(['recTest', 'REQ-TEST'])(
    'stable identifier %s wins over a colliding title',
    async (selector) => {
      const { query, jobs, current } = setup();
      query.workspaceAs.mockResolvedValue({
        requirements: [
          { ...current, id: 'recOther', code: 'REQ-OTHER', title: selector },
          current,
        ],
      });
      await call('requirement_update_fields', {
        requirement: selector,
        clientMutationId: 'unique-target-key',
        priority: 'P1',
      });
      expect(jobs.enqueueAs.mock.calls[0][0]).toBe(current.id);
    },
  );
  it('passes through PR collection completeness instead of claiming partial comments are complete', async () => {
    const { prs } = setup();
    const completeness = {
      comments: { loadedCount: 0, totalCount: 15, complete: false },
      reviews: { loadedCount: 0, totalCount: 0, complete: true },
      reviewThreads: { loadedCount: 0, totalCount: 20, complete: false },
    };
    prs.detail.mockResolvedValue({
      pullRequest: {
        number: 42,
        labels: [],
        linkedRequirements: [],
        linkedIterationIds: [],
        linkedIterationNames: [],
        requestedReviewers: [],
      },
      comments: [],
      reviews: [],
      reviewThreads: [],
      checks: [],
      reviewerCandidates: [],
      reviewerNotifications: [],
      completeness,
    });
    const reply: any = await call('pull_request_get', { pullNumber: 42 });
    expect(reply.structuredContent.completeness).toEqual(completeness);
    expect(JSON.parse(reply.content[0].text).completeness).toEqual(
      completeness,
    );
  });
});
