import test from "node:test";
import assert from "node:assert/strict";
import {
  iterationRecordUrl,
  requirementRecordUrl,
  rewriteLegacyNotificationLinks
} from "../src/requirement-links.js";

const config = {
  requirementPlatformUrl: "https://requirements.example.test/app/",
  tables: {
    requirements: "tbl_req",
    iterations: "tbl_iteration"
  }
};

test("需求与迭代链接精准落到平台对应位置", () => {
  assert.equal(
    requirementRecordUrl(config, "rec test/1"),
    "https://requirements.example.test/app/requirements/rec%20test%2F1"
  );
  assert.equal(
    iterationRecordUrl(config, "rec_iteration"),
    "https://requirements.example.test/app/iterations?iteration=rec_iteration"
  );
});

test("历史 Base 和旧驾驶舱链接不会从通知出口泄漏", () => {
  const rewritten = rewriteLegacyNotificationLinks(
    [
      "[需求](https://fcncvoyreb8p.feishu.cn/base/token?table=tbl_req&record=rec_req)",
      "[迭代](https://fcncvoyreb8p.aiforce.cloud/app/app_17b569zueu9)"
    ].join("\n"),
    config
  );
  assert.match(rewritten, /\/requirements\/rec_req/);
  assert.match(rewritten, /\/iterations/);
  assert.doesNotMatch(rewritten, /feishu\.cn\/base|aiforce\.cloud/);
});
