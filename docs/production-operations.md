# 生产化运行手册

这份手册把服务启动、健康探针、存储备份和故障恢复整理成一条可以交给值班同学执行的路径。它适用于 `standalone-sim2real.service`；Studio 集成部署使用同样的检查顺序，只替换 unit 和存储路径。

systemd 的 `EnvironmentFile=` 在运行时会覆盖同名的 `Environment=`。因此不要把
`--env-file` 指向另一份“看起来相同”的文件：它必须就是 unit 引用的 root-only 文件；unit
对 CSP、代理信任、限流、租约、只读模式、DSH 目录和固定路径保留 `ExecStartPre` 复核，复核失败时服务不会启动。

## 发布前配置门禁

生产服务必须使用独立的 root-only EnvironmentFile。仓库里的 [`sim2real.production.env.example`](../services/sim2real-web/sim2real.production.env.example) 只是一份安全模板，里面的 trusted-proxy secret 为空，不可直接启用。

先检查模板和 systemd unit 是否仍然保持安全默认值：

```bash
npm run verify:production-config
```

在目标主机上，把实际 EnvironmentFile 与 unit 的 `Environment=` 覆盖一起检查。脚本不会打印 token、secret 或密码；`--strict` 会把 HSTS、无限期遥测等运营提醒升级为发布阻断：

```bash
node scripts/verify-production-config.mjs \
  --env-file /etc/rdk-robot-learning-platform-sim2real.env \
  --unit-file /etc/systemd/system/standalone-sim2real.service \
  --strict
```

写实例应保持 `RDK_SIM2REAL_STORAGE_READ_ONLY=0`。只读副本显式传 `--role reader`，并设置为 `1`；它不会获取 writer lease，也不会响应写请求。生产写实例还必须满足：`web-cloud`、SSO、`trusted-proxy` 或 `studio-cookie`、至少 32 字节代理 secret、回环监听、绝对持久卷路径、限流、CSP 和 writer lease 开启。

Studio 集成 unit 还要求 `/etc/sim2real-web-runner.env` 存在（root:root、`chmod 600`），其中至少放置
32 字节随机的 `RDK_SIM2REAL_TELEMETRY_ATTESTATION_SECRET`；若启用 DSH，再在同一个受控环境边界中配置
`DEEPSEEK_API_KEY`，并显式设置 `RDK_SIM2REAL_DSH_RUNTIME=1`。示例：

```bash
if sudo test -e /etc/sim2real-web-runner.env; then
  sudo chmod 600 /etc/sim2real-web-runner.env
else
  sudo install -o root -g root -m 0600 /dev/null /etc/sim2real-web-runner.env
fi
sudoedit /etc/sim2real-web-runner.env
```

## 一键部署（生产服务器）

`scripts/deploy-sim2real-production.sh` 把发布固化为不可跳过的机器步骤：
构建 → 组包（dist-server 剔除 engines 与 `engines.*.tmp` 残留 + 全新
`npm ci --omit=dev`）→ 上传 → 服务端解压并从当前 release 拷贝 engines
（Linux venv 只存在于服务端，绝不能被本地构建覆盖）→ **按 systemd
ExecStart 逐一预检新 release 的入口文件**（该预检可直接拦截"漏
mock-local-worker.mjs"这类事故）→ 切 `current` 软链 → 重启
`sim2real-web` 与 `sim2real-mock-worker` → 健康检查，失败自动回滚到
上一 release。

```bash
scripts/deploy-sim2real-production.sh                # 完整部署 HEAD
scripts/deploy-sim2real-production.sh --skip-build   # 复用已有构建
```

目标主机可用 `DEPLOY_HOST` 覆盖。回滚：把
`/opt/sim2real-web/current` 软链切回上一
`releases/robot-learning-*` 并重启两个服务（脚本失败时已自动执行）。

## 认证配置（studio-cookie 嫁接 · web-cloud 部署）

`/sim2real` 挂在 `rdkstudio.d-robotics.cc` 同域路径下，认证**嫁接 Studio 的
登录后端**：工作台解密 Studio 主壳签发的全域 cookie `rdk_sso_web_session`
（共享 `RDK_STUDIO_COOKIE_SECRET`），用户在 Studio 登录一次即全站认证，
工作台不维护自己的登录页。

必需配置（root-only env，缺任意一项则认证退回 standalone、全站 401）：

```bash
RDK_STUDIO_COOKIE_SECRET=<与 Studio 主壳一致的 cookie 密钥>
# 可省略：存在该密钥时认证模式自动判定为 studio-cookie。
# 显式指定亦可：RDK_SIM2REAL_AUTH_MODE=studio-cookie
```

