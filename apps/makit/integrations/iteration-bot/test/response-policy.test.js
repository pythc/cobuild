import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFormalGroupClosing,
  decorateRequirementResponse,
  enforceResponsePolicy
} from "../src/response-policy.js";

const config = {
  baseToken: "base_token",
  baseUrl: "https://example.test/base/base_token?block=dashboard",
  requirementPlatformUrl: "https://requirements.example.test/app",
  tables: { requirements: "tbl_req" }
};

const requirements = [{
  recordId: "rec_1",
  title: "生产环境部署流水线搭建",
  handlers: [{ id: "ou_handler", name: "Khan" }],
  developers: [{ id: "ou_dev", name: "研发同学" }],
  testers: [{ id: "ou_test", name: "测试同学" }],
  productOwners: [{ id: "ou_product", name: "产品同学" }]
}];

test("自由需求清单自动补充直达链接和当前处理人 mention", () => {
  const result = decorateRequirementResponse(
    "- 生产环境部署流水线搭建 | 需求待评审 | 处理人：Khan",
    "把迭代需求列出来，跟踪到对应处理人",
    requirements,
    config
  );
  assert.match(result, /\[生产环境部署流水线搭建\]\(https:\/\/requirements\.example\.test\/app\/requirements\/rec_1\)/);
  assert.match(result, /<at user_id="ou_handler">Khan<\/at>/);
});

test("提测要求同时 mention 当前处理人和测试人员", () => {
  const result = decorateRequirementResponse(
    "- 生产环境部署流水线搭建：缺少提测时间",
    "列出未填写提测时间的需求并提醒对应人员",
    requirements,
    config
  );
  assert.match(result, /<at user_id="ou_handler">Khan<\/at>/);
  assert.match(result, /<at user_id="ou_test">测试同学<\/at>/);
});

test("已有普通 Markdown 链接会替换为需求直达链接而不是形成嵌套链接", () => {
  const result = decorateRequirementResponse(
    "- [生产环境部署流水线搭建](https://old.example/item) · 需求待评审",
    "列出需求",
    requirements,
    config
  );
  assert.match(result, /^- \[生产环境部署流水线搭建\]\(https:\/\/requirements\.example\.test\/app\/requirements\/rec_1\)/);
  assert.doesNotMatch(result, /\[\[生产环境部署流水线搭建\]/);
});

test("群内跟踪通知追加正式收尾且不重复", () => {
  const first = appendFormalGroupClosing("两项需求需要跟进。", "跟踪到对应处理人", "group");
  assert.match(first, /> 请相关人员尽快推进，并及时更新状态和进展。$/);
  assert.equal(
    appendFormalGroupClosing(first, "跟踪到对应处理人", "group"),
    first
  );
});

test("完整策略同时补链接、人员和正式收尾", () => {
  const result = enforceResponsePolicy(
    "- 生产环境部署流水线搭建",
    "催办开发进度",
    requirements,
    config,
    "group"
  );
  assert.match(result, /\/requirements\/rec_1/);
  assert.match(result, /ou_handler/);
  assert.match(result, /ou_dev/);
  assert.match(result, /请相关人员尽快推进/);
});

test("旧多维表格链接会在发出前统一改写为需求平台深链", () => {
  const result = enforceResponsePolicy(
    "[查看需求](https://fcncvoyreb8p.feishu.cn/base/token?table=tbl_req&record=rec_1)",
    "查看需求",
    [],
    config,
    "p2p"
  );
  assert.equal(
    result,
    "[查看需求](https://requirements.example.test/app/requirements/rec_1)"
  );
});
