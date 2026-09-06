# RDK Duck Lab（独立 Web 服务）

这个目录是面向 RDK X5 Duck 的独立仿真到真机 Web 应用，不属于 RDK Studio 的 React 页面。
它单独监听一个本地端口，通过 Nginx 发布为 /sim2real/，页面可以在浏览器中
打开已挂载的 MicroDuck 仿真、登记模型 manifest、连接本地训练 worker（或可选的 RoboGo），并对已登记的
RDK 执行只读板端预检。公开源码不内置上游 MicroDuck bundle；未挂载时会显示明确的安装指引页，
不会伪装成可用仿真。

## 当前闭环

```
本地训练 worker / RoboGo 或本地训练导出/登记
      ↓
MicroDuck policy contract（61D → 14D，50 Hz）
      ↓
浏览器官方 MicroDuck 仿真
      ↓
RDK 板型兼容性检查 + read-only preflight
      ↓
后续由受控 board agent 执行 canary/live
```

当前网页不会自动申请或启动计费开发机，不上传任意 Python/XML/shell，也不会
开启电机。点击“发起本地训练”或“发起 RoboGo 训练”才会向显式配置的 runner 发起一次训练请求；
canary、live、制品转换/下发仍需要单独配置受控适配器。

产品信息架构和交互边界见仓库根目录的
`docs/design/rdk-duck-product-design.md`。页面固定为“总览 + 六个业务模块”，顶部用“仿真与录制 → 训练与导出 → 评测与效果 → 预检与上板”引导新用户，避免把所有操作堆在同一张看板上。

当前控制面 90 分阶段验收清单见 `docs/design/sim2real-90-acceptance.md`；其中明确区分软件闭环验收和真实 X5 硬件验收。

评测页的遥测导入默认只在浏览器本地聚合；用户点击“上传到当前 Run 并评测”后，才会将 JSON/JSONL
分块写入对应运行并保存回放摘要。这个显式动作用于避免误传本地文件，也让每次评测都能追溯到具体 Run。

## 多用户账号与 Studio 解耦

Sim2Real 是独立 Web 项目，但生产账号沿用 RDK Studio 的 SSO 身份：

- Sim2Real 只依赖 `Sim2RealAuthPort`（账号 ID、访问令牌和多用户部署标志），业务路由不直接读取 Studio 会话实现。
- 当前源代码保留 `studio-sso-auth.ts` 这个可替换的组合根文件名；独立部署默认使用匿名单用户 adapter，生产环境必须替换为标准 OIDC 客户端，或启用文档中的签名 trusted-proxy adapter，不改 Sim2Real 业务模块。
- 所有模型、运行、部署和设备台账按稳定的 SSO `accountId` 隔离；未登录的共享部署请求直接返回 401，不回退到公共 owner。
- RoboGo token 只在服务端为当前账号的显式训练请求短时使用，不进入浏览器、URL、日志或 manifest。

因此“账号相同”不等于“项目耦合”：Studio 只是一个可选入口和 SSO 会话提供方，Sim2Real 的页面、API、台账和发布节奏独立存在。

当前同域部署应由经过验证的 Studio SSO 网关/adapter 提供身份；本仓库的 standalone unit
只带签名 `trusted-proxy` 参考实现，并不会直接解密 Studio Cookie。若未来把 Sim2Real 放到独立域名，
生产切换为单独注册的 OIDC client 和 Sim2Real 自有会话 Cookie，业务路由和台账无需改动。

## 本地启动

先在仓库根目录完成依赖安装，然后运行：

```
cp .env.example .env
npm run dev:mock-worker       # 终端 1；没有 CUDA 时的协议演练
npm run dev:sim2real          # 终端 2
```

如果要在没有 X5 的情况下演练“部署 → 只读板端预检”，再开一个终端运行：

```
npm run dev:board-agent       # 终端 3；仅 loopback、只读 reference agent
RDK_SIM2REAL_BOARD_AGENT_URL=http://127.0.0.1:19100 npm run dev:sim2real
```

对应的确定性验收命令是 `npm run verify:board-agent`。

