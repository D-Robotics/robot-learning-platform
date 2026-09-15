# OriginBot 资产单一源

仿照 MuJoCo Menagerie 的模式：**机器人标定只在此处定义一次**，
`calibration.json` 是两个 MJCF 变体的共享数字源。

## 谁在读

| 消费者 | 用途 | 说明 |
| --- | --- | --- |
| `services/mujoco-web/models.py` | 可视仿真（ORIGINBOT_XML） | 含墙/障碍/19 束激光/深度相机/IMU/odom site |
| `engines/mjx-adapter/adapter.py` | MJX 训练物理（MJCF_TEMPLATE） | 极简场景；障碍是任务层 analytic 圆 |

两个变体的**机器人本体标定（底盘、顶柱、双轮、伺服 kv/力矩上限、基座高度）**都由
`assets/originbot/originbot.py` 从 `calibration.json` 生成，改数字两边同时生效。
`wheels.maxTorque`（2.0 N·m，标定的电机堵转力矩）默认不生效：`wheel_actuators()`
的 `forcerange=None` 保持历史输出，只有训练版显式传入（见下表）。

## 刻意保留的差异（有各自的技术理由，不是漂移）

| 差异 | 服务版 (mujoco-web) | 训练版 (mjx-adapter) | 理由 |
| --- | --- | --- | --- |
| 万向球 z 位置 | `-0.07`（视觉上悬空） | `-0.115`（真实三点着地） | 训练需要稳定的 3 点支撑；probe_mjx.py 记录了差异 |
| 积分器 | `implicitfast`（同） | `implicitfast` | 一致：Euler/RK4 在刚性轮伺服上发散 |
| 场景 | 墙 + 盒/柱障碍 + 激光 | 空场景 | MJX 无 cylinder-box 碰撞；障碍走任务层 analytic 圆保证质量门跨引擎可比 |
| 车轮摩擦 | `1.2 .01 .001` | 同 | 一致（mjx 版 chassis 摩擦 0.1 + 轮摩擦一致） |
| 基座 body pos | `0.16`（视觉标定值） | `REST_HEIGHT = 轮半径 − offsetZ = 0.17`（几何真值） | 0.16 时轮缘初始穿地 1 cm，接触求解器每回合把机器人弹上天；probe 断言复位位形 ncon≥3 且穿透 < 1e-4 |
| 轮执行器力矩 | 无上限（kv=8 伺服） | `forcerange = ±wheels.maxTorque`（2.0 N·m） | 无上限时满指令 26.6 N·m/轮，CG 又几乎正对轮轴——急加速直接翘头起飞；真实减速电机有堵转力矩，模型也一样 |

历史注：mjx-adapter 旧版曾直接使用 `base.height = 0.16`，导致复位穿地发射（上一行
差异的由来）；现由 `REST_HEIGHT` 从轮几何推导，calibration 的 `base.height` 保持为
mujoco-web 可视变体的标定值。
