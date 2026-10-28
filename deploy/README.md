# 独立部署、备份恢复与升级

本入口部署一个组织的 Platform / Kick、Makit、WeKnow、PostgreSQL 17、Redis 与入口代理。飞书、邮件、GitHub、AI 等集成默认关闭。公开发行仍受仓库许可、可移植性及其他发行门禁限制。

## 构建与初始化

部署机器需要本机 Docker、Compose v2、Python 3.9+。构建访问公共 npm registry；运行时业务网络禁止出网。工具拒绝远程 Docker 上下文及 Docker 环境覆盖。

在仓库根目录运行：

```sh
docker build -f deploy/Dockerfile -t cobuild-suite:local .
python3 deploy/suite.py seal --image cobuild-suite:local --version 0.5.0-local.1 --output release-local.json
python3 deploy/suite.py init /srv/cobuild/team --release release-local.json
python3 deploy/suite.py up /srv/cobuild/team
```

清单锁定镜像 ID、架构、数据库镜像和 schema 契约，并创建 `cobuild-artifact:sha256-…` 保留标签，避免开发 tag 被覆盖后旧版本消失。不要在仍需回退或恢复时删除这些镜像。初始化不覆盖已有目录，并生成部署者自己的密码、加密密钥；没有固定管理员。首次在 CoBuild 的 `/setup` 创建所有者，初始化凭据位于私有文件 `state/platform/bootstrap.private.key`。

| 应用 | 默认入口 |
| --- | --- |
| CoBuild / Kick | http://127.0.0.1:8080 |
| Makit | http://127.0.0.1:8081 |
| WeKnow | http://127.0.0.1:8082 |

初始化时可加 `--ports 8180,8181,8182`；或用 `--config /path/to/config.json` 提供组织、公开 origins、会话天数和模块列表。格式见 `config/cobuild.local.example.json`。未移植模块或外部集成会拒绝启动。启停模块后先 `stop` 再 `up`，原数据保留。

工具从 Docker 网段中选择未占用的私有 /24，不修改其他网络；特殊宿主路由可用 `--subnet` 指定合适的私有 IPv4 /24。

## 运行与持久化

- 一个核心容器监督三个应用进程，任一进程意外退出会停止核心；PostgreSQL 和 Redis 为独立容器。
- 资源带独立部署 ID，归属不符时拒绝操作。仅入口代理连接入口网络与内部网络，应用端口只绑定本机，数据库和 Redis 不暴露宿主端口。
- Makit 使用受限运行角色，WeKnow 使用独立数据库和角色。迁移账号不会交给业务运行进程。
- `state/platform` 保存身份、项目、权限与持久任务；`state/files` 保存附件；`state/secrets.json` 保存私有配置。两个数据库位于专用数据卷。
- 当前显式使用 `up` / `stop` 管理服务，未配置失败后无限重启。启动失败应检查本部署私有日志、版本与 pending 记录。
- 容器内存上限合计约 4 GiB；不是已测最低资源或容量承诺。

```sh
python3 deploy/suite.py status /srv/cobuild/team
python3 deploy/suite.py stop /srv/cobuild/team
python3 deploy/suite.py up /srv/cobuild/team
python3 deploy/suite.py down /srv/cobuild/team
```

`down` 删除本部署容器和网络，保留私有目录与数据卷。工具没有默认删除业务数据的命令。

所有者遗失密码时，部署机器的操作人员可执行 `python3 deploy/suite.py recover-owner /srv/cobuild/team`。它只输出一个私有恢复文件的路径及过期时间；在本机私下打开该文件完成重置。原所有者会话和更早的恢复链接立即失效，恢复链接不输出到终端。

其他成员访问时，应配置三个 HTTPS origins，由部署者的反向代理转发至本机应用端口，保留 Host，支持 WebSocket 和上传大小。浏览器 issuer、精确回调、返回链接保持公开域名；核心内部仅走回环通信。TLS、DNS 和公网浏览器访问需要在目标环境另外验收。