该 reference agent 只实现 board passport 协议，返回明确的 `mock: true`、`actuatorControl: false`
和模拟的 `rdk-x5` 元数据；它不会执行任何收到的 shell 字符串，也不会声称真实 X5 已连接。
设备页的板型探测可将这些模拟元数据写回本地登记表，但部署预检仍会保持 blocked，不会把 mock
结果当作真机就绪证据。
生产环境请替换 `runOnDevice` 为组织维护的 BoardAgentPort，并通过 HTTPS、短期 token
和独立的执行策略保护 canary/live。

打开 http://127.0.0.1:18102/。生产构建应将入口编译到独立的 release 目录，并用
`scripts/copy-server-assets.mjs` 把 `public/` 复制到相邻的静态资源目录。

如果要显示浏览器 MicroDuck，请先把一个已审核、已固定版本的上游静态 release 挂到本地：

```
RDK_SIM2REAL_MICRODUCK_ROOT=/opt/microduck-web/current npm run dev:sim2real
```

也可以设置 `RDK_SIM2REAL_MICRODUCK_URL` 指向受信任的 HTTPS 仿真服务。源码仓库不代为
重新分发上游模型、策略或许可证；来源和安装脚本见 `services/mujoco-web/`。

## 生产安装

以下命令需要 root 权限；如果不是 root shell，请保留示例中的 `sudo`（或先执行
`sudo -i`）。所有 release、台账和 secret 路径都应由运维按组织规范调整并审核。

1. 在构建机完成 `npm ci` 和 `npm run build`。将 `dist-server/`、`package.json`、
   `package-lock.json` 组成一个版本化 release；浏览器资源已经由 `build:assets` 复制到
   `dist-server/services/sim2real-web/public/`，不需要再寻找根目录 `public/`。
   在 release 根目录执行 `npm ci --omit=dev --ignore-scripts`（编译后的服务仍需要
   `express` 运行时依赖）。Mock worker 也会一并复制到 dist。
   例如（在目标机执行前请先校验 release checksum）：

```bash
set -euo pipefail
release_sha="$(git rev-parse --verify HEAD)"
release=/opt/rdk-robot-learning-platform/releases/"$release_sha"
sudo install -d "$release"
sudo cp -a dist-server package.json package-lock.json services/sim2real-web services/mujoco-web "$release/"
(cd "$release" && sudo npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
current=/opt/rdk-robot-learning-platform/current
if [ -e "$current" ] && [ ! -L "$current" ]; then
  echo "refusing to replace non-symlink $current; migrate it manually after review" >&2
  exit 1
fi
sudo ln -sfnT "$release" "$current"
```

   目标机需要可执行的 Node.js 运行时；unit 通过固定的系统 `PATH` 查找 `node`。
   安装 Node.js 22 LTS（或满足 `^20.19.0 || ^22.12.0 || >=24.0.0` 的版本），并在启用服务前确认：

   ```bash
   node --version
   command -v node
   ```

   如果 `node` 不在 `/usr/local/bin`、`/usr/bin` 或 `/bin`，请在 unit 的 `Environment=PATH=`
   中加入受控目录后再执行 `daemon-reload`；不要把用户可写目录放入服务 PATH。
2. 创建专用用户和目录：

```
if ! id -u sim2real >/dev/null 2>&1; then
  sudo useradd --system --home /var/lib/rdk-robot-learning-platform --shell /usr/sbin/nologin sim2real
fi
sudo install -d -o sim2real -g sim2real -m 0700 /var/lib/rdk-robot-learning-platform/sim2real
sudo install -d -o sim2real -g sim2real -m 0700 /var/lib/rdk-robot-learning-platform/mock-worker
```

