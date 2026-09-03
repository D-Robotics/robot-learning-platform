# RDK Robot Learning Platform

面向 RDK-X5 与 MicroDuck 的机器人强化学习、仿真和 Sim2Real 工程工作台。仓库把浏览器仿真、动作录制、训练调度、模型契约、遥测评测与部署预检放在同一条可追溯工作流中，同时保留本地训练和 RoboGo 两种 runner 接口。

> 当前版本是可公开审阅的独立产品源代码与参考实现。默认可以用本地 Mock worker 验证“仿真 → 训练请求 → 运行台账 → 遥测评测”流程；真实 RoboGo、RDK-X5 板端 agent、SSO/OIDC 与 OTA 由部署方通过 adapter 注入，仓库不包含任何账号、密钥或设备地址。

## 30 秒上手

```bash
npm install
cp .env.example .env

# 终端 1：无 CUDA 的流程演练 worker
npm run dev:mock-worker

# 终端 2：独立 Web 工作台
npm run dev:sim2real
```

打开 <http://127.0.0.1:18102/>。页面中的“仿真与录制”会打开 MicroDuck 浏览器仿真；“训练与模型”可选择本地 Mock runner；“评测与效果”支持导入浏览器录制的 JSON/JSONL 并显式绑定到 Run；“部署到 X5”只做契约、板型和只读预检，不会在网页层直接开启电机。

运行确定性检查：

```bash
npm run verify
npx tsc --noEmit
```

## 目录

| 目录 | 内容 |
| --- | --- |
| `services/sim2real-web` | 独立 Web 入口、六模块工作流 UI、Mock worker 与服务单元示例 |
| `services/mujoco-web` | MicroDuck 静态入口、中文交互覆盖层、社区二维码和浏览器轨迹录制 |
| `shared` | MicroDuck 61D observation / 14D action / 50 Hz 契约、模型制品和遥测类型 |
| `server/routes` | Sim2Real HTTP API（模型、运行、部署、遥测） |
| `server/sim2real` | 本地/RoboGo runner、JSON ledger、兼容性策略和可替换 adapter |
| `docs/design` | 产品设计、MVP/90 分验收、Sim2Real 方案和端到端流程 |

## 训练与部署边界

- 本地 runner 与 RoboGo runner 使用同一份受控 manifest；请求只包含契约、训练 profile 和不透明 `artifact://` 引用，不执行任意 Python/XML/shell。
- 运控模型可声明 `runtime=cpu-onnx`、`workload=locomotion`、`threads=1`，在 X5 CPU 单线程推理；感知模型可继续使用 BPU，避免争抢控制循环。
- 普通 ONNX 只代表仿真/本地推理制品；上板必须提供匹配目标板型的 `.bin`/`.hbm` 编译制品和 runtime 元数据。
- 预检是只读的；Canary/Live 需要受控的 `BoardAgentPort` 与人工审批。平台不把 Mock 的 `completed` 当作真实 RL 或可部署模型。

## 多用户与 RoboGo

核心路由只依赖 `Sim2RealAuthPort`。公开仓库中的 standalone adapter 默认单用户、无身份推断；生产部署应接入已验证的 Studio SSO/OIDC adapter，再把 RoboGo token 作为服务端 secret 注入。绝不使用可被浏览器伪造的账号请求头。

## 上游与许可证

MicroDuck 浏览器资源的上游 commit、仓库和许可证边界记录在 [`services/mujoco-web/MICRODUCK-UPSTREAM.md`](services/mujoco-web/MICRODUCK-UPSTREAM.md)。发布组织应在首次公开发布前补充与上游及 D-Robotics 代码相匹配的 LICENSE/NOTICE；本快照没有替运营方做版权授权判断。

更多说明：

- [`services/sim2real-web/README.md`](services/sim2real-web/README.md)
- [`docs/design/sim2real-90-acceptance.md`](docs/design/sim2real-90-acceptance.md)
- [`docs/design/sim2real-mvp-guide.md`](docs/design/sim2real-mvp-guide.md)
- [`docs/design/rdk-duck-product-design.md`](docs/design/rdk-duck-product-design.md)
