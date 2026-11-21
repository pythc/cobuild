import { RequirementReleaseReadinessService } from "../../server/modules/requirements/requirement-release-readiness.service";
import { RequirementAiReviewService } from "../../server/modules/requirements/requirement-ai-review.service";
import { materialTemplate } from "@shared/material-templates";
import type { RequirementSummary } from "@shared/api.interface";
const report = "已验证创建、权限撤销、失败重试及跨应用读取，结果符合预期。";
const req = (legacy = "") =>
  ({
    id: "rec_fixture",
    type: "产品需求",
    status: "产品体验中",
    selfTestReport: legacy,
    updatedAt: "2026-11-21T00:00:00Z",
    introduction: "",
    acceptanceCriteria: "",
    gitBranchName: "",
    githubPullRequestUrl: "",
    testers: [],
    releaseOwners: [],
    workflow: {
      transitions: [
        {
          from: "产品体验中",
          to: "待发布",
          releaseChecks: ["self_test_report"],
        },
      ],
    },
  }) as unknown as RequirementSummary;
const artifact = (patch: Record<string, unknown> = {}) => ({
  requirement_id: "rec_fixture",
  kind: "self_test_report",
  source_type: "inline",
  content: report,
  source_snapshot: report,
  source_hash: "fixture-hash",
  document_url: "",
  document_title: "",
  readable: true,
  error_message: "",
  updated_by_name: "Fixture",
  _updated_at: "2026-11-21T00:00:00Z",
  ...patch,
});
const gate = (read: jest.Mock) =>
  new RequirementReleaseReadinessService(
    { execute: read } as never,
    {
      searchRecords: () => {
        throw Error("Unexpected external read");
      },
    } as never,
    {} as never,
    {} as never,
  );
describe("shared page and release report source", () => {
  it.each([
    ["saved report, empty old field", "", [artifact()], true],
    ["old only", report, [], true],
    ["missing", "", [], false],
    [
      "explicit empty overrides old",
      report,
      [artifact({ content: "" })],
      false,
    ],
    [
      "linked unreadable overrides old",
      report,
      [artifact({ source_type: "feishu_doc", readable: false })],
      false,
    ],
    [
      "linked readable snapshot",
      "",
      [artifact({ source_type: "feishu_doc", content: "" })],
      true,
    ],
    [
      "empty linked report",
      report,
      [
        artifact({
          source_type: "feishu_doc",
          content: "",
          source_snapshot: "",
        }),
      ],
      false,
    ],
    [
      "template",
      "",
      [artifact({ content: materialTemplate("self_test_report") })],
      false,
    ],
  ] as const)("%s", async (name, legacy, rows, want) => {
    const read = jest.fn().mockResolvedValue(rows),
      before = JSON.stringify(rows);
    const result = await gate(read).evaluate(req(legacy), "待发布");
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].passed).toBe(want);
    expect(result.ready).toBe(want);
    expect(read).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(rows)).toBe(before);
  });
  it("skips artifact reads when this release check is not selected", async () => {
    const r = req();
    r.workflow!.transitions[0].releaseChecks = [];
    const read = jest.fn(() => {
      throw Error("Unexpected read");
    });
    expect((await gate(read).evaluate(r, "待发布")).checks).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
  it("does not mask a database failure with the legacy field", async () => {
    await expect(
      gate(jest.fn().mockRejectedValue(Error("database unavailable"))).evaluate(
        req(report),
        "待发布",
      ),
    ).rejects.toThrow("database unavailable");
  });
  it("sees a saved report edit on the next check", async () => {
    const read = jest
      .fn()
      .mockResolvedValueOnce([artifact()])
      .mockResolvedValueOnce([artifact({ content: "" })]);
    const service = gate(read);
    expect((await service.evaluate(req(), "待发布")).ready).toBe(true);
    expect((await service.evaluate(req(), "待发布")).ready).toBe(false);
  });
  it("keeps release owner checks independently enforced", async () => {
    const r = req();
    r.workflow!.transitions[0].releaseChecks.push("release_owners");
    const result = await gate(
      jest.fn().mockResolvedValue([artifact()]),
    ).evaluate(r, "待发布");
    expect(result.ready).toBe(false);
    expect(
      result.checks.find((x) => x.key === "self_test_report")?.passed,
    ).toBe(true);
    expect(result.checks.find((x) => x.key === "release_owners")?.passed).toBe(
      false,
    );
  });
  it("does not disable the report check when AI is disabled", async () => {
    const old = process.env.MAKIT_AI_REVIEW_ENABLED;
    process.env.MAKIT_AI_REVIEW_ENABLED = "false";
    try {
      expect(
        (await gate(jest.fn().mockResolvedValue([])).evaluate(req(), "待发布"))
          .ready,
      ).toBe(false);
    } finally {
      if (old === undefined) delete process.env.MAKIT_AI_REVIEW_ENABLED;
      else process.env.MAKIT_AI_REVIEW_ENABLED = old;
    }
  });
  it.each([false, true])(
    "shows the same new or old report without writing (%s)",
    async (legacy) => {
      const r = req(report),
        read = jest
          .fn()
          .mockResolvedValueOnce(legacy ? [] : [artifact()])
          .mockResolvedValueOnce([]),
        run = jest.fn(),
        post = jest.fn();
      const service = new RequirementAiReviewService(
        { execute: read } as never,
        { post } as never,
        {
          currentUser: async () => ({ name: "Fixture" }),
          requirementById: async () => r,
        } as never,
        { canUpdate: () => true, canCollaborate: () => false } as never,
        {} as never,
        { run } as never,
      );
      const page = await service.workspace(r.id, {});
      expect(page.artifacts.self_test_report?.content).toBe(report);
      expect(run).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(read).toHaveBeenCalledTimes(2);
    },
  );
  it("retains visibility authorization before reading any artifact", async () => {
    const read = jest.fn();
    const service = new RequirementAiReviewService(
      { execute: read } as never,
      {} as never,
      {
        currentUser: async () => ({}),
        requirementById: async () => {
          throw Error("forbidden");
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(service.workspace("rec_fixture", {})).rejects.toThrow(
      "forbidden",
    );
    expect(read).not.toHaveBeenCalled();
  });
});