3. 复制 `services/sim2real-web/sim2real.production.env.example` 到 root-only
   `/etc/rdk-robot-learning-platform-sim2real.env`，并立即收紧权限；只填写其中的
   secret/可选连接配置：

   ```bash
   sudo install -o root -g root -m 0600 services/sim2real-web/sim2real.production.env.example \
     /etc/rdk-robot-learning-platform-sim2real.env
   openssl rand -hex 32
   # 将上一步输出粘贴到 RDK_SIM2REAL_TRUSTED_PROXY_SECRET= 后，再执行：
   sudo awk -F= '/^RDK_SIM2REAL_TRUSTED_PROXY_SECRET=/{print length($2)}' \
     /etc/rdk-robot-learning-platform-sim2real.env
   ```

   上面的长度检查应输出至少 `64`（64 个 hex 字符 = 32 字节）。不要把 secret
   写进 shell 历史、unit 文件或仓库；如果使用其它安全注入方式，也要在启动前完成
   同等强度校验。

   不要把根目录开发用 `.env.example` 整份复制到生产；unit 会固定并校验
   `NODE_ENV=production`、`RDK_SIM2REAL_DEPLOYMENT=web-cloud`、`RDK_SIM2REAL_SSO_REQUIRED=1`、
   `RDK_SIM2REAL_AUTH_MODE=trusted-proxy`、`RDK_SIM2REAL_BIND_HOST=127.0.0.1`、
   `RDK_SIM2REAL_PORT=18102`、`RDK_SIM2REAL_PUBLIC_BASE_PATH=/sim2real` 和绝对台账目录，
   配置被覆盖时服务会拒绝启动。当前 standalone unit 只实现并固定
   `trusted-proxy` 参考适配器；如果组织要在本服务内直接终止 OIDC，必须先替换
   `studio-sso-auth.ts` 并相应调整 unit 的 auth guard。没有已验证 adapter 时服务会保持 401/未就绪，
   不会退化成匿名共享账户。不要把其它服务的 `.env` 整份加载进来，也不要把令牌写进 unit 文件。
   若启用本地训练，在同一个 root-only 文件中增加
   `RDK_SIM2REAL_LOCAL_RUNNER_URL=http://127.0.0.1:19090/train`；不需要 RoboGo 账号密码。
4. 安装 `standalone-sim2real.service`（它只运行编译后的 `dist-server`），并把 unit
   复制到 systemd 后执行 `daemon-reload`：

   ```bash
   sudo install -o root -g root -m 0644 services/sim2real-web/standalone-sim2real.service \
     /etc/systemd/system/standalone-sim2real.service
   sudo install -o root -g root -m 0644 services/sim2real-web/sim2real-mock-worker.service \
     /etc/systemd/system/sim2real-mock-worker.service
   sudo systemctl daemon-reload
   ```

   若要挂载到已有 Studio 主机并复用安全适配器，先创建
   `/etc/rdkstudio-sim2real-adapter.ready`，再使用 `studio-integrated-sim2real.service`；该 unit
   是针对旧 Studio 主机路径的兼容样例，启用前必须由运维审阅其中的用户、路径和环境文件，
   并确认真实 SSO adapter 已接入。不要在未接入真实 SSO adapter 时启用它。两个 unit 不能同时占用 18102。
5. 安装 Nginx 路由。先确保 HTTPS server block 中存在
   `server_name rdkstudio.d-robotics.cc;`，再安装独立控制面路由：

   ```bash
   set -euo pipefail
   sudo python3 services/sim2real-web/install-nginx-route.py
   sudo nginx -t && sudo systemctl reload nginx
   ```

   脚本默认修改 `/etc/nginx/conf.d/rdkstudio-ssl.conf` 中的
   `server_name rdkstudio.d-robotics.cc;` HTTPS server block。若发行版使用
   `sites-enabled` 或其它域名，请先把目标 server block 导出到受控配置，或设置
   `RDK_SIM2REAL_NGINX_CONFIG=/绝对路径/your-server.conf` 后再运行；脚本不会猜测或创建
   其它虚拟主机。已存在但端口/指令不一致的受管路由会 fail closed，要求人工迁移。

   MicroDuck 有两种部署模式：

   - 自包含模式：设置 `RDK_SIM2REAL_MICRODUCK_ROOT`，由 18102 直接提供静态资源；
     只需要上面的 `/sim2real/` 路由，不需要 18101。
   - 外置模式：先按 `services/mujoco-web/README.md` 部署 `mujoco-web.service`（18100）
     和 `microduck-web.service`（18101），确认现有 `/mujoco/` 路由，再在生产 env 中设置
     `RDK_SIM2REAL_MICRODUCK_URL=https://rdkstudio.d-robotics.cc/mujoco/microduck/`，运行
     `sudo python3 services/mujoco-web/install-microduck-nginx-route.py`，最后执行
     `nginx -t` 和平滑 reload。该脚本不会替你启动 18100/18101 服务；URL 必须与实际
     公网入口一致，否则控制面会继续把浏览器仿真标为 unavailable。
