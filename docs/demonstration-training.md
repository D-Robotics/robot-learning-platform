# 从录制轨迹发起真实 BC 训练

工作台的 BC 入口读取已上传到平台的 observation/action 向量，经过受控 Worker
训练并产出可核验的 ONNX。登记数据集 ID 仍只关联血缘；真实字节消费由训练完成状态
和输入摘要证明。

## 工作台操作

1. 在仿真页运行参考策略并录制轨迹；至少保留 12 帧完整观测和动作。
2. 到评测页点击“保存轨迹并评测”。首次使用无需预先创建 Run，平台会为录制建立
   browser 记录；创建或上传失败时录制留在当前页面，可重试。关闭页面前仍应导出 JSONL。
3. 在训练配置选择 `offline-bc`，明确选择已上传轨迹，设置训练轮数（默认 100，范围
   1–10000）。来源按当前模型和项目筛选；没有候选时先完成保存。
4. 到 Run 与进度启动服务端 Worker 训练。Worker 必须已注册 `offline-bc`，Mock
   无法满足真实训练入口。本机 GPU Agent 的浏览器转发目前不传送该快照，服务端
   runner 资源支持。
5. 完成后查看帧数、数据来源和训练/验证损失。“训练数据已核对”要求完成状态与
   引擎消费的 SHA256 匹配。修改轮数再次提交会产生独立 Run，便于比较。

浏览器录制默认绑定 browser 记录，避免把参考策略的数据误记成最近训练策略的评测。
用户在回放选择器明确选定已有 Run 时，保存按钮会显示其目标 ID。

## Worker 配置

使用现有 [本地 Worker 部署流程](gpu-runner.md)，在已有
`RDK_SIM2REAL_TRAIN_ENGINES_JSON` 注册表中增加 `offline-bc`，可执行文件为当前主机
Python 的绝对路径，参数为本仓库 `engines/offline-bc/train_bc.py` 的绝对路径。
该 Python 环境需要 `numpy`、`onnx` 和 `onnxruntime`；依赖锁见
`engines/offline-bc/requirements.txt`。启动 `npm run dev:local-worker`，平台通过
`RDK_SIM2REAL_LOCAL_RUNNER_URL` 连接该 Worker。配置修改后重启对应进程。

服务端从有权限的来源 Run 冻结完整遥测快照，仅向 Worker 发送有界 JSONL 与来源
元数据。既不接受任意文件路径，也不从请求 URL 下载训练数据。输入摘要、遥测版本、
来源 Run ID 和帧数保存到训练 Run 的 `trainingData`；原始向量不会塞进 Run 列表。
源码接口见 [OpenAPI](api/openapi.yaml) 的 `RunRequest` 和 `TrainingData`。

```json
{
  "modelId": "模型 ID",
  "backend": "local",
  "demonstrationRunId": "已保存轨迹的 Run ID",
  "idempotencyKey": "本次训练的稳定请求键",
  "training": { "profile": "smoke", "engine": "offline-bc", "maxIterations": 100 }
}
```

Agent 的 `rdk_training_submit` 接受同名平铺参数 `demonstrationRunId` 与
`maxIterations`；`rdk_training_status` 返回损失和 `dataUsage`。显式 PPO/SAC
算法、环境数量、续训和不支持的数据通道会拒绝，避免静默训练另一种任务。

## 验收与边界

```bash
npm run verify:offline-bc
npm test
npm run verify:ui
npm run verify:demonstration-training
```

最后一项需要已批准挂载的 MicroDuck 资源、Playwright/Chromium 和上述 Python
依赖。通过环境变量 `RDK_PLUGIN_JOURNEY_MICRODUCK_ROOT`、`RDK_PLAYWRIGHT_MODULE`、
`RDK_CHROMIUM_PATH`、`RDK_OFFLINE_BC_PYTHON` 指定本机安装。每次使用新端口、新账本；
无依赖时退出 2，不回退为合成验收。`--help` 不启动服务。

若录制和保存已经成功、后续传输失败，可把 `RDK_DEMONSTRATION_RECORDING_FILE`
设为前次验收的 `platform-plugin-browser-trajectory.jsonl`。脚本核对同目录原收据
的 SHA256、六段命令与时长，再经文件导入 UI 重建隔离账本，报告明确标为复用录制；
独立策略回合仍重新运行。新的输出目录必须与原目录不同。

验收运行真实 MuJoCo/ONNX，站立、前进、转向各录制两次，每段至少五秒实际物理时间，
reset 动画释放输入后才计时，并核对命令进入观测。六段全部合并保存，从空 Run 状态
通过工作台训练，再通过 Agent 用同一快照调整轮数；核对 Worker 输入、消费摘要、ONNX
制品和清单。结果默认保存在 `dist/testing/demonstration-training.json`。

录制以每次推理前的实际输入张量配对该次输出，header 标记
`pairing=policy-inference-v1`，该标记逐帧进入平台台账和遥测版本。浏览器来源缺少
标记会在 Worker 启动前拒绝；这是录制器的来源声明，不是硬件证明。导入与板端
数据不会被猜测为已验证的因果配对。定时器读取推理后的 observation/last_action 会把
标签泄漏进输入，旧录制不能据低训练损失作为策略学习证据，应重新采集。

验收目录还保留每个训练 Run 的 ONNX、模型 JSON、不可变清单和实际输入 JSONL。
训练后在同一浏览器仿真中重新 reset，分别用参考策略、最终 BC 和零动作运行
站立、前进、转向三个独立回合，保存实际物理状态、动作、命令跟踪误差和跌倒信息。
若上游策略加载器拒绝 BC，记录实际拒绝原因和未执行状态，不绕过其校验。
若策略被仿真器自动恢复成参考策略，该回合按不合格记录。软件执行通过与
`independentQuality.qualityPassed` 分开报告；这些短回合诊断不能替代发布质量评测。

当前平台快照最多 4 MiB（Worker 请求上限 8 MiB），仅支持完整向量帧和固定 `observation` 输入名，
图像与循环状态契约需使用对应引擎/CLI。合成样例、Mock、跨账号、契约错配、
混合来源、过短或超限数据均拒绝。未提供示教来源的文件协议仍保留明确的合成 smoke
模式，工作台 BC 入口要求真实来源。

验证损失采用同一轨迹内的行划分；相邻帧相关性很高，不能证明独立 episode 的泛化，
也不能证明学出的策略在闭环中稳定。训练输入不会自动成为新策略的 rollout 遥测。
制品保持 `deployable=false`；后续仍需独立仿真评测、Sim2Real、板端验证和发布门禁。
