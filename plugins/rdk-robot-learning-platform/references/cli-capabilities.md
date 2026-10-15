# 仓库能力入口：CLI 与工作台

这里覆盖没有独立 MCP 工具的真实平台能力。命令以 `RDK_ROBOT_LEARNING_PLATFORM_ROOT` 为仓库根；输入、输出、设备目标由本次用户请求提供，凭据从环境读取。先读该入口的源码/文档/`--help`（确有 help 时），不要假设每个脚本都支持同一参数。

## 安装、仿真、资源与训练

| 用户结果 | 真实入口 | 关键约束 |
| --- | --- | --- |
| 首次启动/演示 | `npm ci`、`npm run setup`、`npm start`；`docs/first-run.md`、`docs/demo-runbook.md` | 默认 Mock worker/reference BoardAgent/隔离账本是协议演练。 |
| CPU 真训练 | `npm run demo:starter`、`engines/starter-ppo/runner.py`；`docs/engines/starter-ppo.md` | 真产物、任务质量门和来源分开验证。 |
| 真实本地 worker | `npm run dev:local-worker`；`services/sim2real-web/local-training-worker.mjs` | 需要真实执行器、共享 token 和独立 job 工作目录；部署允许的 engine 取 health/配置。 |
| GPU/远程 runner 接入 | `npm run dev:gpu-agent`、`scripts/onboard-gpu-server.mjs`、`scripts/gpu-deploy.mjs`；`docs/gpu-runner.md` | 先帮助/doctor，显式执行目标和预算；无 GPU 不假装完成训练。资源 CRUD 见 [API 工作流](api-workflows.md)。 |
| 浏览器仿真和录制 | 工作台“数据与仿真 → 仿真与录制/轨迹与回放”；`services/mujoco-web/` | MCP 仅给入口和回放证据；画布、键盘、录制/导出使用真实浏览器。 |
| 设计任务/奖励/课程/DR | `tasks/*.json`、`adapters/*.json`、`scripts/resolve-task-pack.mjs`、`scripts/reward-vocabulary.mjs`；`docs/task-pack-training.md` | 先校验支持的词汇与引擎，不从不受支持模板静默降级。 |

## 模仿学习、视觉和生态引擎

| 能力 | CLI/实现与文档 | 最窄验收 |
| --- | --- | --- |
| offline-bc 真实示教训练 | `npm run train:offline-bc -- <trajectory.jsonl> --out <output>`；`engines/offline-bc/train_bc.py`、`docs/engines/offline-bc.md` | `verify:offline-bc` |
| ACT 动作分块与集成导出 | `npm run train:act -- <trajectory.jsonl> --out <output>`；`engines/act/train_act.py`、`docs/engines/act.md` | `verify:act` |
| diffusion-policy 多模态动作 | `npm run train:diffusion-policy -- <trajectory.jsonl> --out <output>`；`engines/diffusion-policy/train_dp.py`、`docs/engines/diffusion-policy.md` | `verify:diffusion-policy` |
| SmolVLA 计划/微调 | `npm run train:smolvla -- <lerobot-dataset> --out <output>`；`engines/smolvla/train_smolvla.py`、`docs/engines/smolvla.md` | `verify:smolvla`，真实 GPU 工作流另验收 |
| 像素观测 RL | `engines/visual-ppo/adapter.py`；`docs/engines/visual-ppo.md` | `verify:vision-observation` |
| MuJoCo MJX / dm_control | `engines/mjx-adapter/adapter.py`、`engines/dm-control-adapter/adapter.py`；各 `docs/engines/*-adapter.md` | `verify:mjx-adapter` / `verify:dm-control-adapter` |
| mjlab/rsl-rl / MicroDuck RL / Isaac Lab 生态适配 | `engines/mjlab-rsl-rl-adapter/`、`engines/microduck-rl-adapter/`、`engines/isaac-lab-adapter/` | 对应 `verify:*-adapter`；依赖和模型资产由部署环境提供 |
| MicroDuck 足球训练/评测/成片 | `npm run train:football` / `eval:football` / `render:football-demo`；`engines/microduck-football/` | `verify:football` |
| MicroDuck 循环策略与任务评测 | `engines/microduck-recurrent/`、`engines/microduck-eval/`；目录内 README/docs | `verify:microduck-recurrent` / `verify:microduck-eval` |
| ONNX 输入命名/状态/历史 parity | `shared/artifact-quality-gate.ts`、`shared/policy-input-binding.test.ts`、`engines/*` | `verify:policy-input-binding`、`verify:observation-history`、`verify:microduck-rl-parity` |