6. 启动并验证：

```
set -euo pipefail
sudo systemctl enable standalone-sim2real.service
sudo systemctl restart standalone-sim2real.service
for attempt in $(seq 1 20); do
  curl -fsS http://127.0.0.1:18102/healthz > /dev/null && break
  sleep 1
done
curl -fsS http://127.0.0.1:18102/healthz
curl -fsS http://127.0.0.1:18102/readyz
```

每次切换 `current` 到新 release 后都要执行 `systemctl restart`；仅执行
`enable --now` 在服务已经运行时不会重新加载旧进程。

`/readyz` 默认表示控制面（API、台账和认证边界）已可服务；MicroDuck 静态包是可选
依赖，因此未挂载时会返回 `200`，但在 `degraded` 中标记 `microduck-not-mounted`。
若某个部署把浏览器仿真作为硬依赖，可设置 `RDK_SIM2REAL_REQUIRE_MICRODUCK=1`，此时
缺少静态包会让 `/readyz` 返回 `503`。

当前 JSON ledger 是单实例 MVP：不要在没有数据库/对象存储 adapter 和跨实例锁的情况下
启动多个 Web 副本。遥测 ingest 默认每个 run 最多 100,000 个样本/128 MiB、每个账号最多
500,000 个样本/512 MiB；整个 ledger 另有 100,000 个 chunk、768 MiB 的硬上限。run/账号/chunk
遥测配额超限返回 `413 SIM2REAL_TELEMETRY_QUOTA_EXCEEDED`；整个 ledger 字节上限返回
`507 SIM2REAL_STORAGE_QUOTA_EXCEEDED`。任一情况都会拒绝本次写入，不会静默淘汰已接受的历史；
迁移到对象存储 adapter 后再提高配额。评测与回放读取该 run 的全部已接受 chunk。

除遥测保护外，单实例台账还限制最多 100 个自定义模型、10,000 个 run 和 200 个部署计划；
达到任一上限会返回 `507 SIM2REAL_LEDGER_QUOTA_EXCEEDED`，不会删除旧记录。local/RoboGo
的 queued/running 任务按账号共享并发上限（默认 4，可由
`RDK_SIM2REAL_MAX_ACTIVE_RUNS` 调整到最多 100）；幂等预留和上限检查在同一台账写入中完成，
可避免重试同时启动两个可能计费的任务。这个是单实例保护阀，不等于生产租户配额；多人/多副本
部署仍应迁移 PostgreSQL、对象存储和独立配额服务。没有 `externalRunId` 的崩溃窗口预留默认在
24 小时后、下一次提交训练时自动终止并释放名额（`RDK_SIM2REAL_ACTIVE_RUN_TTL_SECONDS` 可调，
范围 5 分钟至 7 天）；已拿到 `externalRunId` 的真实 runner 任务不会被这个 TTL 清理。

若 runner 已接受任务但提交响应超时/连接断开，或 Web 进程在保存 `externalRunId` 前崩溃，服务会
把结果保留为 queued 的 outcome unknown，重试不会自动再发起训练。运维确认 runner 任务归属后，
可对同一账号调用
`POST /api/v1/duck/runs/:id/reconcile`（`/api/sim2real/runs/:id/reconcile` 为兼容别名），提交
`{"externalRunId":"…","confirm":true}`；服务只做一次只读状态查询并原子补回台账，绝不重新启动
任务。runner 暂不可达时返回可重试的 `503 SIM2REAL_RUN_RECONCILE_UNAVAILABLE`。

发布后的入口为 /sim2real/。页面和 API 与 RDK Studio 主壳分开运行，但可通过
OIDC/trusted-proxy 沿用同一套 SSO 身份；业务代码和台账保持独立。

