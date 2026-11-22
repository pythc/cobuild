# CoBuild

面向实验室和小型研发团队的自部署协作套件。以项目为主线，连接项目发起、需求推进与知识沉淀。

**当前套件版本为 `1.0.1`，仍处于开发预览阶段。** Makit 支持自动识别并排版 Markdown，需求池可按当前用户参与的角色筛选。

当前完成度与待办见 [实施状态](docs/design/collaboration-framework/STATUS.md)，本批验证范围见 [实施记录 10](docs/design/collaboration-framework/IMPLEMENTATION-10.md)，整体目标见 [改造方案](docs/design/collaboration-framework/README.md)。公开发行条件见 [发行门禁](release-blockers.json)。[GitHub 开发仓库](https://github.com/pythc/cobuild)

## 产品范围

| 层级 | 内容 |
| --- | --- |
| 默认核心 | CoBuild 工作台、组织与权限、统一身份、Kick、Makit、WeKnow |
| 仅保留历史源码 | HiFlow、Evalab、Relay、荣誉、动态发布；不接受运行配置启用 |
| 可选只读来源 | GitHub 公共仓库，无凭据、手动读取；已验证宿主本地运行，默认关闭 |
| 后续连接器 | OIDC、飞书、私有代码仓库、通知渠道、管理员运维；当前默认关闭 |
| 本仓库不包含的产品 | 110lab 桌面插件、CoBuild 品牌首页、需求监控／催办工程、智评学堂／批改系统 |

## 当前目录

```text
apps/platform/             门户与内部模块，暂保留一个服务的现有边界
apps/makit/                需求与研发协作
apps/evalab/               考核历史源码，不进入当前发行范围
apps/relay/                咨询与反馈历史源码，待专用连接器适配
integrations/weknow/       Docmost 派生源码及许可边界
packages/config/           通用目标配置与模块依赖校验
packages/service/          核心服务之间的签名请求协议
packages/contracts/        资源与内置模块能力契约
packages/code-sources/     公共代码状态的只读 provider
packages/operations/       同业务库事务的操作与事件回执
config/                    无凭据的配置示例
deploy/                    容器构建、部署管理、备份恢复、升级与回退
docs/                      产品、架构、改造顺序与验证记录
provenance/                来源、基线文件哈希、修改记录与只含定位信息的扫描报告
tools/                     配置、导入、检查与发行门禁
```

HiFlow、邮箱、荣誉等目前仍在 `apps/platform` 中。`suite.json.modules` 描述可启用核心，`retainedModules` 记录留存源码，不意味着已拆成独立进程或完全裁剪构建依赖。WeKnow 保留为有独立许可和上游版本的派生组件。

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

账号恢复、组织所有权转让及 Kick → Makit → WeKnow 的操作步骤也在该说明中。当前本地模式的需求写入与操作历史正常执行；未配置的 AI 评审、邮件和飞书通知明确显示未启用，不会伪装成发送成功。

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
