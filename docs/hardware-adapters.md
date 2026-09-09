# 硬件适配包

平台核心只依赖统一的策略契约、遥测快照和受限运动接口。具体机型放在适配包中：传感器话题、动作执行器、观测槽位、动作投影和安全参数都由适配包声明。OriginBot 是首个参考适配包，不是平台边界；示例见 [`adapters/originbot-differential-drive.json`](../adapters/originbot-differential-drive.json)。

板端策略运行时支持通过 `RDK_SIM2REAL_ADAPTER_CONFIG` 加载 JSON 适配包。适配包可以配置 `runtime.decisionHz`、`runtime.actionProjection`、`safety.maxLinear`、`safety.maxAngular` 和 `safety.sensorStallSec`。环境变量可以覆盖部署参数，但运行时始终把值限制在平台安全上限内；配置缺失或损坏时回退到安全默认值并保持停止优先。

新增机型的最小步骤是：

1. 新增适配包 JSON，声明传感器、执行器和安全边界。
2. 在板端 agent 配置适配包路径、策略观测/动作维度和设备身份。
3. 用同一份 manifest 做契约校验、只读预检和策略加载。
4. 运行 `node scripts/verify-live-board.mjs`，确认真实数据字段存在后再进行运动 Canary。

平台 UI、认证代理、策略台账、预检和急停通道不需要为新机型复制一套实现。若新机型不是差速底盘，应新增对应动作投影适配器，并保留相同的速度限制、传感器失联停车和急停语义。