### trusted-proxy 身份转发

当组织已有 OIDC/SSO 网关而不希望在本服务内再引入一套登录页时，可设置
`RDK_SIM2REAL_AUTH_MODE=trusted-proxy` 和至少 32 字节的
   `RDK_SIM2REAL_TRUSTED_PROXY_SECRET`。网关认证成功后先剥离客户端同名 header，再添加：
`X-RDK-Account`、`X-RDK-Auth-Timestamp`、`X-RDK-Auth-Signature`；可选的
`X-RDK-Display-Name`、`X-RDK-Email`、`X-RDK-RoboGo-Token` 也必须包含在签名计算中。
签名是 HMAC-SHA256（hex 或 base64url），被签名字符串为：

```
timestamp\nHTTP_METHOD\nUPSTREAM_PATH\naccountId\nRoboGoTokenOrEmpty
displayName\nemail
```

时间戳默认只接受前后 300 秒；同一签名的写请求在有效窗口内也只接受一次，网关重试时应重新签名。
`UPSTREAM_PATH` 是后端看到的路径（例如 `/api/v1/duck/runs?view=active`，包含 query string；旧
客户端的 `/api/sim2real/...` 也会原样保留），
不是外层 Nginx 的 `/sim2real` 前缀。生产网关仍应设置 SameSite cookie、严格 Origin 策略并限制
`/sim2real` 的访问；服务内置跨站 Origin/Fetch-Metadata 闸门作为第二层防护。

## 产物规则

- 用户模型只接受受控 manifest 的不透明制品引用；服务不会把引用当作任意 URL、
  shell 命令或文件路径执行。
- 运控/行走策略可以登记为 runtime=cpu-onnx、workload=locomotion、threads=1，
  由 RDK CPU 单线程推理；视觉/感知模型继续走 BPU，二者不争抢同一计算资源。
- `simulator.policyBundle` 登记真正由 ONNX 制品驱动的动作策略；`simulator.controls` 单独登记
  仿真/UI 的完整按键和触发方式（例如重置、叫声、生成球这类不对应 ONNX 制品的动作）。平台会校验
  policy bundle 中的每个动作是否指向已登记的 ONNX policy artifact。
- 其中 `B` 叫声是平台覆盖层的便利快捷键，不是上游 MicroDuck 桌面键盘原生绑定；移动端按钮和手柄
  仍可通过同一个动作总线触发。控制面会把这类 UI 动作标为 `source=ui`，避免误导用户把它当成策略键。
- 本地训练是首选路径：设置 `RDK_SIM2REAL_LOCAL_RUNNER_URL` 指向同机或内网 worker 后，页面的
  “发起本地训练”会复用同一套训练/续训协议；不需要 RoboGo 账号或密码。
- 本地与 RoboGo 训练请求支持 `smoke`、`low-vram`、`standard`、`high-vram` 四档预设，并把
  `numEnvs`、`maxIterations`、`video` 归一化后再发送。低显存默认从 64 环境起步，高显存默认 4096。
- 续训必须提交明确的 `resumeFrom.checkpointId` 与受控 `artifact://` 引用，不依赖“最新 logs”；
  这让多个并行任务不会互相恢复错 checkpoint。
- 其它 ONNX 仍只用于浏览器/本地/RoboGo 仿真路径；RDK BPU 上板必须提供目标板型匹配的编译制品。
- X5、S600 等板型的编译格式和 runtime 以 RDK 官方文档及仓内兼容性矩阵为准，
  不把普通 ONNX 直接冒充板端二进制。
- Web Cloud 必须显式配置 RDK_SIM2REAL_STORAGE_DIR；不使用进程本地隐式共享台账。

### RoboGo runner 协议

