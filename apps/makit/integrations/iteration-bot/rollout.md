# 周催办原生数据迁移

完整源代码来自现网 Mac launchd 服务快照，保留原先定时报告、管理操作、协作通知、开发超时账本及关闭的自动回复。原增量补丁仅作历史参考。

通过 config.storage=makit 与 config.makit 设置原生 HTTPS origin 和独立机器密钥。base.js 的业务契约保留，数据请求全部进入 Makit PostgreSQL；不允许旧飞书表回退。需求写入仅限群与通知元信息。非确定写入结果不自动重试。

Node >=24；npm test 执行全部测试。Linux 使用固定的官方 lark-cli，仅初始化 bot 应用身份，不迁移用户 OAuth 或本机 Keychain。停止旧执行器后再复制最终 runtime.json 和 SQLite 一致性备份；已发送／未知状态必须保留，禁止清账本重试。完整步骤见 docs/selfhost-release-runbook.md。
