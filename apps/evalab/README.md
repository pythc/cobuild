# 110 实验室考核系统

独立的候选人考核与运营评审系统。Vue 3 + Naive UI 前端，Express 5 + PostgreSQL 后端，官方 MCP SDK 提供远程接口与本地上下文桥。

## 核心流程

邮箱验证注册 → 选择轮次内的批次及方向 → 阅读并确认材料边界 → MCP 连接测试 → 确认开始考核（批次可设为 24／48 小时） → 预览并锁定仓库提交 → 让 Agent 通过文件路径直接上传项目对话文件（合计最高 1 GB，可断点续传） → 候选人确认交卷 → 运营评审并发布结果。

计时以数据库时钟为准。每轮限一个报名，开考后固定题目快照、方向与开始时间。仓库与材料必须绑定同一 commit SHA；两者到齐不等于已交卷，必须在期限内确认交卷。过期未交卷保留已有材料，不自动生成成功状态。

## 本地启动

需要 Node.js 20+ 与 Docker。

```sh
npm ci
docker compose -p lab110-assessment -f compose.local.yml up -d
```

按 `server/.env.example` 准备环境变量：数据库指向本机 5548；SMTP 使用 Mailpit 5383；APP_ORIGIN 与 PUBLIC_BASE_URL 设为 `http://127.0.0.1:5380`，PORT=5380。管理员邮箱、密码、SESSION_SECRET 使用独立值。

```sh
npm run build
node runtime.mjs
```

测试邮件在 `http://127.0.0.1:5382` 查看。生产拒绝 MAIL_TEST_SINK 与示例数据。不要将私密环境文件放入仓库。

## 验证

```sh
TEST_DATABASE_URL=postgresql://assessment_local:local_assessment_only@127.0.0.1:5548/assessment_local npm test -w server
npm test -w context-bridge
REVIEW_DATABASE_URL=postgresql://assessment_local:local_assessment_only@127.0.0.1:5548/assessment_local node --import tsx --test tests/review-regressions.test.ts
```

数据库测试创建自己的临时 schema 并清理。端到端验收使用运行中的 API、Mailpit、真实 GitHub 查询及官方 MCP 客户端；它会创建明确标记的本地验收账号与批次。仅在本地测试环境运行：

```sh
TEST_ADMIN_EMAIL=... TEST_ADMIN_PASSWORD=... node tests/acceptance.mjs
```

## 运维与边界

- 部署与恢复见 [OPERATIONS.md](docs/OPERATIONS.md)。
- API 与业务约定见 [CONTRACT.md](docs/CONTRACT.md)。
- 统一远程入口、可选本地桥和对话格式见 [MCP.md](docs/MCP.md)。
- 仅支持公开 GitHub / Gitee 仓库；不要求候选人向平台提交仓库密码或个人访问令牌。运营可配置专用 GITHUB_TOKEN 提高 GitHub API 限额。
- Agent 工具和模型由候选人自行选择、付费。客户端信息及上下文覆盖度是声明材料，不是独立取证结论。
- 学籍是候选人声明，不代表系统已连接学校身份认证。
- 评审由运营人工完成；系统不会运行候选人仓库代码，也不会自动决定录取结果。