## 完整备份

先创建一个私有备份父目录，再运行：

```sh
python3 deploy/suite.py backup /srv/cobuild/team --output /srv/cobuild/backups/team-20261028
python3 deploy/suite.py verify-backup /srv/cobuild/backups/team-20261028
```

程序暂停本部署全部写入并确认正常退出，再复制平台 SQLite、私有配置、附件、PostgreSQL 和 Redis 冷快照；完成或备份失败后，原本运行的部署恢复运行并等待健康。备份路径必须是部署以外的新目录。

清单记录版本、每个文件的 SHA-256 和大小。校验拒绝缺失、多余、被修改的文件，软链接、危险归档路径及错误 PostgreSQL 主版本。它用于发现损坏，不构成对不可信来源备份的身份认证。

备份包含完整私有凭据，以 0700/0600 保存。应按业务数据与密钥要求离线或加密存储；丢失加密密钥会使原会话无法解密。

## 在新目录恢复

```sh
python3 deploy/suite.py restore /srv/cobuild/restored-team --backup /srv/cobuild/backups/team-20261028
python3 deploy/suite.py up /srv/cobuild/restored-team
```

恢复前核验全部文件、清单、镜像和架构。目标必须不存在，恢复使用新资源并默认停止；先停止旧部署再启动恢复实例，避免端口冲突及重复消费者。

这是 PostgreSQL 物理冷快照，要求相同架构和清单中的数据库镜像，并保留相同公开 origins。跨 PostgreSQL 主版本、跨架构、改域名须另做逻辑迁移和身份/链接处理，不能当作普通恢复。

恢复中断会留下 `restore-failed.json`，禁止启动。源备份不变；检查原因后向另一个新目录恢复，程序不清空旧库、不覆盖半恢复目录。本轮验证同一 Docker 引擎中的新目录恢复；跨机器的镜像 save/load、镜像 ID 兼容与目标主机切换尚未验收，不能仅搬一个可变 tag 便视作恢复成功。

## 升级、回退和中断恢复

```sh
python3 deploy/suite.py upgrade /srv/cobuild/team --release release-next.json
python3 deploy/suite.py rollback /srv/cobuild/team
```

先预检候选并自动完整备份，再停止旧进程，启动候选并检查健康；健康后提交版本记录。任何时刻最多运行一套消费者。schema 相同的应用可以直接切换；schema 不同仅接受下一节声明的 Makit 增量方案。数据库镜像、架构、平台和 WeKnow 结构变更仍不接受。

候选失败会停止候选、恢复旧应用镜像，继续使用当前数据库和文件。升级后新写入保留，不恢复旧快照覆盖它们。备份位于部署同级的 `upgrade-backups`，不会在自动回退中消费。

指纹覆盖平台存储实现与应用迁移文件；清单另外核验原 Makit 迁移驱动。已有文件改写、未知 schema 或数据库镜像 / 架构变化在停服务前拒绝。保留旧二进制只代表结构兼容；开发者仍须评审业务语义兼容，不能据此推断任意版本都能自动回退。

进程中断留下 `pending.json` 时，普通 up 拒绝启动：

```sh
python3 deploy/suite.py recover /srv/cobuild/team
```

recover 重新核对契约、迁移计划与数据库实际历史，停止迁移助手和候选，以当前数据启动上一个兼容应用版本。无法证明历史或兼容性时，保留 pending 和数据，业务消费者保持停止。

## Makit 受控增量迁移

迁移计划只允许三种操作：新建带 `cobuild_` / `makit_` 前缀的表、增加可空且无默认值的字段、创建普通非唯一索引。类型限 text、integer、bigint、boolean、timestamptz、uuid、jsonb。不接受任意 SQL、删改字段、数据回填、唯一约束、平台 SQLite 或 WeKnow 迁移。