行为语义（判断部署是否正常）：

- **已登录 Studio 的用户**访问 `/sim2real`：无感登录，不应出现登录横幅
  或跳转。若仍被 401/跳登录页，先核对两处 env 的
  `RDK_STUDIO_COOKIE_SECRET` 是否逐字符一致，再确认请求确实带上了
  `rdk_sso_web_session` cookie（同域是前提，跨域子域不共享）。
- **未登录用户**点登录跳 `/rdkstudio/`（Studio 主壳登录页）是**正确的
  嫁接行为**——登录页本来就是 Studio 的，登录后回到 `/sim2real` 即
  自动认证。
- 独立于 Studio 的直连登录走 `RDK_SIM2REAL_AUTH_MODE=user-center`
  （OAuth2 + JWKS，见 `docs/decisions/D-006-user-center-direct-auth.md`）；
  两种模式互斥，凭据不齐时 fail-closed 回退，绝不半配置生效。

验证：

```bash
curl -s https://rdkstudio.d-robotics.cc/sim2real/api/healthz | grep authMode
# 期望 "authMode":"studio-cookie"；"standalone" 说明 cookie 密钥未加载。
```

## 部署后探针

服务启动后，用独立 Node 进程检查 `/healthz`、`/readyz` 和 `/metrics`：

```bash
node scripts/probe-sim2real.mjs \
  --url https://rdkstudio.d-robotics.cc/sim2real \
  --timeout-ms 3000 --retries 2
```

探针要求：

- `/healthz` 返回 200，且响应包含 `service=sim2real-web`、`schemaVersion`、`ready` 和 `storage`；
- `/readyz` 返回 200 且 `ready=true`。维护窗口内如果只想确认进程仍活着，可临时使用 `--allow-degraded`，但这不会把服务标记为可接收生产流量；
- `/metrics` 返回 Prometheus 文本，包含请求计数和进程 uptime，且输出中没有 `Authorization`、`Cookie`、token 或 secret 字段。

`/healthz` 是存活检查，进程可响应就返回 200；`/readyz` 是流量门禁，台账损坏、存储不可写、必需的 MicroDuck 未挂载或共享认证适配器缺失时返回 503。网关应把 `/readyz` 作为 upstream 的 readiness，而不要用 `/healthz` 代替。

## 存储备份

文件型台账由 `sim2real.json` 和 `telemetry/*.jsonl` 组成；`sim2real.json` 的 `artifacts`、`evaluations` 数组与 ledger 一起按字节校验。审计中间件另写 `audit.ndjson`（轮转段为 `audit.ndjson.1`），这两段也会被纳入快照。备份工具会校验 ledger 结构、逐行校验遥测和审计 JSON、写入 SHA-256 manifest，并且不复制 `writer-lease.json`（租约是进程状态，恢复旧租约会错误阻塞新实例）。默认发现活跃 writer 后停止，避免得到半份证据：

```bash
systemctl stop standalone-sim2real.service
node scripts/sim2real-storage-backup.mjs backup \
  --storage-dir /var/lib/rdk-robot-learning-platform/sim2real \
  --output /var/backups/rdk-sim2real/$(date -u +%Y%m%dT%H%M%SZ)
node scripts/sim2real-storage-backup.mjs verify \
  --snapshot /var/backups/rdk-sim2real/20260913T030000Z
systemctl start standalone-sim2real.service
node scripts/probe-sim2real.mjs --url http://127.0.0.1:18102
```

如果 `RDK_SIM2REAL_AUDIT_FILE` 把审计流放在台账目录之外，备份和恢复时必须显式传同一个绝对路径；工具会把它在快照中规范为 `audit.ndjson`/`audit.ndjson.1`，不会把主机路径写进 manifest：

standalone/studio-integrated systemd unit 已为文档中的独立审计卷开放
`/var/log/rdk-sim2real`；启用前先创建目录并授予运行账号写权限（不要把审计文件放到
其它未挂载的绝对路径，否则 `ProtectSystem=strict` 会让 `/readyz` 进入
`audit-unavailable`）：

```bash
sudo install -d -o sim2real -g sim2real -m 0700 /var/log/rdk-sim2real
```

DSH 是显式启用的可选运行时。只有在 root-only EnvironmentFile 中设置
`RDK_SIM2REAL_DSH_RUNTIME=1` 并配置 `DEEPSEEK_API_KEY`（或组织自己的 DSH
credential store）后，才需要启用会话持久化；standalone unit 将它固定在
`/var/lib/sim2real/dsh` 并只开放这个目录。首次启用前一并创建：

