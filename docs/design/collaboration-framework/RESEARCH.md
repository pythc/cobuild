# 项目参考研究与采用决策

日期：2026-10-28。用途：支撑 [CoBuild 改造方案](README.md)，不是依赖安装清单。

本次读取了当前源码、运行说明和官方项目文档。未部署这些竞品、未做用户访谈，也未逐一试用其所有版本。下列“事实”限于引用文档；“采用”是针对 CoBuild 的设计判断。功能可用版本、开源 / 企业版边界和许可证在实际复用前必须再核对。没有以热度或 GitHub 星数代替适用性判断。

## 1. Backstage：扩展接口和产品壳层

**官方观察**：Backstage 区分 Core、部署实例 App 和 Plugins。插件可贡献页面与功能，搜索通过接口整合来源；权限由插件声明资源与操作，后端执行策略结果。[架构](https://backstage.io/docs/overview/architecture-overview/)、[权限](https://backstage.io/docs/permissions/overview/)、[搜索架构](https://backstage.io/docs/features/search/architecture/)。

**采用**：应用清单、能力注册、资源引用、来源搜索、权限检查和契约测试。新增应用通过注册接入，不在平台核心持续新增按应用名分支。

**不照搬**：软件资产目录不是 CoBuild 的全部产品主线；用户核心对象仍是项目、工作项和知识。第一版不采用运行时任意前端插件装载，不整体迁移到 Backstage，也不继承其任何默认宽松权限配置。

**验证方式**：一个独立检查结果扩展能接入项目卡片、搜索和待办，不修改核心实现；失败时其他模块仍可使用。

## 2. Plane：项目内的连续协作

**官方观察**：项目组织工作项、周期、模块、页面等资源，具有成员、可见性与归档等生命周期。[项目管理](https://docs.plane.so/core-concepts/projects/overview)、[Modules](https://docs.plane.so/core-concepts/modules)。

**采用**：项目上下文贯穿页面；全局“我的工作”与项目内工作清晰分层；传统列表、筛选和保存视图作为日常入口。

**不照搬**：不用功能导航数量衡量完整性，不为贴齐 Plane 增加 AI 聊天、复杂数据库页面或所有业务概念。Plane 当前文档导航包含多个版本 / 计划能力，不能据此断言全部属于社区版。

**验证方式**：从需求到文档再返回，筛选和项目上下文不丢失；归档不造成资源失联或重复创建。

## 3. OpenProject：类型、依赖与明确工作流

**官方观察**：工作包有类型、稳定身份、负责人和状态；支持层级和关系。工作流定义角色针对类型可执行的状态转换。[工作包](https://www.openproject.org/docs/user-guide/work-packages/)、[关系与层级](https://www.openproject.org/docs/user-guide/work-packages/work-package-relations-hierarchies/)、[管理工作包](https://www.openproject.org/docs/system-admin-guide/manage-work-packages/)、[工作流词汇定义](https://www.openproject.org/docs/glossary/)。

**采用**：工作项共享基础结构，需求 / 缺陷保留语义；状态变化有业务权限和前置条件。依赖、阻塞和验收有明确数据，模板版本可追溯。

**不照搬**：不引入财务、工时、考勤、复杂资源排程和全部项目管理配置。优先几个可理解的模板和状态流，而不是管理几十种类型的配置后台。

**验证方式**：业务角色无权跳过验收；自定义状态仍能映射统一分析阶段；模板升级不悄悄改变已在进行的项目。

## 4. GitLab：交付是有证据的对象

**官方观察**：Release 聚合版本、产物、文档与发布说明；Release evidence 提供相关数据的快照，其具体采集能力存在版本 / 计划差异。[Releases](https://docs.gitlab.com/user/project/releases/)、[Release evidence](https://docs.gitlab.com/user/project/releases/release_evidence/)。

**采用**：Makit 显式保存 Delivery 与证据引用，记录固定提交、构建 / 测试、环境和验收。交付结果与迭代进度分离。

**不照搬**：不自建代码托管和 CI 执行集群，不把 GitLab 的企业功能实现复制进套件。第一版以读取证据和人工确认部署为主。

**验证方式**：新提交、失败构建、旧环境部署不会被旧的绿灯覆盖；人工记录与系统核验明确区分。

## 5. Forgejo 与 GitHub：提供方差异必须显式适配

**官方观察**：Forgejo 为仓库事件提供 Webhook，并有不同消息通道适配。GitHub 建议验证 secret、使用 HTTPS、及时响应并异步处理；原事件重投会保持相同 delivery ID。[Forgejo Webhooks](https://forgejo.org/docs/latest/user/repository/webhooks/)、[GitHub Webhook 实践](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)。

**采用**：统一代码连接器能力表，保留提供方原始 ID、交付 ID和事件类型；先验签并持久接收，再处理。重复事件、漏事件和乱序由存储与核对作业处理。

**不照搬**：不承诺 GitHub / GitLab / Forgejo API 完全相同。第一版只接受 GitHub 真实适配；后续提供方通过独立契约验收后开放。

**验证方式**：重复投递不产生重复通知；漏事件可恢复；自托管服务器地址不能让普通用户绕过连接器网络范围。

## 6. Docmost：空间和内容权限有独立语义

**官方观察**：空间组织文档和成员，支持个人 / 组授权及不同访问角色；组可以授予空间访问，多个授权路径可能叠加。空间可导出内容及附件。[空间](https://docmost.com/docs/user-guide/spaces)、[成员组](https://docmost.com/docs/user-guide/groups)。

**采用**：保留 WeKnow 为内容权威，使用受管项目空间和关联既有空间两种机制；同步时标记授权来源，撤销项目授权不误删其他独立授权，但受管项目资格仍是硬性前提。

**不照搬**：不以组织内 Everyone 的默认行为代替项目私有规则，不把读写权限放在聚合入口而遗漏原生页面和附件。

**许可边界**：本地 WeKnow 来源为 Docmost v0.96.0 派生，现有 [许可记录](../../LICENSING.md) 和保留的 LICENSE 是基线。当前官方主线也保留 [AGPL LICENSE](https://github.com/docmost/docmost/blob/main/LICENSE)，但不能由此推断全部企业目录可复用。版本化页面本次抓取失败，v0.96.0 的具体事实以已审查的本地来源记录为准；正式发行仍需完成文件级审查。

## 7. Keycloak / OIDC：身份连接与业务角色分离

**官方观察**：Keycloak 支持身份代理、账号关联及身份提供方管理。OIDC 使用发行方和 subject 等声明标识身份。[Keycloak 管理指南](https://www.keycloak.org/docs/latest/server_admin/)、[OIDC Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)。

**采用**：CoBuild 的 OIDC 客户端连接部署者自己的 IdP；本地账号仍可独立工作。身份与外部目录分开，账号关联需要本人确认；身份组映射经过明确配置，不直接变为业务管理员。

**不照搬**：不把 Keycloak 设为首装必需服务，不重新开发通用身份服务器，不认为一次 OIDC 登录能自动解决持续目录同步和所有设备退出。

**验证方式**：同邮箱不同 issuer 不误合并；离职 / 停用时现有会话受控失效；IdP 故障时保留管理员恢复路径。

## 8. Temporal：长期流程的状态与副作用

**官方观察**：Temporal 将流程、活动、执行历史与任务分开，支持故障后继续执行，活动具有超时和重试机制。[Workflows](https://docs.temporal.io/workflows)、[Tasks](https://docs.temporal.io/tasks)。

**采用**：跨应用操作具有持久步骤、业务幂等键、租约、超时、执行记录和人工恢复入口。外发超时不能直接视为“没发出去”。

**不照搬**：本轮不用 Temporal 集群替换现有任务系统，也不声称简单状态机拥有 Temporal 的确定性重放能力。工作流规模和运维能力不足以支撑额外基础设施时，使用有界流程更合适。

**验证方式**：进程在远端成功、本地未记回执时崩溃，恢复后先查证，不盲目重复副作用。

## 9. CloudEvents：事件信封稳定，传输可替换

**标准观察**：CloudEvents v1.0.2 规定事件信封，`source + id` 用于区分事件，核心字段包括 `id`、`source`、`type` 和 `specversion`。[规范](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md)。

**采用**：固定信封与可版本化 payload；区分业务事件、命令、审计、通知。HTTP + 数据库 outbox 可以先落地，未来替换传输不改变业务身份。

**不照搬**：CloudEvents 不提供传输可靠性、顺序、身份或授权；这些仍需 CoBuild 自己实现和验收。

## 10. OpenTelemetry：一次操作跨应用定位

**官方观察**：上下文传播关联跨服务执行，trace / span 与其他观测信号可连接。[Context propagation](https://opentelemetry.io/docs/concepts/context-propagation/)。

**采用**：操作 ID、关联 ID 和 trace ID 贯穿前台、后台任务和连接器；管理员可从失败卡片定位到步骤及服务。

**不照搬**：默认不强制部署完整监控平台。先结构化本地日志及健康接口，可选导出；trace context 不带凭据、不作为授权。

## 11. 可用性与效率参考

用 [WCAG 2.2](https://www.w3.org/TR/WCAG22/) 定义可测的键盘、焦点、对比度和表单要求；这是目标，不是现有认证结论。

[Linear Insights](https://linear.app/docs/insights) 使用周期、提前期和等待等维度分析流程。CoBuild 借鉴“从图表进入原始事项”的方向，复用现有 Makit 阶段耗时模型，不据此引入个人绩效排名，也不把 Linear 作为开源组件。

## 12. 综合取舍

| 决策 | 理由 | 代价 / 触发重评条件 |
| --- | --- | --- |
| 保留三业务边界，平台逐步模块化 | 已有可用代码与数据权威明确 | 需维护适配；只有运维 / 性能证据明确才拆更多服务 |
| 项目为主导航，应用为次导航 | 用户围绕工作连续操作 | 跨应用上下文、搜索权限需要额外工程 |
| 联邦搜索先行 | 避免先复制正文和 ACL | 排名与响应受来源影响；实际瓶颈出现后评估索引 |
| 数据库 outbox + 有界流程 | 已有持久回执基础，部署成本较低 | 多进程租约、恢复和测试不能省略；规模扩大后重评引擎 |
| 声明式 UI 贡献，外部后端隔离 | 降低扩展拖垮核心或获取会话的风险 | 第一版扩展 UI 自由度有限 |
| 本地账号 + 可选 OIDC | 无外部服务也能安装，企业可接既有 IdP | 目录同步与本地 MFA 必须独立计划 |
| GitHub 首个连接器 | 能复用现有源码，缩短验收链路 | 其他提供方不能仅靠改 base URL 宣称支持 |
| 核心小而完整，业务排除项不做 | 控制维护和体验复杂度 | 个性化业务通过后续扩展，而非提前实现 |

所有参考材料仅提供设计依据。代码引入、依赖许可、版本固定和安全审查会在各实施阶段单独进行。
