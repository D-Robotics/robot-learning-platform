# RDK Duck Lab 产品设计基线

> 面向 RDK X5 与配件的仿真、动作训练、Sim2Real、部署和效果验证平台。
> 本文是产品和交互的基线，不把 RoboGo 或 RDK Studio 作为运行时依赖。

## 1. 产品定位

用户不应该先理解 MuJoCo、RL、ONNX、BPU、RoboGo 的边界，才能完成一个动作。
平台要把复杂链路压缩成一个可解释的任务流：

```text
选择 Duck 套件 → 仿真与录制 → 训练与导出 → 评测与契约 → 预检与上板 → 看效果与回滚
```

平台本身是独立的 Web 控制面；RDK Studio、CLI 和未来客户端都通过同一套 API 接入。
RoboGo 是云训练适配器，本地服务器是默认适配器；二者不能互相静默 fallback。

## 2. 设计原则

### 易用性：用户只面对“下一步”

- 首页只回答三个问题：我现在在哪一步、下一步做什么、为什么被阻断。
- 高风险动作不和普通按钮混在一起；训练、上传、Canary、Live 均显示前置条件。
- 专业参数默认折叠，先提供 smoke 档位；需要时再展开续训、环境数和迭代数。
- 每个失败状态都给出原因、修复动作和重新检查入口，不显示“未知错误”。

### 可视化：用状态和证据讲清楚变化

- 总览用流程卡表达状态，不要求用户阅读日志才能判断进度。
- 仿真页同时展示场景、录制状态、轨迹文件和下一步入口。
- 训练页展示后端选择、运行状态、checkpoint 和关键指标。
- 部署页展示契约、板端预检、无电机 Canary、Live 四道闸门。
- 效果页对比仿真/真机的视频、成功率、跌倒率、延迟和资源占用。

### 高内聚：一个模块只拥有一种业务责任

| 模块               | 负责                                   | 不负责                       |
| ------------------ | -------------------------------------- | ---------------------------- |
| Duck Lab Web       | 工作流、状态投影、用户操作             | 训练进程、舵机控制、模型编译 |
| Simulation adapter | 浏览器/离线仿真、录制、回放            | 训练计费、真机控制           |
| Training adapter   | Mock、本地 worker、RoboGo 任务         | 模型契约定义、Live 安全      |
| Artifact/contract  | manifest、形状、运行时、校验和         | 下载任意 URL、执行脚本       |
| X5 Agent           | 预检、标定、下发、遥测、急停           | 修改策略契约、绕过审批       |
| Accessory profile  | 相机/IMU/舵机/球等的仿真资产和驱动声明 | 跨项目共享运行状态           |
| RDK Studio/MCP     | 对话编排、审批、证据投影               | 持有平台业务真源             |

### 低耦合：通过稳定契约替换实现

- Web 不直接依赖 RoboGo SDK、MuJoCo Python 或 X5 shell。
- 训练后端统一返回 `queued/running/completed/failed` 和不透明 artifact 引用。
- 设备通过 `board profile + accessory profile` 描述能力，不把 X5 细节写死在页面组件。
- API 是唯一业务契约；MCP 只做 AI 适配和证据投影，Skill 只描述流程。
- 页面组件只消费 view model，不读取 runner 的原始响应。

## 3. 信息架构

平台固定为“一个总览 + 六个业务模块”，左侧导航始终可见：

1. **总览**：当前项目、下一步、集成健康度、流水线和套件概览。
2. **套件与契约**：选择产品、登记 manifest、配件和输入输出约束。
3. **仿真与录制**：浏览器仿真、动作说明、开始/停止/下载/回放。
4. **训练与模型**：选择本地/Mock/RoboGo、训练档位、模型版本和制品。
5. **评测与效果**：仿真/真机指标、成功率、跌倒率、延迟和发布建议。
6. **部署到 X5**：设备选择、板型探测、只读预检、Canary/Live 闸门。
7. **记录与版本**：运行历史、checkpoint、评测报告和审计记录。

项目和设备选择放在全局上下文条，避免用户在不同页面重复选择，也避免把“当前模型”藏在某个卡片里。

页面采用“两层信息架构”，把引导和能力拆开：

- **任务流层**：顶部固定显示“仿真与录制 → 训练与导出 → 评测与效果 → 预检与上板”，适合第一次使用或按顺序交付一个动作。
- **平台模块层**：总览页提供套件与契约、仿真与数据、训练中心、评测中心、设备与发布、记录与审计六个独立入口；熟悉用户可以直接进入任一模块，失败后也只重跑当前模块。
- **上下文层**：产品线、当前模型、目标设备和账号状态保持全局可见，模块之间通过 `projectId / modelId / deviceId` 契约传递，不复制表单状态。

