# 独立部署、备份恢复与升级

本入口部署一个组织的 Platform / Kick、Makit、WeKnow、PostgreSQL 17、Redis 与入口代理。飞书、邮件、GitHub、AI 等集成默认关闭。公开发行仍受仓库许可、可移植性及其他发行门禁限制。

## 构建与初始化

部署机器需要本机 Docker、Compose v2、Python 3.9+。构建访问公共 npm registry；运行时业务网络禁止出网。工具拒绝远程 Docker 上下文及 Docker 环境覆盖。

在仓库根目录运行：

```sh
docker build -f deploy/Dockerfile -t cobuild-suite:local .
python3 deploy/suite.py seal --image cobuild-suite:local --version 0.4.0-local.1 --output release-local.json
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

当前自动化范围是 schema 契约、数据库镜像完全一致的应用版本。先预检候选并自动完整备份，再停止旧进程，启动候选并检查健康；健康后提交版本记录。任何时刻最多运行一套消费者。

候选失败会停止候选、恢复旧应用镜像，继续使用当前数据库和文件。升级后新写入保留，不恢复旧快照覆盖它们。备份位于部署同级的 `upgrade-backups`，不会在自动回退中消费。

指纹覆盖平台存储实现与应用迁移文件，未知 schema、数据库镜像或架构变化会在停服务前拒绝升级。当前未宣称任意跨版本数据库迁移可自动回退；此类版本需要单独评审迁移、兼容区间和恢复演练。

进程中断留下 `pending.json` 时，普通 up 拒绝启动：

```sh
python3 deploy/suite.py recover /srv/cobuild/team
```

recover 重新核对契约，停止候选，以当前数据启动上一个应用版本。旧版本自身无法恢复时，保留 pending 和数据，供后续处理。

## 本地验证

```sh
npm run test:deployment-unit
npm test
docker build -f deploy/Dockerfile -t cobuild-suite:deployment-candidate .
npm run test:deployment
```

验收另需宿主 Node.js 24，实际部署不需要宿主 Node。测试使用随机端口、临时账号和专用资源，结束后只清理自身容器、网络与数据卷，并核对原有运行容器未重启。结果见 `provenance/deployment-checks.json` 和 `docs/VERIFICATION.md`。
