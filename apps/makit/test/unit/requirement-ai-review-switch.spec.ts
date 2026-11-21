import { RequirementAiReviewService } from "../../server/modules/requirements/requirement-ai-review.service";
import type { RequirementSummary } from "@shared/api.interface";
type Internals = {
  recoveryTimer: unknown;
  processPending(): Promise<void>;
  processOne(id: string): Promise<boolean>;
  enqueueOnDatabase(db: unknown, material: unknown): Promise<void>;
  dispatchPending(): void;
  callModel(type: string, source: string): Promise<unknown>;
};
function harness() {
  const requirement = {
    id: "rec_fixture",
    type: "产品需求",
    introduction: "",
    acceptanceCriteria: "",
    selfTestReport: "",
  } as RequirementSummary;
  const read = jest.fn().mockResolvedValue([]),
    write = jest.fn().mockResolvedValue([]),
    post = jest.fn();
  const query = {
    currentUser: jest.fn().mockResolvedValue({ name: "Fixture" }),
    requirementById: jest.fn().mockResolvedValue(requirement),
  };
  const access = {
    assertCanUpdate: jest.fn(),
    canUpdate: () => true,
    canCollaborate: () => false,
  };
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
  };
  const run = jest.fn(async (f: (db: unknown) => Promise<unknown>) =>
    f({ execute: write, select: () => chain }),
  );
  const service = new RequirementAiReviewService(
    { execute: read } as never,
    { post } as never,
    query as never,
    access as never,
    {} as never,
    { run } as never,
  );
  return {
    service,
    worker: service as unknown as Internals,
    read,
    write,
    post,
    run,
    access,
    requirement,
  };
}
describe("independent AI review switch", () => {
  const previous = process.env.MAKIT_AI_REVIEW_ENABLED,
    workers = process.env.MAKIT_WORKERS_ENABLED;
  beforeEach(() => {
    process.env.MAKIT_AI_REVIEW_ENABLED = "false";
    process.env.MAKIT_WORKERS_ENABLED = "true";
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (previous === undefined) delete process.env.MAKIT_AI_REVIEW_ENABLED;
    else process.env.MAKIT_AI_REVIEW_ENABLED = previous;
    if (workers === undefined) delete process.env.MAKIT_WORKERS_ENABLED;
    else process.env.MAKIT_WORKERS_ENABLED = workers;
  });
  it("does not start a timer or claim work while other workers remain enabled", async () => {
    const h = harness();
    h.service.onModuleInit();
    h.worker.dispatchPending();
    await h.worker.processPending();
    expect(h.worker.recoveryTimer).toBeNull();
    expect(await h.worker.processOne("fixture")).toBe(false);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
    expect(process.env.MAKIT_WORKERS_ENABLED).toBe("true");
  });
  it("does not queue from creation, edits or saved artifacts", async () => {
    const h = harness();
    await h.service.onRequirementCreated(h.requirement, {} as never);
    await h.service.onRequirementUpdated(
      h.requirement,
      h.requirement,
      {} as never,
    );
    await h.worker.enqueueOnDatabase({ execute: h.write }, {});
    expect(h.run).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });
  it("authorizes retries before reporting disabled", async () => {
    const h = harness();
    await expect(
      h.service.retry("rec_fixture", "clarity", {}),
    ).rejects.toMatchObject({ status: 503, message: "AI 评审已停用" });
    expect(h.access.assertCanUpdate).toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
  });
  it("retains permission checks for manual and batch triggers", async () => {
    const h = harness();
    h.access.assertCanUpdate.mockImplementation(() => {
      throw Error("forbidden");
    });
    await expect(h.service.retry("rec_fixture", "clarity", {})).rejects.toThrow(
      "forbidden",
    );
    await expect(
      h.service.triggerAvailable(h.requirement, {} as never),
    ).rejects.toThrow("forbidden");
    expect(h.write).not.toHaveBeenCalled();
  });
  it("explicitly skips all three batch reviews", async () => {
    const h = harness();
    const r = await h.service.triggerAvailable(h.requirement, {} as never);
    expect(r.triggered).toEqual([]);
    expect(r.skipped).toHaveLength(3);
    expect(r.skipped.every((x) => x.reason === "AI 评审已停用")).toBe(true);
    expect(h.run).not.toHaveBeenCalled();
  });
  it("skips AI gates for valid transitions and still rejects invalid edges", async () => {
    const h = harness();
    const req = {
      ...h.requirement,
      status: "新",
      workflow: {
        transitions: [{ from: "新", to: "需求已评审", reviews: ["clarity"] }],
      },
    } as RequirementSummary;
    await expect(
      h.service.assertTransitionReady(req, "需求已评审"),
    ).resolves.toBeUndefined();
    await expect(
      h.service.assertTransitionReady(req, "已发布"),
    ).rejects.toThrow("当前迭代未允许");
    expect(h.run).not.toHaveBeenCalled();
  });
  it("keeps required artifact validation", async () => {
    const h = harness();
    await expect(
      h.service.assertArtifactReady(h.requirement, "technical_design"),
    ).rejects.toThrow("请先上传技术方案");
  });
  it("refuses the final model boundary without reaching HTTP", async () => {
    const h = harness();
    await expect(
      h.worker.callModel("clarity", "fixture"),
    ).rejects.toMatchObject({ status: 503 });
    expect(h.post).not.toHaveBeenCalled();
  });
  it("keeps history readable without rewriting it", async () => {
    const h = harness();
    const r = await h.service.workspace("rec_fixture", {});
    expect(r.history).toEqual([]);
    expect(r.canUpdate).toBe(true);
    expect(h.run).not.toHaveBeenCalled();
  });
  it("saves a document without enqueuing AI", async () => {
    const h = harness();
    await h.service.saveArtifact(
      "rec_fixture",
      "technical_design",
      {
        sourceType: "inline",
        content:
          "实现方案：用统一身份验证请求，说明接口、数据流、错误恢复及验收路径。",
      },
      {},
    );
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.post).not.toHaveBeenCalled();
  });
  it.each([undefined, "true"])(
    "retains the original gate when enabled or unset (%s)",
    async (value) => {
      if (value === undefined) delete process.env.MAKIT_AI_REVIEW_ENABLED;
      else process.env.MAKIT_AI_REVIEW_ENABLED = value;
      const h = harness();
      const chain = {
        from: jest.fn(),
        where: jest.fn(),
        orderBy: jest.fn(),
        limit: jest.fn(),
      };
      Object.values(chain).forEach((f) => f.mockReturnValue(chain));
      h.run.mockImplementation(async (f) =>
        f({ select: () => chain, execute: h.write }),
      );
      await expect(
        h.service.assertTransitionReady(
          {
            ...h.requirement,
            status: "新",
            introduction: "说明目标和范围",
            acceptanceCriteria: "检查输出结果",
          },
          "需求已评审",
        ),
      ).rejects.toThrow("请先完成");
      expect(h.run).toHaveBeenCalled();
    },
  );
});