BC 支持 `demonstrationRunId` 的真实浏览器示教快照，核对 worker 的数据哈希与消费摘要；无示教的内置 BC 冒烟和 ACT/DP 包装为 synthetic-smoke，其他真实采集数据训练用 CLI。不能只登记 datasetIds 就宣称训练消费了用户数据。ACT/DP 数据必须保留 episode 边界，按 episode 划分训练/验证；像素输入格式和导出选项取真实 train script。SmolVLA dry-run 会写 result.json，无模型 artifact；真训练需要 GPU/LeRobot/权重/数据，外部 Hub 发布只有用户要求时执行。microduck-recurrent 当前不在 API training engine allowlist，CLI 可用性单独验收。

ACT 的 `--out` 是模型 JSON 文件路径，不是目录；默认不导出 ONNX。需要部署图时先准备输出父目录，显式选择导出：

```bash
npm run train:act -- "$RDK_TRAJECTORY_FILE" --out "$RDK_MODEL_JSON" --onnx "$RDK_POLICY_ONNX"
```

需要集成图时再加 `--ensembled-onnx "$RDK_ENSEMBLED_ONNX"`，与图像输入分支的互斥/支持范围取当前 CLI。以导出结果和 equivalence 校验确认实际字节，而不是从参数存在推断。ACT 默认验证划分至少需要 4 个训练 episode 和 2 个验证 episode；单次仅 1 episode 的浏览器录制不足。先核对边界和数量，采集足够数据；用户明确选择无验证训练时才设 `--val-fraction 0` 并报告无验证证据，不自动关闭验证来掩盖数据不足。BC/DP 的 ONNX 导出也按各自实际参数显式选择。

实际录制到离线学习的验收入口为 `node scripts/verify-platform-plugin-demonstration.mjs --input <recording> --input <another-recording>`，或默认读取本次浏览器验收产生的 `dist/plugins/browser-episodes/`。它用真实 offline-BC CLI 与显式输入，保留每源/消耗文件摘要、整 episode 外部留出和 ONNX parity；BC 内置验证是行级，不与外部 episode 留出混称。缺输入/依赖明确 blocked，不补 synthetic。报告为离线学习软件证据，不等于可发布的 platform Run、任务质量门或实体运动。常规 CLI 运行也应避免继承 `RDK_SIM2REAL_REQUEST_FILE` + `RDK_SIM2REAL_RESULT_FILE`，否则引擎会进入文件协议包装路径而忽略命令行示教输入。

验收脚本 `--epochs` 支持 1..500；每次运行保留源字节、SHA、split、CLI 参数及独立输出目录。`status=passed-software-learning` 只证明真实消费、训练变化和导出等价；还要看 `trainingQuality` 和留出 MSE/基线，不能把过程通过当作可发布质量。调参前后保持相同源摘要和划分，一次只改一项；用于挑选参数的留出集不再是最终独立质量证明。

## LeRobot 双向转换

从真实输入读取、选择新的输出位置，在仓库根执行：

```bash
npm run convert:lerobot -- export "$RDK_TRAJECTORY_FILE" --out "$RDK_DATASET_OUTPUT"
npm run convert:lerobot -- import "$RDK_LEROBOT_DATASET" --out "$RDK_TRAJECTORY_OUTPUT"
```

converter 支持平台 step/录制 header+step/telemetry envelope。观测动作有限值、跨源维度、episode 边界、采样率必须一致；输出摘要记录 episodes/frames/dimensions/fps。导出目录须新建或为空；不要覆盖用户已有数据。

视频导入需 `--with-video`、ffmpeg 和依赖；多相机必须 `--video-key` 点名；`--tabular` 明确忽略相机并记录在 header，不能伪装完整视频导入。采样率按 header，冲突时显式 `--fps`。文档 `docs/engines/lerobot-converter.md`，验证 `npm run verify:lerobot-converter`。转换/文件产物完成后再用平台 dataset_register 绑定 URI/hash/来源。

## 制品、BPU 和板端

