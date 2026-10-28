import type { Sql } from "postgres";
import type { WorkspaceField } from "../../database/workspace-record.types";
import {
  NORMAL_STATUS_ORDER,
  DEFECT_STATUS_ORDER,
  DEFECT_BRANCH_STATUSES,
} from "../../modules/requirements/requirements.model";
import { TICKET_STATUSES } from "../../../shared/ticket-workflow";

// Historical transport variable names remain private compatibility details. In
// native mode they refer exclusively to local PostgreSQL collections.
const definitions: Record<string, WorkspaceField[]> = {};
function fields(
  kind: string,
  groups: Array<[string, string[]]>,
  options: Record<string, string[]> = {},
) {
  definitions[kind] = groups.flatMap(([type, names]) =>
    names.map((name) => ({
      id: `suite:${kind}:${name}`,
      name,
      type,
      options: (options[name] || []).map((value) => ({ name: value })),
    })),
  );
}
const timestamps: [string, string[]][] = [
  ["1001", ["创建时间"]],
  ["1002", ["更新时间"]],
];
fields(
  "requirements",
  [
    [
      "1",
      [
        "需求",
        "需求介绍",
        "验收标准",
        "自测报告",
        "缺陷原因",
        "Git 分支名称",
        "最新进展",
        "阻塞原因",
        "最近操作人名称",
        "平台操作标识",
      ],
    ],
    ["3", ["状态", "优先级", "项目", "需求类型", "需求来源"]],
    ["4", ["需求标签"]],
    [
      "11",
      [
        "当前处理人",
        "产品人员",
        "研发人员",
        "测试人员",
        "FO",
        "提出人",
        "关注人",
        "发布负责人",
        "最近操作人",
      ],
    ],
    ["21", ["所属迭代"]],
    ["15", ["GitHub 合并请求链接"]],
    ["7", ["是否阻塞"]],
    ["2", ["工作量"]],
    [
      "5",
      [
        "实际开始时间",
        "实际提测时间",
        "实际发布时间",
        "截止时间",
        "最近操作时间",
      ],
    ],
    ["1005", ["需求编号"]],
    ["1004", ["最后修改人"]],
    ...timestamps,
  ],
  {
    状态: [
      ...new Set([
        ...NORMAL_STATUS_ORDER,
        ...DEFECT_STATUS_ORDER,
        ...DEFECT_BRANCH_STATUSES,
        ...TICKET_STATUSES,
      ]),
    ],
    优先级: ["P0", "P1", "P2", "P3"],
    需求类型: ["产品需求", "技术需求", "缺陷", "工单"],
    需求来源: ["内部协作", "用户反馈", "产品规划"],
    需求标签: ["体验", "性能", "稳定性"],
  },
);
definitions.requirements.find((field) => field.name === "需求编号")!.property =
  {
    auto_serial: {
      type: "custom",
      options: [
        { type: "fixed_text", value: "REQ-" },
        { type: "system_number", value: "6" },
      ],
    },
  };
fields(
  "iterations",
  [
    ["1", ["迭代名称", "迭代目标"]],
    ["3", ["状态"]],
    ["11", ["负责人"]],
    ["21", ["需求"]],
    [
      "5",
      [
        "开始时间",
        "结束时间",
        "需求评审时间",
        "开发启动时间",
        "提测时间",
        "发布时间",
      ],
    ],
    ...timestamps,
  ],
  { 状态: ["规划中", "进行中", "已完成"] },
);
fields("comments", [
  ["1", ["评论内容", "评论人名称"]],
  ["11", ["评论人"]],
  ["21", ["需求"]],
  ["7", ["是否已编辑"]],
  ...timestamps,
]);
fields("acceptance", [
  ["1", ["验收项", "备注"]],
  ["11", ["负责人"]],
  ["21", ["需求"]],
  ["7", ["是否完成"]],
  ...timestamps,
]);
fields("relations", [
  ["1", ["关系说明", "关系类型", "创建人名称"]],
  ["11", ["创建人"]],
  ["21", ["源需求", "目标需求"]],
  ...timestamps,
]);
fields("collaboration", [
  [
    "1",
    ["事件类型", "状态", "负载摘要", "触发来源", "事件键", "变更前", "变更后"],
  ],
  ["21", ["需求"]],
  ...timestamps,
]);
fields("bindings", [
  ["1", ["绑定键", "状态"]],
  ["21", ["需求"]],
  ...timestamps,
]);
fields("operations", [
  ["1", ["操作类型", "操作内容", "操作人名称"]],
  ["11", ["操作人"]],
  ["21", ["需求"]],
  ...timestamps,
]);
export const suiteCollections = Object.entries(definitions).map(
  ([kind, fields]) => ({
    kind,
    id: `suite-${kind}`,
    env: `FEISHU_${kind.toUpperCase()}_TABLE`,
    fields,
  }),
);

export function configureSuiteCollections() {
  if (process.env.COBUILD_IDENTITY_MODE !== "local") return;
  for (const item of suiteCollections) {
    if (process.env[item.env] && process.env[item.env] !== item.id)
      throw new Error(
        "Native collections cannot reuse external table bindings",
      );
    process.env[item.env] = item.id;
  }
}

/** Bootstrap only empty native databases; never replace existing data/schema. */
export async function initializeSuiteCollections(sql: Sql) {
  if (process.env.COBUILD_IDENTITY_MODE !== "local") return;
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(11020261028)`;
    const rows = await tx<
      { id: string; kind: string; fields: WorkspaceField[] }[]
    >`SELECT id, kind, fields FROM makit_collection`;
    if (rows.length) {
      if (rows.length !== suiteCollections.length)
        throw new Error("Native collection set requires an explicit migration");
      for (const expected of suiteCollections) {
        const row = rows.find(
          (item) => item.id === expected.id && item.kind === expected.kind,
        );
        if (
          !row ||
          !expected.fields.every((field) =>
            row.fields.some(
              (old) =>
                old.id === field.id &&
                old.name === field.name &&
                old.type === field.type,
            ),
          )
        )
          throw new Error(
            "Existing collection schema is incompatible with native mode",
          );
      }
      return;
    }
    for (const item of suiteCollections)
      await tx`INSERT INTO makit_collection(id, kind, fields) VALUES(${item.id}, ${item.kind}, ${tx.json(item.fields as never)})`;
  });
}
