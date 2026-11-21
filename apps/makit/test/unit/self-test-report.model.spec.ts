import {
  resolveSelfTestReport,
  selfTestReportReadiness,
  type SelfTestReportArtifact,
} from "../../server/modules/requirements/self-test-report.model";
import { materialTemplate } from "@shared/material-templates";
const report = "验证了正常提交、非法输入、权限撤销和网络重试，结果符合预期。";
const requirement = (legacy = "") => ({
  id: "rec_fixture",
  selfTestReport: legacy,
  updatedAt: "2026-11-21T00:00:00Z",
});
const artifact = (
  patch: Partial<SelfTestReportArtifact> = {},
): SelfTestReportArtifact => ({
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
describe("authoritative self-test report", () => {
  it.each([
    ["saved report, empty legacy", "", [artifact()], true],
    ["saved overrides legacy", "old", [artifact()], true],
    ["legacy only", report, [], true],
    ["missing", "", [], false],
    ["empty rich text", "<p><br></p>", [], false],
    [
      "empty explicit report hides legacy",
      report,
      [artifact({ content: "" })],
      false,
    ],
    [
      "inline visible content wins snapshot",
      "",
      [artifact({ source_snapshot: "" })],
      true,
    ],
    [
      "readable linked report",
      "",
      [artifact({ source_type: "feishu_doc", content: "" })],
      true,
    ],
    ["unreadable hides legacy", report, [artifact({ readable: false })], false],
    [
      "empty linked hides legacy",
      report,
      [artifact({ source_type: "feishu_doc", source_snapshot: "" })],
      false,
    ],
    [
      "empty template",
      "",
      [artifact({ content: materialTemplate("self_test_report") })],
      false,
    ],
    ["old empty template", materialTemplate("self_test_report"), [], false],
    [
      "other requirement",
      "",
      [artifact({ requirement_id: "rec_other" })],
      false,
    ],
    [
      "wrong artifact kind",
      "",
      [artifact({ kind: "technical_design" })],
      false,
    ],
  ] as const)("%s", (name, legacy, rows, want) => {
    const req = requirement(legacy),
      before = JSON.stringify({ req, rows });
    expect(
      selfTestReportReadiness(resolveSelfTestReport(req, rows)).passed,
    ).toBe(want);
    expect(JSON.stringify({ req, rows })).toBe(before);
  });
  it("accepts a pending legacy patch only without an authoritative artifact", () => {
    expect(resolveSelfTestReport(requirement("old"), [], report)?.content).toBe(
      report,
    );
    expect(resolveSelfTestReport(requirement(report), [], "")).toBeUndefined();
    const row = artifact();
    expect(resolveSelfTestReport(requirement("old"), [row], "")).toBe(row);
  });
});