```bash
sudo install -d -o sim2real -g sim2real -m 0700 /var/lib/sim2real/dsh
```

Studio 集成 unit 则把 `RDK_SIM2REAL_DSH_HOME` 固定到其已有可写数据根下的
`/opt/sim2real-web/data/dsh`；由于审计与 ledger 的隐私边界，数据根本身也应由 root
专用并保持 0700：

```bash
sudo install -d -o root -g root -m 0700 /opt/sim2real-web/data
sudo install -d -o root -g root -m 0700 /opt/sim2real-web/data/dsh
```

不要把 DSH 目录改到 release tree 或其它未列入
`ReadWritePaths` 的位置；否则会在第一次会话落盘时失败。DSH 会话是独立 JSONL 数据，需按组织的
数据保留策略单独备份，不应把它混入 Sim2Real ledger 快照。

`studio-integrated-sim2real.service` 和 RDK 板端 agent 的参考 unit 仍使用 root，原因是旧 Studio
主机的 SSO cookie 目录和 ROS/设备节点可能由 root 拥有；它们只适合作为经过运维审阅的兼容样例，
不应直接暴露在公网。优先使用 `standalone-sim2real.service` 的专用 `sim2real` 用户；若必须启用
root unit，应保留 `ProtectSystem=strict`、`NoNewPrivileges=true`、固定 `ReadWritePaths`，并把
BoardAgent/telemetry 端口限制在回环或受控网关，令牌放在 root-only EnvironmentFile。

X5 agent 的代码部署目录是 `/opt/rdk-board-agent`，策略文件则固定在
`/root/rdk-board-agent/policies`，两者刻意分离：代码更新不会改变模型信任边界。首次部署前先运行
`scripts/install-x5-board-agent.sh`，它会显式安装 reviewed systemd unit、环境文件骨架以及
`rdk-board-agent.service` 所需的 root-only 目录；然后运行 update-only 的
`scripts/deploy-x5-board-agent.sh` 传代码。初始化脚本默认不会覆盖已有 unit 或启动服务；需要替换
unit 时必须人工审阅后加 `--force`，启用服务也必须单独执行 `systemctl enable --now`。确认
`ReadWritePaths` 保留策略目录；遥测 spool 与 ROS 日志位于
`/var/lib/rdk-board-agent/{telemetry,roslogs}`，板端 command/state/ready/snapshot IPC
统一位于 `/var/lib/rdk-board-agent/runtime`（目录 0700、文件 0600），也必须在启用
unit 前预创建。`rdk-board-agent.service` 使用 `PrivateTmp=true`，不会把公共 `/tmp`
作为 IPC；旧版 `RDK_BOARD_*` 文件环境变量只有在安全的绝对路径和 0700 父目录下才会生效。

```bash
node scripts/sim2real-storage-backup.mjs backup \
  --storage-dir /var/lib/rdk-robot-learning-platform/sim2real \
  --audit-file /var/log/rdk-sim2real/audit.ndjson \
  --output /var/backups/rdk-sim2real/$(date -u +%Y%m%dT%H%M%SZ)
```

输出目录是可审计的快照，不依赖 tar 或第三方包，包含 `backup-manifest.json`、完整 `sim2real.json`、遥测分片和存在时的审计段。`consistency=quiesced` 表示复制时没有检测到源文件变化；只有明确传 `--allow-live` 才会生成 `consistency=best-effort` 快照，这种快照不能作为发布或评测证据。建议把快照目录再复制到加密的异地对象存储，并在对象存储侧启用版本保护和生命周期策略。

仓库附带的 `sim2real-backup.service`/`.timer` 默认跟随
`standalone-sim2real.service`（release `/opt/rdk-robot-learning-platform/current`、台账
`/var/lib/rdk-robot-learning-platform/sim2real`）。备份脚本会先选择当前 active 的 Web unit，
因此同一份 unit 也能用于旧的 Studio 集成部署；若主机同时安装了多个 unit，建议在
root-only `/etc/rdk-robot-learning-platform-sim2real-backup.env` 显式设置
`RDK_SIM2REAL_RELEASE_ROOT`、`RDK_SIM2REAL_STORAGE_DIR` 和
`RDK_SIM2REAL_SERVICE_NAME=studio-integrated-sim2real.service`。不要把旧的
`sim2real-web.service` 名称直接写回 unit；它只作为脚本的迁移兼容值保留。
如需覆盖 `RDK_SIM2REAL_BACKUP_DIR`，必须使用绝对路径、路径中不能含 `..`，且末级目录名固定为
`rdk-sim2real`（例如 `/mnt/backups/rdk-sim2real`）；这是为了让保留策略只接触专用快照目录。
systemd 的 `ProtectSystem=strict` 只为默认的 `/var/backups/rdk-sim2real` 开放写权限，使用其它位置前
还要在受审阅的 unit drop-in 中加入对应的 `ReadWritePaths`，不要为方便而开放 `/var`、`/opt` 等系统父目录。

