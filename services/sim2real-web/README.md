# RDK Duck Lab（独立 Web 服务）

这个目录是面向 RDK X5 Duck 的独立仿真到真机 Web 应用，不属于 RDK Studio 的 React 页面。
它单独监听一个本地端口，通过 Nginx 发布为 /sim2real/，页面可以在浏览器中
打开 MicroDuck 仿真、登记模型 manifest、连接本地训练 worker（或可选的 RoboGo），并对已登记的
RDK 执行只读板端预检。

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
- 当前源代码保留 `studio-sso-auth.ts` 这个可替换的组合根文件名；独立部署默认使用匿名单用户 adapter，生产环境应替换为标准 OIDC 客户端，不改 Sim2Real 业务模块。
- 所有模型、运行、部署和设备台账按稳定的 SSO `accountId` 隔离；未登录的共享部署请求直接返回 401，不回退到公共 owner。
- RoboGo token 只在服务端为当前账号的显式训练请求短时使用，不进入浏览器、URL、日志或 manifest。

因此“账号相同”不等于“项目耦合”：Studio 只是一个可选入口和 SSO 会话提供方，Sim2Real 的页面、API、台账和发布节奏独立存在。

当前同域部署为了免去二次登录，组合根复用 Studio 的 SSO 会话；如果未来把 Sim2Real 放到独立域名，生产切换为单独注册的 OIDC client 和 Sim2Real 自有会话 Cookie，业务路由和台账无需改动。

## 本地启动

先在仓库根目录完成依赖安装，然后运行：

```
RDK_SIM2REAL_DEPLOYMENT=local \
RDK_SIM2REAL_SSO_REQUIRED=0 \
RDK_SIM2REAL_STORAGE_DIR=/tmp/rdk-sim2real-data \
node --import tsx/esm services/sim2real-web/server.ts
```

打开 http://127.0.0.1:18102/。生产构建应将入口编译到独立的 release 目录，并用
`scripts/copy-server-assets.mjs` 把 `public/` 复制到相邻的静态资源目录。

## 生产安装

1. 完成仓库构建，使独立 release 目录与静态资源存在。
2. 创建 /opt/sim2real-web/data，并限制为 0700。服务单元使用 root 仅是为了读取主
   Web Cloud 的 credential-revocation-tombstones；systemd 将主站 data 目录设为只读，
   独立台账目录才可写。
3. 独立部署安装 `standalone-sim2real.service`，并提供 root-only 的
   `/etc/sim2real-web-auth.env`（同域免二次登录模式只放与主服务一致的
   生产部署应使用独立的 OIDC client 与会话密钥，或在 adapter 中接入经过验证的 Studio SSO。不要把其它服务的 `.env` 整份加载进独立服务，也不要把令牌写进 unit 文件。
   若启用本地训练，另建 root-only 的 `/etc/sim2real-web-runner.env`，只写
   `RDK_SIM2REAL_LOCAL_RUNNER_URL=http://127.0.0.1:<worker-port>/train`；不需要 RoboGo 账号密码。
   若要挂载到已有 Studio 主机并复用其安全适配器，另见 `studio-integrated-sim2real.service`；不要在未接入真实 SSO adapter 时启用它。
4. 以 root 运行 install-nginx-route.py，然后执行 nginx -t 并平滑 reload。
5. 启动并验证：

```
systemctl enable --now standalone-sim2real
curl -fsS http://127.0.0.1:18102/healthz
```

发布后的入口为 /sim2real/。页面和 API 与 RDK Studio 主壳分开运行，但沿用
同一套 SSO 会话和设备安全边界。

## 产物规则

- 用户模型只接受受控 manifest 的不透明制品引用；服务不会把引用当作任意 URL、
  shell 命令或文件路径执行。
- 运控/行走策略可以登记为 runtime=cpu-onnx、workload=locomotion、threads=1，
  由 RDK CPU 单线程推理；视觉/感知模型继续走 BPU，二者不争抢同一计算资源。
- `simulator.policyBundle` 可把多个动作策略和按键映射登记在同一模型版本中；平台会校验每个动作
  是否指向已登记的 ONNX policy artifact。
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
Python/XML/shell。runner 返回 JSON 的 status（queued/running/completed，可选 runId、
launchUrl、message）；launchUrl 仅接受 HTTPS（本机开发允许 localhost HTTP）。
未设置或请求失败时，页面保持未启动/失败状态，不会伪造训练完成。

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
“仿真 → 训练请求 → 台账 → checkpoint 引用”这条链路走通。它只校验 `microduck-policy-v1` 契约并写入
一个受控任务 JSON，先返回 `queued`，再通过 `GET /runs/:runId` 模拟 `running → completed`，完成时附带
`mock: true`、受控的 `artifact://mock/...` checkpoint/artifact 引用和 metrics；明确标注“未执行真实 RL”。
它不会启动 Python、shell、GPU 进程，也不会生成可部署的 ONNX/HBM 模型。因此 Mock 返回的 `completed` 只代表
接口流程完成，绝不能用于 RDK 上板或续训真实模型。

生产启用方式（仅在确认需要流程演练时）：

```
systemctl enable --now sim2real-mock-worker
printf '%s\n' 'RDK_SIM2REAL_LOCAL_RUNNER_URL=http://127.0.0.1:19090/train' > /etc/sim2real-web-runner.env
printf '%s\n' 'RDK_SIM2REAL_LOCAL_RUNNER_MODE=mock' >> /etc/sim2real-web-runner.env
systemctl restart sim2real-web
```

接入真实 GPU worker 后，删除该环境变量并停止 Mock 单元，再把同一个 `/train` 协议指向真实 worker；Studio
API 和页面无需改变。
