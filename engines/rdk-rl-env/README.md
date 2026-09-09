# RDK 通用 RL Environment（OriginBot 适配器）

这是平台的第一版通用训练环境接口。环境循环、轨迹格式、奖励/终止语义保持通用；设备差异由 adapter 提供。当前内置 `OriginBotAdapter`，用二维差速运动学模拟 `/cmd_vel`，不依赖 ROS、Gazebo 或 GPU，适合本地演示和协议联调。

```python
from originbot_env import RDKRobotEnv
env = RDKRobotEnv(); obs, info = env.reset()
obs, reward, done, truncated, info = env.step([0.1, 0.0])
```

这是可复现的轻量参考环境，不等价于真实 OriginBot 物理。接入 Gazebo/Isaac 时，只替换 `RDKRobotEnv.step` 的 dynamics backend，保留 `OriginBotAdapter` 的观测、动作和安全边界契约；接入 RDK Duck 时新增 adapter，不改训练循环。

OriginBot 训练器：`python3 engines/rdk-rl-env/train_originbot.py`。它读取 Worker 注入的 `RDK_SIM2REAL_REQUEST_FILE`，输出 `RDK_SIM2REAL_RESULT_FILE`，训练 8→2 线性策略并生成评测指标。当前制品标记 `deployable=false`，接入真实 ONNX 导出和 X5 runtime 后再开放部署。
