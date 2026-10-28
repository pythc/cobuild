# CoBuild

面向实验室和小型研发团队的自部署协作套件。以项目为主线，连接项目发起、需求推进与知识沉淀。

**当前阶段：受控前向迁移（0.5.0-dev.0）。尚未达到公开发行条件。** 不依赖飞书的登录、成员邀请、账号恢复、所有权转让和目录同步已接入。Kick → Makit → WeKnow 完整协作，以及 Linux 容器中的初始化、备份恢复、同 schema 升级与故障回退已有验证。本轮补充 Makit 的增量 schema 迁移、部分失败恢复与前向修复；具体结果见 [验证记录](docs/VERIFICATION.md)。正式 HTTPS、跨机器恢复、平台与 WeKnow 的结构迁移、外部交付集成和既有数据迁移仍待验收。

## 产品范围

| 层级 | 内容 |
| --- | --- |
| 默认核心 | CoBuild 工作台、组织与权限、统一身份、Kick、Makit、WeKnow |
| 可选业务 | HiFlow、Evalab、Relay、荣誉、动态发布 |
| 配套能力 | 邮箱、飞书、GitHub、AI、Pulse 运维 |
| 本仓库不包含的产品 | 110lab 桌面插件、CoBuild 品牌首页、需求监控／催办工程、智评学堂／批改系统 |

## 当前目录

```text
apps/platform/             门户与内部模块，暂保留一个服务的现有边界
apps/makit/                需求与研发协作
apps/evalab/               考核源码，可选
apps/relay/                咨询与反馈源码，可选
integrations/weknow/       Docmost 派生源码及许可边界
packages/config/           通用目标配置与模块依赖校验
packages/service/          核心服务之间的签名请求协议
config/                    无凭据的配置示例
deploy/                    容器构建、部署管理、备份恢复、升级与回退
docs/                      产品、架构、改造顺序与验证记录
provenance/                来源、基线文件哈希、修改记录与只含定位信息的扫描报告
tools/                     配置、导入、检查与发行门禁
```

HiFlow、邮箱、荣誉等目前仍在 `apps/platform` 中。`suite.json` 描述产品模块和数据归属，不意味着已拆成独立进程。WeKnow 保留为有独立许可和上游版本的派生组件。

## 检查本次整理成果

使用 Node.js 24、npm 和 Python 3；不需要连接生产服务。

```sh
npm test
npm run config:check
npm run plan
npm run verify
npm run release:check
```

根目录工具没有第三方运行依赖。`release:check` 当前应以退出码 2 报告未完成事项，避免误发未验收套件。它不会部署、发送消息或修改外部服务。

`config/cobuild.example.json` 是完整目标契约，`config/cobuild.local.example.json` 是本机核心配置示例。当前运行器支持本地邀请账号；不支持的模块和外部集成会在启动前明确拒绝。OIDC 仍待实现。

本地预览和完整核心链路测试见 [本地运行说明](docs/LOCAL-RUNTIME.md)。`npm run local:init` / `npm run local:platform` 提供持久的工作台与 Kick 预览；`npm run test:local-suite` 使用三套真实服务及临时数据库完成隔离验证并自动清理。

容器部署步骤见 [独立部署、备份恢复与升级](deploy/README.md)。实际部署只需本机 Docker / Compose 与 Python；`npm run test:deployment` 则使用专属资源演练完整生命周期，测试工具另需 Node.js 24。

账号恢复、所有权转让及 Kick → Makit → WeKnow 的操作步骤也在该说明中。当前本地模式的需求写入与操作历史正常执行；未配置的 AI 评审、邮件和飞书通知明确显示未启用，不会伪装成发送成功。

## 开发单个应用

各工程暂时保留自己的依赖锁文件，不把 npm 与 pnpm 锁文件强行合并。先阅读 [验证记录](docs/VERIFICATION.md)，其中区分独立安装、构建、回归与尚未覆盖的完整流程。

门户构建不再生成桌面插件发行包或实验室公开首页。Makit 默认构建自托管版本，已去除顶层妙搭自动初始化和 Git hook 安装脚本。WeKnow 已排除企业许可目录及其 base-formula 包；其派生版权与依赖仍需完整审查。

## 继续开发与发行

1. [产品边界与架构](docs/ARCHITECTURE.md)
2. [改造顺序和验收条件](docs/ROADMAP.md)
3. [许可与来源](docs/LICENSING.md)
4. [发行阻塞](release-blockers.json)
5. [部署与升级](deploy/README.md)
6. [本次自行 review](docs/REVIEW.md)

现有生产服务、原始目录及其 Git 历史均不由本工作区修改。当前本地基线不是“所有服务最新线上源码”的证明；Evalab 与 Relay 尤其需要在发布前与维护基线再次核对。
