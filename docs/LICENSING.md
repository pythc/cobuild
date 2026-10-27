# 许可与发行边界

当前是私有整理工作区，没有为整个仓库声明统一的公开发行许可。`package.json` 的 `private: true` 用于避免误发 npm 包，不是安全隔离或代码许可证。

## WeKnow

上游是 Docmost v0.96.0。该版本 README 将核心许可列为 AGPL-3.0，并单独列出企业目录。上游完整 AGPL 文本保留在 `integrations/weknow/source/LICENSE` 和 `LICENSES/AGPL-3.0.txt`。

- 上游：https://github.com/docmost/docmost/tree/v0.96.0
- 许可边界：https://github.com/docmost/docmost/blob/v0.96.0/README.md#license
- 本地派生基线：`quality-20261025-v1`，提交见 `provenance/components.json`。
- 已发现并排除：`apps/client/src/ee`、`packages/base-formula`。
- 持续禁止导入：`apps/server/src/ee`、`packages/ee` 及其他带企业许可的组件。
- 已移除不存在的 base-formula 工作区依赖与类型映射。仅改变开关或不调用函数不能使企业源码变成可公开再许可的代码。
- 普通搜索入口原有两个企业 AI 组件的直接导入已移除；保留普通文档/附件搜索和过滤，未复制企业实现，也未宣称提供替代的 AI 搜索能力。

发行前还须核对核心外部的动态 require、图标/字体/图片、Office 相关组件、历史改动和依赖授权。不存在企业目录不等于完整许可审查已经通过。不能把 Docmost 派生代码统一改为 MIT 或 Apache 并去掉上游声明。

## 原创工程与第三方组件

门户、Makit、Evalab 和 Relay 的现有根 package 未给出足够的发行许可依据。需要确认原创权属、外部贡献、模板来源、托管平台 SDK、UI 组件、字体与第三方素材。

原创部分可考虑采用与既有派生组件兼容的开源策略；本阶段不代替完整文件级审查，也不根据“仓库是私有的/我们的工程”推断全部文件归属。各组件最终许可及第三方声明应在公开前逐项落地。

## 排除的数据和凭据

导入仅来自明确的源码目录。不导入 `.env`、私有 QA 用户材料、数据库、简历、上传附件、密钥、会话、构建产物或已发布二进制。目录中的业务类与模板代码需要继续通用化；永久保存生产资料的既有业务规则不会自动成为新部署的默认保留策略。

当前扫描仅覆盖有限密钥格式、私有文件及环境依赖，不是完整安全审计。脱敏测试中的合成标记保留，按完整文件哈希核准；文件内容变化后自动重新作为待检查项。
