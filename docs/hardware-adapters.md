# 硬件适配包

平台核心只依赖统一的策略契约、遥测快照和受限运动接口。具体机型放在适配包中：传感器话题、动作执行器、观测槽位、动作投影和安全参数都由适配包声明。OriginBot 是首个参考适配包，不是平台边界；示例见 [`adapters/originbot-differential-drive.json`](../adapters/originbot-differential-drive.json)。

仓库同时提供 [`profiles/rdk-s100-generic-drive.json`](../profiles/rdk-s100-generic-drive.json)
作为第二种板卡族的可运行契约示例。该文件明确标记 `provenance.kind=synthetic`、
`provenance.mock=true`，只证明适配边界和维度可配置，不宣称已经有 S100 真机数据；
接入设备后先替换实际话题并运行只读预检。

部署与预检链路对两种板卡族统一：`scripts/install-x5-board-agent.sh` /
`scripts/deploy-x5-board-agent.sh` 用 `RDK_X5_PROFILE_NAME` 选择机型 profile
（含 `rdk-s100-generic-drive.json`），`scripts/preflight-board.sh` 按 profile
声明对板卡做只读核查（架构、TROS 路径、onnxruntime、相机、ROS 话题）。
required 话题未全部出现时预检失败，`provenance.mock` 必须保持 `true`；
预检输出即为翻转该标记所需的证据记录。

`adapters/*.json` 与 `profiles/*.json` 使用同一个 schema v1。设备身份统一放在
`board`，ROS 话题统一放在 `ros.topics`，执行器统一使用
`actuator.commandTopic` / `actuator.messageType`，策略维度统一放在 `policy`。
旧版 `platforms`、`sensors.*.topic`、`actuator.type` 字段不再作为独立契约；这样仿真、板端遥测节点、策略运行时和预检脚本读取的是同一份字段定义。

板端策略运行时支持通过 `RDK_SIM2REAL_ADAPTER_CONFIG` 加载 JSON 适配包。适配包可以配置 `runtime.decisionHz`、`runtime.actionProjection`、`runtime.actionOutput`、`safety.maxLinear`、`safety.maxAngular` 和 `safety.sensorStallSec`。`runtime.actionOutput` 必须明确为 `physical-twist`（策略输出已经是 m/s、rad/s）或 `normalized-twist`（策略输出为 [-1,1]，运行时按安全上限缩放）；OriginBot PPO 适配包使用后者。环境变量可以覆盖部署参数，但运行时始终把值限制在平台安全上限内，未知单位直接拒绝加载并保持停止优先。

新增机型的最小步骤是：

1. 新增适配包 JSON，声明传感器、执行器和安全边界。
2. 在板端 agent 配置适配包路径、策略观测/动作维度和设备身份。
3. 用同一份 manifest 做契约校验、只读预检和策略加载。
4. 运行 `node scripts/verify-live-board.mjs`，确认真实数据字段存在后再进行运动 Canary。

平台 UI、认证代理、策略台账、预检和急停通道不需要为新机型复制一套实现。若新机型不是差速底盘，应新增对应动作投影适配器，并保留相同的速度限制、传感器失联停车和急停语义。