设置 RDK_SIM2REAL_ROBOGO_RUNNER_URL 后，服务端会用 POST 发送已校验的
MicroDuck manifest（包含 contract、机器人变体、不透明 artifact 引用和归一化训练参数），不发送
Python/XML/shell。runner 返回 JSON 的 status（queued/running/completed）；queued/running
必须返回可轮询的 `runId`，completed 可省略它，也可附带 `launchUrl`、`message`；launchUrl
仅接受 HTTPS（本机开发允许 localhost HTTP）。
未配置 runner 时任务只登记为未启动；runner 的确定性 4xx 拒绝会标记失败，而超时、连接断开或
无法确认响应的情况会保留为 queued 的 outcome unknown，三种情况都不会伪造训练完成。
训练资源探针（可见算力和开发机数量）只用于界面提示，不是提交训练的硬前置条件：在
trusted-proxy 部署中，网关可以只在用户显式提交训练的 POST 请求上转发短期 RoboGo token，
也可以暂时无法访问只读资源接口；页面仍会把请求交给服务端，由服务端在实际 runner 调用前
再次校验账号和 token。没有授权时服务端只登记为 blocked，不会偷偷回退本地或启动计费任务。
每个账号默认最多同时保留 4 个 queued/running 的本地或 RoboGo 任务，可用
`RDK_SIM2REAL_MAX_ACTIVE_RUNS` 调整（上限 100）；达到上限返回 429，避免网络重试或误操作造成无限计费。
单用户本地部署可以把 `RDK_SIM2REAL_ROBOGO_TOKEN` 放在 root-only 环境文件中；共享/trusted-proxy 部署会忽略这个全局令牌，必须由已验证网关为每个请求转发签名的短期令牌。
已受理任务的状态查询若暂时失败，会返回可重试的 `503 SIM2REAL_RUN_STATUS_UNAVAILABLE` 并保留
最后已知状态；前端会退避轮询，不会擅自把仍可能计费的 runner 任务标成完成或失败。

### 本地 worker 最小协议

本地训练不需要 RoboGo 账号。将 `RDK_SIM2REAL_LOCAL_RUNNER_URL` 指向同机或内网的
`POST /train`，worker 只需接收上一节所述的同一份 JSON 契约，并把训练进程映射到固定的
profile 白名单（`smoke`、`low-vram`、`standard`、`high-vram`）。建议 worker 只监听
`127.0.0.1` 或私有网段，并自行把 `modelId + version + runName` 映射到隔离的任务目录；不要
把请求字段拼成 shell 命令。

响应保持简单，例如：

```json
{
  "status": "queued",
  "runId": "local-microduck-20260903-001",
  "message": "任务已进入本地 GPU 队列"
}
```

训练完成后可以返回受控 checkpoint：

```json
{
  "status": "completed",
  "runId": "local-microduck-20260903-001",
  "checkpoint": {
    "checkpointId": "checkpoint-1500",
    "artifactRef": "artifact://microduck/checkpoint-1500",
    "iteration": 1500
  }
}
```

平台只记录这些状态和不透明引用；模型文件、Python/XML、shell 和 GPU 进程都由 worker
自身管理。这样本地服务器可以直接接现有的 MicroDuck RL/Isaac 训练环境，也可以先用一个
队列 worker 做冒烟验证，再逐步接入真实训练脚本。

### 无 CUDA 时的 Mock worker（仅 MVP 流程演练）

本仓提供 `mock-local-worker.mjs` 和对应的 systemd 单元，用于没有 CUDA、MuJoCo 或训练依赖时先把
“仿真 → 训练请求 → 台账 → checkpoint 引用”这条链路走通。它校验 MicroDuck 固定契约或 RDK Duck 的
manifest-defined 契约并写入
一个受控任务 JSON，先返回 `queued`，再通过 `GET /runs/:runId` 模拟 `running → completed`，完成时附带
`mock: true`、受控的 `artifact://mock/...` checkpoint/artifact 引用和 metrics；明确标注“未执行真实 RL”。
它不会启动 Python、shell、GPU 进程，也不会生成可部署的 ONNX/HBM 模型。因此 Mock 返回的 `completed` 只代表
接口流程完成，绝不能用于 RDK 上板或续训真实模型。

生产启用方式（仅在确认需要流程演练时；先编辑 env，再启动 worker）：