因此首页不再承载所有业务表单，而是承担“选择、判断、跳转”三件事；每个工作区有自己的空态、阻断原因和下一步动作。

## 4. 核心领域对象

```text
Account (SSO subject)
 └─ Project
     ├─ Membership (owner / editor / viewer)
     ├─ DuckKit (RDK X5 + accessories)
     ├─ ActionTask (walk / kick / sit / custom)
     │   ├─ Trajectory (manual recording / replay)
     │   ├─ TrainingRun (local / mock / robogo)
     │   │   └─ Artifact (onnx / board-compiled / calibration)
     │   └─ Evaluation (sim / real / comparison)
     └─ Deployment (preflight / canary / live)
```

当前 MVP 先用 SSO `accountId` 做资源 owner 隔离；团队协作阶段再把 owner 扩展成
`Project + Membership`，由服务端统一裁决 owner/editor/viewer 权限。前端不根据用户名或邮箱自行判断权限。

动作任务需要声明目标、成功条件、观测/动作契约和评测指标；配件只通过 profile 增加输入、输出、资产和健康检查。

## 5. 状态机与安全闸门

```text
draft
  → sim_checked
  → trajectory_ready
  → training_running
  → evaluated
  → preflight_passed
  → canary
  → live
```

- `draft → sim_checked`：可以直接操作，不产生设备副作用。
- `training_running`：明确选择 local 或 RoboGo；不自动切换后端。
- `evaluated → preflight_passed`：契约、目标板和制品必须匹配。
- `canary`：无电机或受控限幅验证，由 X5 Agent 执行。
- `live`：人工批准、急停可用、遥测在线；网页不直接开电机。

任何一步失败都停在原状态，提供“修复后重试”，不伪造成功。

## 6. 端侧模型分工

- 运控：CPU 推理 ONNX，单线程，避免与感知抢占 CPU。
- 视觉、语音、导航等感知：使用 RDK X5 对应的 BPU 编译制品。
- 平台在 manifest 中同时记录 `workload`、`runtime`、`threads`、目标板和校验和。
- 没有 CUDA 时可以使用 Mock 跑通协议和台账，但 Mock checkpoint 永远标记为不可部署。

## 7. API/MCP 边界

建议 API 以 `/api/v1/duck/...` 为长期命名空间，首批资源包括：

- `projects`、`kits`、`tasks`、`trajectories`
- `runs`、`artifacts`、`evaluations`
- `devices`、`deployments`、`events`

MCP 只暴露有限的高层动作，例如 `create_task`、`start_simulation`、`submit_training`、
`get_run_status`、`validate_artifact`、`preflight_device`、`plan_canary`。危险动作必须经过 Execute 阶段和人工批准。

## 8. 当前实现映射

- 页面工作流：`services/sim2real-web/public/index.html`、`styles.css`、`app.js`。
- 训练/设备业务：`server/sim2real/`、`server/routes/sim2real-routes.ts`。
- 契约与台账：`shared/sim2real.ts`、`server/sim2real/sim2real-store.ts`。
- 浏览器录制：`services/mujoco-web/microduck-community-overlay.js`。
- 独立服务与发布：`services/sim2real-web/`、`scripts/copy-server-assets.mjs`。

现阶段 UI 和控制面已具备 MVP 基础；真正的 X5 Agent、配件 SDK、真实 RL worker、制品编译/下发和实体遥测仍需按上述边界逐项接入。

## 9. 设计参考

信息架构参考了同类机器人平台的公开文档：Hugging Face [LeRobot 文档](https://huggingface.co/docs/lerobot/main/index) 将遥操作、数据集录制、策略训练和部署组织成连续主线，并用 [LeLab GUI](https://huggingface.co/docs/lerobot/lelab) 把机器人配置、录制、训练和部署放进可执行工作区；[Isaac Lab 官方说明](https://docs.nvidia.com/learning/physical-ai/getting-started-with-isaac-lab/latest/train-your-first-robot-with-isaac-lab/02-how-isaac-lab-accelerates-reinforcement-learning.html) 则把机器人/场景资产、物理仿真和强化学习库做成可替换模块，支持在仿真中训练后回到仿真评测。这里借鉴的是“任务流 + 可替换模块 + 证据回写”的产品结构，不复制其硬件或运行时实现。
