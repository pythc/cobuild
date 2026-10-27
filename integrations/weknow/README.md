# WeKnow 派生组件

`source/` 是从已发布本地合并基线整理的 Docmost 派生源码，来源 revision 和逐文件哈希见根目录 `provenance/`。

保留独立 pnpm 工作区与 AGPL 许可。根锁文件、Nx 配置及 scimmy 补丁来自相同依赖清单的上游本地基线，导入时校验了四份依赖清单一致。排除的企业依赖不再列入 package。

这里不是未经修改的上游，也没有把我们新增的协作、搜索和认证改动宣称为上游功能。后续更新应以明确的上游 tag / commit 和派生变更记录合并；避免只复制线上 dist 而丢失对应源码。

企业许可边界、尚待审查项目与发行条件见 `docs/LICENSING.md`。构建与独立安装结果见 `docs/VERIFICATION.md`。
