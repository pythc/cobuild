import { of } from 'rxjs';
import type { HttpService } from '@nestjs/axios';
import type {
  CurrentUserSummary,
  RequirementSummary,
} from '../../shared/api.interface';
import { RequirementAiReviewService } from '../../server/modules/requirements/requirement-ai-review.service';

describe('RequirementAiReviewService model contract', () => {
  const previousKey = process.env.DEEPSEEK_API_KEY;

  afterAll(() => {
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  });

  it('recomputes the weighted score and treats blocker findings as blocking', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    const post = jest.fn().mockReturnValue(
      of({
        data: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: '存在关键缺口',
                  dimensions: [
                    { key: 'background_goal', score: 100, comment: '清楚' },
                    { key: 'scope_constraints', score: 80, comment: '基本清楚' },
                    { key: 'unambiguous', score: 60, comment: '存在歧义' },
                    { key: 'acceptance_testability', score: 40, comment: '不可验证' },
                    { key: 'consistency', score: 100, comment: '一致' },
                  ],
                  findings: [
                    {
                      severity: 'blocker',
                      title: '验收标准不可验证',
                      description: '缺少可观察结果',
                      recommendation: '补充输入、输出和判断条件',
                    },
                  ],
                }),
              },
            },
          ],
        },
      }),
    );
    const service = new RequirementAiReviewService(
      {} as never,
      { post } as unknown as HttpService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const callable = service as unknown as {
      callModel: (
        type: 'clarity',
        source: string,
      ) => Promise<{ score: number; verdict: string }>;
    };

    const result = await callable.callModel('clarity', '测试需求');

    expect(result.score).toBe(73);
    expect(result.verdict).toBe('blocked');
    expect(post).toHaveBeenCalledWith(
      'https://api.deepseek.com/chat/completions',
      expect.objectContaining({ model: 'deepseek-v4-flash' }),
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-key' },
        timeout: 90_000,
      }),
    );
  });

  it('extracts the final JSON object from thinking text and code fences', () => {
    const service = new RequirementAiReviewService(
      {} as never,
      {} as HttpService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const callable = service as unknown as {
      parseModelPayload: (content: string) => { summary?: unknown };
    };

    const result = callable.parseModelPayload(
      '<think>这里是内部分析</think>\n评审结果：\n```json\n{"summary":"可解析"}\n```',
    );

    expect(result.summary).toBe('可解析');
  });

  it('backfills a legacy self-test report and queues every available review', async () => {
    const selfTestArtifact = {
      requirement_id: 'rec_test',
      kind: 'self_test_report',
      source_type: 'inline',
      content: '已验证主流程与异常路径',
      document_url: '',
      document_title: '',
      source_snapshot: '已验证主流程与异常路径',
      source_hash: 'self-test-hash',
      readable: true,
      error_message: '',
      updated_by_name: '周灿宇',
      _updated_at: new Date(),
    };
    const execute = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([selfTestArtifact]);
    const transactionExecute = jest.fn().mockResolvedValue([]);
    const serviceRoleDatabase = {
      run: jest.fn(async (callback: (database: unknown) => Promise<unknown>) =>
        callback({ execute: transactionExecute }),
      ),
    };
    const access = { assertCanUpdate: jest.fn() };
    const service = new RequirementAiReviewService(
      { execute } as never,
      {} as HttpService,
      {} as never,
      access as never,
      {} as never,
      serviceRoleDatabase as never,
    );
    jest
      .spyOn(service as unknown as { dispatchPending: () => void }, 'dispatchPending')
      .mockImplementation(() => undefined);
    const requirement = {
      id: 'rec_test',
      title: '测试需求',
      type: '产品需求',
      introduction: '<p>明确说明背景和目标</p>',
      acceptanceCriteria: '<p>给出可验证结果</p>',
      selfTestReport: '已验证主流程与异常路径',
      defectCause: '',
    } as RequirementSummary;
    const actor = {
      miaodaUserId: 'user_test',
      employeeId: 'employee_test',
      openId: 'ou_test',
      name: '周灿宇',
      roles: ['admin'],
    } as CurrentUserSummary;

    const result = await service.triggerAvailable(requirement, actor);

    expect(result.triggered).toEqual(['clarity', 'delivery_readiness']);
    expect(result.skipped).toEqual([
      { type: 'technical_stability', reason: '请先上传技术方案' },
    ]);
    expect(access.assertCanUpdate).toHaveBeenCalledWith(requirement, {}, actor);
    expect(serviceRoleDatabase.run).toHaveBeenCalledTimes(2);
    expect(transactionExecute).toHaveBeenCalledTimes(5);
  });

  it('skips every AI review for defect requirements', async () => {
    const access = { assertCanUpdate: jest.fn() };
    const serviceRoleDatabase = { run: jest.fn() };
    const service = new RequirementAiReviewService(
      {} as never,
      {} as HttpService,
      {} as never,
      access as never,
      {} as never,
      serviceRoleDatabase as never,
    );
    const requirement = {
      id: 'rec_defect',
      type: '缺陷',
    } as RequirementSummary;
    const actor = {
      miaodaUserId: 'user_test',
      employeeId: 'employee_test',
      openId: 'ou_test',
      name: '周灿宇',
    } as CurrentUserSummary;

    const result = await service.triggerAvailable(requirement, actor);

    expect(result.triggered).toEqual([]);
    expect(result.skipped).toHaveLength(3);
    expect(access.assertCanUpdate).not.toHaveBeenCalled();
    expect(serviceRoleDatabase.run).not.toHaveBeenCalled();
  });
});
