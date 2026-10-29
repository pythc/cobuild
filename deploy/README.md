# 独立部署、备份恢复与升级

本入口部署一个组织的 Platform / Kick、Makit、WeKnow、PostgreSQL 17、Redis 与入口代理。飞书、邮件、GitHub、AI 等集成默认关闭。公开发行仍受仓库许可、可移植性及其他发行门禁限制。

> 当前工作树新增显式核心迁移协议。它只接受下述经审核的精确基线与候选清单，不代表任意旧版本均可升级。受管空间安装后禁止回退到不执行新权限边界的旧二进制。验证范围见 [当前实现记录](../docs/design/collaboration-framework/IMPLEMENTATION-03.md) 和 [原核心迁移记录](../docs/design/collaboration-framework/IMPLEMENTATION-02.md)。

## 构建与初始化

部署机器需要本机 Docker、Compose v2、Python 3.9+。构建访问公共 npm registry；运行时业务网络禁止出网。工具拒绝远程 Docker 上下文及 Docker 环境覆盖。

在仓库根目录运行：

```sh
docker build -f deploy/Dockerfile -t cobuild-suite:local .
python3 deploy/suite.py seal --image cobuild-suite:local --version 0.7.0-core-local --output release-local.json
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

## 部署器管理 HTTPS 入口

也可以让本部署的入口代理加载部署者提供的证书。默认端口仍只绑定 `127.0.0.1`，不会自动开放公网、修改 DNS、申请证书或安装系统信任。配置中的三个核心 origin 必须使用各自的 HTTPS 地址，证书 SAN 须覆盖已启用核心应用的全部主机名。

```sh
python3 deploy/suite.py init /srv/cobuild/team --release release-local.json --config /srv/cobuild/config.json --tls-cert /srv/certs/fullchain.pem --tls-key /srv/certs/private-key.pem --tls-ca /srv/certs/team-ca.pem
python3 deploy/suite.py up /srv/cobuild/team
```

`--tls-cert` 为 PEM 证书链，`--tls-key` 为未加密 PEM 私钥，须是普通文件并以 0600 保存；拒绝软链接。`--tls-ca` 可选：省略时部署器使用其默认信任根，指定时以该 CA 包校验证书链。使用私有 CA 的成员设备需要由部署者另行安排信任；工具不会修改成员设备。

证书和私钥复制到私有 `state/ingress/<generation>`，最后原子提交 `state/ingress.json`。预检在不出网的临时容器中验证有效期、SAN、密钥配对及 TLS 证书链，再核验代理配置。入口只给准确的 Host 转发，并覆盖客户端提供的转发头；健康检查连接本机端口，同时验证公开主机名和证书链。不会使用 `-k` 或关闭证书校验。文件装载和代理头配置参考 [Caddy TLS](https://caddyserver.com/docs/caddyfile/directives/tls) 与 [反向代理文档](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。

证书更新使用新代际，不直接修改已有 PEM 或摘要记录：

```sh
python3 deploy/suite.py stop /srv/cobuild/team
python3 deploy/suite.py tls-configure /srv/cobuild/team --tls-cert /srv/certs/new-fullchain.pem --tls-key /srv/certs/new-private-key.pem --tls-ca /srv/certs/team-ca.pem
python3 deploy/suite.py up /srv/cobuild/team
```

所有本部署写入进程停止后才可更新。新材料验证失败时，原记录保持；进程或文件系统中断后，以最后提交的记录为准，引用的文件不会被错误清理。旧代际保留并纳入备份，须按团队私钥保管策略处理；本工具不自动删除历史私钥，也不自动续期。

已有 TLS 材料而配置记录丢失或不完整时，拒绝回退到明文入口。若升级 pending 期间证书过期，先 `stop`，使用 `tls-configure` 修复证书，再执行 `recover`。证书修复不会清除 pending、授予数据库兼容性或启动业务。

完整备份包含证书、私钥及代际记录；恢复仍保留相同 origins。备份中的证书已经过期时，可在新的目标目录恢复时同时提供新的 `--tls-cert`、`--tls-key` 和可选 `--tls-ca`，源备份不改动。没有新证书且预检失败时，目标保持停止。

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

先预检候选并自动完整备份，再停止旧进程，启动候选并检查健康；健康后提交版本记录。任何时刻最多运行一套消费者。schema 相同的应用可以直接切换；schema 不同仅接受已声明的 Makit 增量方案或本文的核心迁移方案。数据库镜像、架构及未审核结构变更仍不接受。

候选失败会停止候选，仅在历史和权限语义均兼容时恢复旧应用镜像，继续使用当前数据库和文件。核心权限迁移一旦有步骤提交，则保持停止，须向前恢复。升级后新写入保留，不恢复旧快照覆盖它们。备份位于部署同级的 `upgrade-backups`，不会在自动回退中消费。

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
python3 deploy/suite.py seal --image cobuild-suite:next --version 0.6.0-local.2 --base-release release-local.json --migration-plan deploy/examples/makit-additive.plan.json --output release-next.json
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

## 平台与 WeKnow 受管空间迁移

`deploy/migrations/core-managed-v1.json` 是特定旧镜像到本批候选的审核清单，不是通用 SQL 执行入口。它固定平台存储代码、操作库 SQL、迁移驱动及 WeKnow 新增迁移的前后摘要。源镜像不符、已存在的 WeKnow 迁移被改写、额外 schema 文件变化均拒绝。模块须已启用 Kick 和 WeKnow，并完成过初始化。

```sh
docker build -f deploy/Dockerfile -t cobuild-suite:managed-migration-candidate .
python3 deploy/suite.py seal --image cobuild-suite:managed-migration-candidate --version 0.7.0-core-local --base-release release-base.json --migration-plan deploy/migrations/core-managed-v1.json --output release-core.json
python3 deploy/suite.py upgrade /srv/cobuild/team --release release-core.json
python3 deploy/suite.py schema-status /srv/cobuild/team
```

平台 SQLite 与 WeKnow PostgreSQL 不共享事务，不能宣传为跨库原子升级。执行顺序为平台操作库、WeKnow 受管空间表；每个步骤的 DDL 与本库历史同事务提交，再由控制器核对真实历史。平台的旧业务表、空间映射、原生 ACL、文档和附件不回填、不删除。升级助手停止业务写入后运行；SQLite 检查连接只读，但目录允许创建 WAL 共享内存辅助文件。

| 状态 | 本方案允许运行的版本 |
| --- | --- |
| not_applied | 原版本 |
| partial | 不启动业务；保留 pending、数据和备份 |
| complete | 仅目标 schema；旧版本会绕过权限约束，因此禁止回退 |

提交后启动失败或控制器中断时，修复环境原因后执行：

```sh
python3 deploy/suite.py resume-upgrade /srv/cobuild/team
```

此命令只接受 pending 中的**原精确候选**，重新核验镜像、计划及已提交历史，补做未提交步骤；已完成步骤不重复建表，健康后提交版本记录。不要编辑 pending、删迁移历史或手工启动旧镜像。`recover` 在已提交核心步骤时也会保持停止，不自动恢复旧快照。更换成另一个修复镜像的向前迁移入口尚未实现；候选自身有代码缺陷时，须另行制作和审核恢复方案。

控制器被强杀时，候选进程可能仍在运行，pending 并不代表进程已全部停止。`recover` / `resume-upgrade` 都会先停止本部署写进程，再检查实际历史；不要手工并行启动另一套消费者。

已完成升级的完整备份恢复同时保留迁移状态与权限边界。恢复旧备份属于独立的数据恢复操作，有备份之后数据丢失的成本，不能称为无损回退。

核心迁移演练使用 `npm run test:core-upgrade`。需要保留原始 0.6 镜像 `cobuild-suite:deployment-candidate`（证据中 ID 以 `b70666e7` 开头），并将本批候选构建为 `cobuild-suite:managed-migration-candidate`；不要用新构建覆盖基线 tag。脚本使用独立部署、端口和数据，结束后核对其他容器 ID 与启动时间未变。普通新部署不依赖这份测试基线。

## 本地验证

```sh
npm run test:deployment-unit
npm test
docker build -f deploy/Dockerfile -t cobuild-suite:deployment-candidate .
npm run test:deployment
npm run test:migrations
npm run test:https
```

验收另需宿主 Node.js 24，实际部署不需要宿主 Node。迁移演练另外需要保留的本机 `cobuild-suite:recovery-v04-baseline` 镜像，ID 必须等于上一阶段证据中的原始镜像，用于真实旧二进制回退；缺失或不同则失败，普通部署和同 schema 演练不依赖它。测试使用随机端口、临时账号和专用资源，结束后只清理自身容器、网络与数据卷，并核对原有运行容器未重启。基础结果见 `provenance/deployment-checks.json`，本轮结果见 `provenance/migration-checks.json` 和 `docs/VERIFICATION.md`。

HTTPS 演练另需宿主 OpenSSL（只生成临时测试 CA）及 WeKnow 开发依赖中的 Undici。`--https --with-migrations` 将原完整生命周期跑在三个测试 HTTPS 域名下。加 `--with-browser` 并设置 `COBUILD_PLAYWRIGHT_MODULE` 到已安装 Playwright 的入口，可验证独立 Chromium 中的实际 Cookie 和回调；可用 `COBUILD_CHROMIUM_EXECUTABLE` 指定已有 Chrome，工具不自动下载浏览器。`--https --tls-lifecycle-only --with-browser` 针对证书 / 会话及证书恢复复测，不包含原完整升级 / 迁移演练；`--core-only` 用于默认 HTTP 的核心回归。

测试只在独立进程中把 `.cobuild.test` 域名解析到回环地址，并指定临时 CA；不修改 hosts、DNS、系统信任或个人浏览器。Chromium 正向测试使用精确测试证书的 SPKI 固定，负向浏览器不使用该固定；证书链另由完整 CA 校验客户端验证。此证据不等同于公网 DNS、公有 CA 或目标设备验收。HTTPS 结果见 `provenance/https-checks.json`。


## 同结构修复候选与项目联动版本

`0.8.0-dev.0` 的 `core-runtime-v1` 只允许审核清单中的两份平台 store 实现变化；原 SQLite / WeKnow 迁移、执行器和实际表结构保持不变。需要精确的上批基线镜像，不能把未审核的旧部署视作同一基线。

```sh
python3 deploy/suite.py seal --image cobuild-suite:managed-migration-candidate --version 0.7.0-baseline --output release-managed-base.json
python3 deploy/suite.py seal --image cobuild-suite:lifecycle-candidate --version 0.8.0-local --base-release release-managed-base.json --migration-plan deploy/migrations/core-runtime-v1.json --output release-lifecycle.json
python3 deploy/suite.py upgrade /srv/cobuild/team --release release-lifecycle.json
```

若已有核心迁移 pending，修复镜像必须保留 pending 的完整 schema 清单、迁移计划和执行器，只修应用运行时代码。按同一基线和同一计划封装修复 manifest，再执行：

```sh
python3 deploy/suite.py resume-upgrade /srv/cobuild/team --release release-fixed.json
```

预检后原子登记候选替换记录，异常停止本部署，保留数据和 pending。再次中断可不带 `--release` 继续。成功后 `last-recovery.json` 保存本次候选链；该文件位于部署目录，运维审计需要另行留存，冷备份自动保存的是业务 state 和当前发行版本。此入口不能修订已提交 SQL、扩大迁移范围、替换基础镜像或修改持有 schema 的源码。

隔离验证：`npm run test:runtime-repair`。它创建实际启动失败的派生镜像，验证替换为修复候选、再次中断继续、数据保留、重启及冷备份恢复；只清理测试自己创建的部署和数据卷，保留不可变镜像证据，不清理其他工程镜像。

`0.9.0-dev.0` 另加 `core-project-state-v1.json`，使用同一种受限运行时迁移，只允许精确 0.8 基线到归档重试候选的两份 store 摘要变化；不修改前面的 0.7 → 0.8 计划。封装该版本时将 `--base-release` 指向经核实的 0.8 发行清单、`--migration-plan` 指向新计划。对应的本地顺序演练如下（不要与其他容器测试并行）：

```sh
COBUILD_REPAIR_BASE=cobuild-suite:lifecycle-candidate \
COBUILD_REPAIR_CANDIDATE=cobuild-suite:project-state-candidate \
COBUILD_REPAIR_PLAN=core-project-state-v1.json \
npm run test:runtime-repair
```