如果生产环境设置了 `RDK_SIM2REAL_AUDIT_FILE`，备份和恢复命令都必须显式带上同一个
`--audit-file`；恢复会拒绝“快照缺少某个外置审计段、目标却仍留有旧段”的混合状态。

仓库内的确定性演练覆盖活跃写者门禁、best-effort 标记、恢复和篡改检测：

```bash
npm run verify:storage-backup
```

## 恢复与回滚

恢复始终先校验 manifest，再把快照复制到同一父目录下的 staging 目录，最后通过 rename 原子切换。目标目录原内容会保留为 `*.pre-restore-*`，便于撤销：

```bash
systemctl stop standalone-sim2real.service
node scripts/sim2real-storage-backup.mjs restore \
  --snapshot /var/backups/rdk-sim2real/20260913T030000Z \
  --storage-dir /var/lib/rdk-robot-learning-platform/sim2real \
  --yes
node scripts/sim2real-storage-backup.mjs verify \
  --snapshot /var/backups/rdk-sim2real/20260913T030000Z
systemctl start standalone-sim2real.service
node scripts/probe-sim2real.mjs --url http://127.0.0.1:18102
```

审计流配置在台账目录外时，恢复命令也要带 `--audit-file`；工具会先校验所有审计段，再以独立的原子 rename 替换目标文件，并为已有文件保留 `*.pre-restore-*` 回滚副本。
外置审计文件的父目录必须是专用的 `0700` 普通目录，路径中的祖先不能是符号链接；恢复会在切换台账前拒绝 `/etc` 等共享目录或任意系统文件目标。这样即使 `--audit-file` 写错，也不会把快照内容写入无关文件。

如果目标目录仍有活跃 writer，恢复会停止；只有在已经确认服务不会再写入时才使用 `--force`。不要手工复制单个遥测分片或删除 ledger：索引和分片必须来自同一份快照，否则评测可能看见不完整证据。

## 迁移到共享存储

JSON 台账适合单写实例或一写多读副本，不适合多写者和滚动发布。迁移到 PostgreSQL/对象存储时，按以下顺序保留可追溯性：

1. 停止写实例并生成 `consistency=quiesced` 快照；记录快照 manifest 的 SHA-256。
2. 先导入 `models`、`projects`、`datasets`、`artifacts`、`evaluations`、`runs`、`deployments` 等索引行，保留原 ID、owner、时间戳和状态；重复执行必须按 ID 幂等。
3. 将每个 `telemetry/<runId>.jsonl` 和 `audit.ndjson`/`audit.ndjson.1` 作为不可变对象上传，数据库行只保存对象 key、字节数和 SHA-256；上传后逐对象校验，再切换读取 adapter。
4. 在 shadow/read-only 模式同时读取旧 ledger 和新 adapter，对数量、状态、样本数、审计事件数和摘要做比对；差异必须归档，不能静默修正。
5. 切换单一 writer 后，再开启第二个副本。迁移完成前保留原快照和 `*.pre-restore-*` 回滚目录。

迁移不会改变现有 HTTP 契约；`Sim2RealStore` 的接口应继续提供相同的 owner 隔离、幂等键、状态机和 release evidence gate。文件 lease 只能保护当前 MVP，不能替代数据库事务或分布式锁。

## 监控和告警

Prometheus 至少采集以下指标，并把服务日志中的 `requestId` 与网关日志关联：

```promql
sum(rate(sim2real_http_requests_total{status=~"5.."}[5m])) > 0
histogram_quantile(0.95, sum(rate(sim2real_http_request_duration_seconds_bucket[5m])) by (le, route)) > 2
sim2real_process_uptime_seconds < 60
```

同时轮询 `/readyz`：连续两次 503 进入告警，恢复为 200 后自动解除。`storage-not-configured`、`sso-adapter-required` 和 `microduck-not-mounted` 应作为不同告警标签展示；它们分别对应存储挂载、认证适配器和仿真依赖，不要用重启掩盖原因。备份任务应每天执行一次、每周做一次 `verify`，并至少每季度在隔离目录做一次恢复演练。