| 用户结果 | 入口 | 边界 |
| --- | --- | --- |
| 不可变制品签名 manifest | `scripts/package-artifact.mjs`；`npm run package:artifact -- --input <dir> --output <json> --artifact-id <id>` | HMAC 密钥仅 `RDK_SIM2REAL_ARTIFACT_HMAC_SECRET`；显式附 Run/dataset/contract/target lineage，命令仅组包签名，不把台账自动发布。 |
| BPU 编译 | `scripts/compile-policy.mjs`；`npm run compile:policy -- --input <onnx> --output <bin> --target <target>` | `RDK_BPU_COMPILER` 为现场工具链绝对路径；缺失或不支持 target 明确 blocked，保留 ONNX，不静默 CPU fallback。 |
| board-onnx 延迟收据 | `services/sim2real-web/board-latency-rehearsal.py --model <onnx> --decision-hz <task rate> --iterations <count>` | 在目标板端用真 runtime，不能与活动 agent 抢策略；不运动但会加载/推理/写收据。控制频率/摘要一致，声明进程内下界。 |
| 隔离板端 ONNX 数值验收 | `python3 scripts/verify-platform-plugin-board-inference.py --target "$RDK_PLUGIN_BOARD_SSH_TARGET" --model "$RDK_PLUGIN_BOARD_MODEL" --output ./dist/board-inference.json` | 目标和模型变量先在本地赋值；输出必须不存在。也可显式 `--device-file` 选择唯一 connected 记录。相同原始字节、主机/板端 CPU parity，测试输入为 synthetic observations；不安装依赖、不连接 ROS、不启动策略，不作为真实遥测/发布/实体证据。 |
| 安装/更新 BoardAgent | `scripts/install-x5-board-agent.sh` / `scripts/deploy-x5-board-agent.sh`；`docs/first-run.md`、`docs/production-operations.md` | 设备目标从 `RDK_X5_SSH_TARGET`，profile 从现场配置；install 和 update 不等同，不能默认 force 覆盖 unit。 |
| 板端只读 preflight | `scripts/preflight-board.sh`、`npm run accept:new-device`；`docs/host-station.md` | 检查真实摄像头/TROS/required topic/ONNX；缺必需话题保持 provenance Mock。 |
| 机器人 adapter 脚手架 | `npm run create:adapter -- --help`；`scripts/create-robot-adapter.mjs`、`docs/hardware-adapters.md` | 生成配置后跑 hardware/task 门禁；不可把脚手架当硬件验收。 |
| OriginBot 物理标定/演练 | `npm run calibrate:originbot`、`demo:originbot`、`demo:originbot-live`；`docs/originbot-calibration.md`、`docs/first-loop-goalnav.md` | 实体标定/Live 可运动，读取实际参数并遵守现场授权和平台门禁。 |
| D6A 机械臂验收/腿式驱动 | `docs/arm-drive.md`、`docs/actuator-drive.md`、`docs/microduck-leg-runtime.md`；`verify:arm-acceptance` | mock/synthetic、只读状态和实体动作分别报告。 |

motion/camera/bridge 等工作台功能见 [API 工作流](api-workflows.md)；不存在相应 MCP 原语时走已有受控入口，不走任意设备 shell 绕过平台。

## 运维与发布

```bash
node scripts/probe-sim2real.mjs --url "$RDK_SIM2REAL_MCP_BASE_URL"
node scripts/demo-preflight.mjs --url "$RDK_SIM2REAL_MCP_BASE_URL" --strict
node scripts/sim2real-storage-backup.mjs backup --storage-dir "$RDK_STORAGE_DIR" --output "$RDK_SNAPSHOT_DIR"
node scripts/sim2real-storage-backup.mjs verify --snapshot "$RDK_SNAPSHOT_DIR"
```

环境变量 `RDK_STORAGE_DIR` / `RDK_SNAPSHOT_DIR` 是本次任务的本地 shell 输入，不是新增平台配置。storage/snapshot/output/audit 均用绝对路径，backup output 必须尚不存在（只创建它的父目录，不先 mkdir 快照目录）。备份停活跃 writer，外置审计加 `--audit-file`；`--allow-live` 的 best-effort 不作为发布证据。恢复使用同脚本 restore + 正确 snapshot/storage + `--yes`，需已授权停机/替换并先校验；留 pre-restore 回滚副本，不复制 writer lease。详细契约见 `docs/production-operations.md`。

生产配置门禁 `npm run verify:production-config`；目标配置 `scripts/verify-production-config.mjs --env-file <actual> --unit-file <actual> --strict`。生产部署脚本 `scripts/deploy-sim2real-production.sh` 会构建、上传、切 release、重启并健康失败回滚，属于真实发布动作；用户请求范围内准备并完成必要门禁后执行，不默认部署到脚本旧目标。

## SDK、领域事件与 Agent 开发

Python SDK 位于 `sdk/python/rdk_robot_learning/`，仅 stdlib，专用方法目前 health/overview/submit_training/run 和通用 request。只读 CLI 可显式复用本插件平台 URL：

```bash
PYTHONPATH="$RDK_ROBOT_LEARNING_PLATFORM_ROOT/sdk/python" python3 -m rdk_robot_learning.cli --url "$RDK_SIM2REAL_MCP_BASE_URL" overview
```

SDK CLI 的 token 环境为已有 `RDK_SIM2REAL_TOKEN`，MCP Cookie/username 中继不会自动继承。当前 SDK request 没有自定义 Idempotency-Key/Cookie header 接口，submit_training 也没有稳定键，不用它执行必须幂等键的写请求；使用本插件 MCP 或遵照版本化 HTTP 契约的认证客户端。补齐 SDK 要走开发验证，不能在技能中声称已实现全部专用方法。

平台内部领域事件插件 `registerSim2RealPlugin` 位于 `server/sim2real/sim2real-events.ts`；这是平台内进程扩展机制，与此 Codex 插件包不同。训练跟踪/对象同步等可按事件接入，来源与 owner 边界见 [开发不变量](development-invariants.md)。Agent/MCP 扩展模板 `docs/agent-tool-templates.md`，UI 与源码门禁见同一参考。