每个计划最多 32 个文件、每个文件最多 64 个操作，文件名必须按顺序追加在既有迁移后。每个文件单独在 PostgreSQL 事务内执行，锁等待上限 5 秒、语句上限 60 秒，整轮助手运行上限 180 秒；超时也按实际已提交前缀恢复。应用停止后由独立进程持迁移凭据执行；业务进程不参与。Makit 须先启用并初始化数据库。

示例是演练用新增表，不会自动给产品增加业务功能。后续正式版本应按自身基线选择未使用的文件序号：

```sh
python3 deploy/suite.py migration-sql --plan deploy/examples/makit-additive.plan.json --output .local/migration-sql
```

将生成的原文文件复制进候选镜像的 `apps/makit/migrations/selfhost/`，保留已有迁移和驱动不变。例如从当前已封存的镜像派生，Dockerfile 使用 `COPY --chmod=644 sql/*.sql /suite/apps/makit/migrations/selfhost/`，确保非 root 进程可读。新镜像必须包含本仓库受审的 `deploy/runtime/migrate.mjs`。随后封存精确来源及计划：

```sh
python3 deploy/suite.py seal --image cobuild-suite:next --version 0.5.0-local.2 --base-release release-local.json --migration-plan deploy/examples/makit-additive.plan.json --output release-next.json
python3 deploy/suite.py upgrade /srv/cobuild/team --release release-next.json
python3 deploy/suite.py schema-status /srv/cobuild/team
```

封存与升级均核对源镜像 ID、计划摘要、SQL 内容和完整 schema 清单；不能把同一计划套到另一个基线。生成器拒绝覆盖内容不同的文件。生成文件默认私有，构建时只拷贝这些 SQL，不把部署目录或备份放入构建上下文。同时保留封存时的部署工具版本；更改执行器后，处理旧迁移清单也须重新核对兼容性。

`state/schema-state.json` 分别记录实际迁移进度与允许运行的应用契约：

| 状态 | 行为 |
| --- | --- |
| migrating | 普通启动拒绝，须 recover |
| not_applied | 没有新文件提交，可运行原应用 |
| partial | 前缀已提交，实际 schema 标为未完成；只允许运行经核验的原应用 |
| complete | 全部提交，允许原应用和目标应用；回退不删除新表或新数据 |

发生部分失败时，不编辑数据库历史或已提交 SQL。以原应用发布清单为 `--base-release`，制作新候选：保留已提交前缀的文件名和内容，仅修正未提交后缀，再封存和升级。已提交文件不重复执行；擅自改写前缀会在停服务前拒绝。部分状态及其数据可以完整备份并恢复到新目录。

控制进程在事务内或数据库提交后中断时，pending 保留，recover 以数据库记录重新判定进度。事务中未提交的 DDL 回滚；已提交 DDL 保留。数据库历史出现未知文件、缺失基线、错误摘要或非连续前缀时，恢复拒绝，不开放强制跳过。

回退后的应用不能从旧 schema 另开分支迁移；先切回已完整物化 schema 的应用，再声明下一次迁移。也不提供 down migration。数据库主版本迁移、逻辑导出和跨机器恢复仍须独立方案。

## 本地验证

```sh
npm run test:deployment-unit
npm test
docker build -f deploy/Dockerfile -t cobuild-suite:deployment-candidate .
npm run test:deployment
npm run test:migrations
```

验收另需宿主 Node.js 24，实际部署不需要宿主 Node。迁移演练另外需要保留的本机 `cobuild-suite:recovery-v04-baseline` 镜像，ID 必须等于上一阶段证据中的原始镜像，用于真实旧二进制回退；缺失或不同则失败，普通部署和同 schema 演练不依赖它。测试使用随机端口、临时账号和专用资源，结束后只清理自身容器、网络与数据卷，并核对原有运行容器未重启。基础结果见 `provenance/deployment-checks.json`，本轮结果见 `provenance/migration-checks.json` 和 `docs/VERIFICATION.md`。