```
sudoedit /etc/rdk-robot-learning-platform-sim2real.env
# 加入（不要重复定义或把文件权限改成 0644）：
# RDK_SIM2REAL_LOCAL_RUNNER_URL=http://127.0.0.1:19090/train
# RDK_SIM2REAL_LOCAL_RUNNER_MODE=mock
sudo chmod 0600 /etc/rdk-robot-learning-platform-sim2real.env
sudo systemctl enable sim2real-mock-worker.service
sudo systemctl restart sim2real-mock-worker.service
sudo systemctl restart standalone-sim2real.service
```

Mock unit 不读取包含 SSO/RoboGo secret 的生产 env；默认端口是 19090。通常不要改端口；
如确需改，必须用 `systemctl edit sim2real-mock-worker.service` 添加只含
`RDK_SIM2REAL_MOCK_*` 的 drop-in，并同步把 root-only Web env 中的
`RDK_SIM2REAL_LOCAL_RUNNER_URL` 改为相同端口，否则控制面会连接失败。

接入真实 GPU worker 后，删除该环境变量并停止 Mock 单元，再把同一个 `/train` 协议指向真实 worker；Studio
API 和页面无需改变。

### 受控本地训练 worker（真实引擎桥接）

本仓还提供 `local-training-worker.mjs` 和 `sim2real-local-worker.service`。它是一个真实训练引擎
桥接器：服务端接收平台的 manifest，按白名单 profile 创建隔离任务目录，再用 `spawn(...,
{shell:false})` 启动管理员配置的可执行文件。训练引擎从 `RDK_SIM2REAL_REQUEST_FILE` 读取请求，
并必须将结果写入 `RDK_SIM2REAL_RESULT_FILE`。只有结果包含受控 `artifact://` checkpoint 或 artifact
引用，worker 才会返回 `completed`；进程成功但没有制品时会返回 `failed`，不会产生绿色假成功。
任务快照保存在每个 job 目录的 `job.json`；worker 重启时会恢复已结束任务，遗留的 queued/running
任务会标记为 `worker_restarted` 并停止自动重跑，避免重复消耗算力或产生重复制品。

启用前在 root-only 的 `/etc/rdk-robot-learning-platform-local-worker.env` 中配置：

```bash
RDK_SIM2REAL_TRAIN_EXECUTABLE=/opt/rl/bin/microduck-train
# Keep the outer single quotes when this is placed in a systemd EnvironmentFile;
# they preserve the JSON string quotes.
RDK_SIM2REAL_TRAIN_ARGS_JSON='["--request-file","request.json"]'
# Optional; use the same value in the Web service env to authenticate the
# loopback worker even when another local process can reach the port.
RDK_SIM2REAL_LOCAL_RUNNER_TOKEN=change-me-in-a-root-only-env-file
```

参数数组由 systemd 环境文件直接传入 JSON；worker 不执行 shell 展开，也不会把用户字段拼到命令中。
随仓库提供的 systemd unit 默认隐藏主机设备（包括 GPU），以保持最小权限；当前无 CUDA 的 CPU
流程可直接使用。若部署真实 GPU 训练，管理员应单独审核并复制该 unit，按主机安全策略仅放行所需
GPU 设备后再启用，不要直接把服务改成宽泛的特权模式。
训练引擎完成后写入类似下面的结果：

```json
{
  "checkpoint": {
    "checkpointId": "checkpoint-1500",
    "artifactRef": "artifact://microduck/checkpoint-1500",
    "iteration": 1500
  },
  "artifact": { "artifactRef": "artifact://microduck/policy-v3" },
  "metrics": { "reward": 12.4, "iterations": 1500 },
  "deployable": false
}
```

未配置 `RDK_SIM2REAL_TRAIN_EXECUTABLE` 时 `/healthz` 和 `/train` 返回 503
`real_worker_not_configured`。这条路径只提供安全、可复核的进程和制品协议；真实 PPO/MuJoCo
环境仍由部署方提供，不能把它与无 CUDA 的 Mock worker 混用。
如果可执行文件或参数 JSON 配置不合法，`/healthz` 同样会以 503
`worker_configuration_invalid` 失败，便于 systemd/网关尽早发现配置问题。
