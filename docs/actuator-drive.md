# 受限驱动（Constrained Drive · 运动金丝雀）

上位机工作台除了观察面，还提供一条**默认关闭**的通用板端运动通道：让机器人以极低速度短时间移动，用于 sim2real 迁移前的运动金丝雀验证。通道本身不绑定机型——只要板端 agent 部署在带差速底盘（`/cmd_vel`）的机器人上即可复用；**OriginBot 是首个参考机型**（当前实测数据来自它，见「案例」）。本文是这个能力的操作指南——启用前请完整读一遍。

## 安全立场（先读）

- **默认全关**：平台侧与板端侧两个开关**都**默认关闭，任一缺失即只读，`POST /api/sim2real/board-station/drive` 直接 409 拒绝（甚至不会触达板端）。
- **双重钳制**：代理与板端 agent 各自独立钳制——线速度 ≤ 0.3 m/s，角速度 ≤ 1.0 rad/s，单命令时长 0.2–2.0 s。
- **时间盒**：一条命令最多驱动 2 秒，窗口到期 agent watchdog 强制归零；窗口起点从发布器**确认底盘订阅在场**之后算起，命令排队时间不会被计入运动时间。
- **物理兜底**：底盘固件看门狗是最后一道地板（OriginBot 参考：`auto_stop_on=true`，500 ms 收不到 `/cmd_vel` 即自动停车；接入其他机型时确认其底盘有等价的静默即停行为）。整条链路任何一层死掉，失效模式都是「机器人停」。
- **急停永远可用**：`POST /api/sim2real/board-station/drive/stop` 绕过所有开关，任何时候返回 200。页面提供红色急停按钮 + 空格键全局急停；驱动窗口激活时视口右下角会出现常驻浮动急停按钮。
- **人在场原则**：启用驱动前，操作者必须物理在场、场地清空、机器人放置稳妥。运动测试永远不是无人值守操作。

## 启用（双开关）

```bash
# 板端（OriginBot 上）：/root/rdk-board-agent/agent.env
echo 'RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE=1' >> /root/rdk-board-agent/agent.env
ssh root@<board> systemctl restart rdk-board-agent

# 平台侧（运行 Web 工作台的环境）
RDK_SIM2REAL_STATION_DRIVE_ENABLED=1   # 加入 env 文件后重启工作台
```

验证两端都开：

```bash
curl http://127.0.0.1:18104/api/sim2real/board-station/drive
# { "ok": true, "platformEnabled": true, "drive": { "enabled": true, ... }, "actuatorPolicy": {...} }
```

前置条件（板端）：底盘 bringup 在跑、`/cmd_vel` 有订阅者（发布器就绪握手会显式确认这一点，缺订阅者则如实拒绝）。参考机型 OriginBot 的前置：`systemctl is-active originbot-bringup`。驱动开启时 agent 启动即预热发布器（常驻 rclpy 节点），首条命令延迟约 100 ms；驱动关闭则整条通道不加载。

## 界面操作（上位机 → 驱动金丝雀面板）

开关开启后，上位机页「驱动金丝雀」面板从默认说明态解锁出三个滑条：

1. **速度**：0.05–0.30 m/s（建议从 0.05 起步）
2. **角速度**：-1.0–1.0 rad/s
3. **时长**：0.5–2.0 s

点击 **「执行受限驱动」** 会先弹出确认对话框（复述速度/时长并提醒场地安全），确认后才下发。面板下方的状态行实时显示运动窗口（速度 · 剩余时间）或最近的停止原因（`window-expired` / `operator-emergency-stop` / ...）。

**急停**：红色按钮、空格键（任意页面，输入框聚焦时除外）、或浮动急停按钮（运动窗口激活时右下角自动出现）。

## API

完整契约见 `docs/api/openapi.yaml`（搜索 `drive`）。速查：

```bash
# 状态（只读，永远可用）
GET  /api/sim2real/board-station/drive

# 一条受限命令（双开关全开时）
POST /api/sim2real/board-station/drive
{ "linear": 0.05, "angular": 0, "durationSec": 2 }

# 急停（绕过所有开关，恒 200）
POST /api/sim2real/board-station/drive/stop
```

拒绝语义：409 响应区分**平台未开**（`SIM2REAL_STATION_DRIVE_DISABLED`，未触达板端）与**板端拒绝**（`BOARD_AGENT_DRIVE_REFUSED`，含 `reason`：`drive-disabled` / `linear-out-of-range` / `angular-out-of-range` / `duration-out-of-range` / `rate-limited`（200 ms 节流）/ `publisher-unavailable`（发布器握手失败，如实拒绝而非假成功））。板端的拒绝原文透传到浏览器，不做模糊化。

## 板端实现（部署形态）

`/root/rdk-board-agent/` 下三个文件协作：

| 文件 | 职责 |
| --- | --- |
| `board-agent-x5.py` | HTTP 面 + 运动窗口状态机 + watchdog 线程（窗口到期强制归零） |
| `board-drive-publisher.py` | 常驻 rclpy 发布器：10 Hz 读命令 YAML 并发 `/cmd_vel`；每周期重读文件（改速 ≤100 ms 生效）；冷启动就绪握手（确认底盘订阅后才写 ready 标记，agent 等到标记才开窗）；退出前补发零速帧 |
| `board-telemetry-node.py` | 常驻只读遥测节点：订阅机型遥测话题（参考机型 OriginBot：`/imu` `/odom` `/originbot_status`），2 Hz 写 JSON 快照（替代每 2 秒 3 个 `ros2 topic echo` 子进程，CPU 约 -80%）；换机型时只改这一文件的话题清单 |

命令文件 `/tmp/rdk-board-agent-drive.yaml` 由 agent 原子重写（tmp+fsync+replace）；急停 = 写零速 + agent 状态归零，发布器 100 ms 内跟进，底盘看门狗兜底。

## 案例

### 案例 1：首次低速运动金丝雀（标准三步）

人站在机器人旁、桌面清空后：

```bash
# 1. 零速验证：完整链路但不移动（里程计应无变化）
curl -X POST .../drive -d '{"linear": 0, "angular": 0, "durationSec": 1}'

# 2. 低速短窗：0.05 m/s × 2 s，肉眼确认缓慢前进 ~10 cm
curl -X POST .../drive -d '{"linear": 0.05, "angular": 0, "durationSec": 2}'

# 3. 急停验证：开窗后立刻按空格/发 stop，机器人应立即停
curl -X POST .../drive/stop
```

判定：`GET drive` 的 `lastStopReason` 依次为 `window-expired` → `window-expired` → `operator-emergency-stop`；`published` 计数递增；评估页「真机对比」面板的里程计数值与实际位移一致。

### 案例 2：sim2real 迁移前的姿态对照

评测页（03）的「真机对比」面板每 2 秒读取板端遥测（参考机型 OriginBot：电压、IMU 航向四元数实时解算、里程计位置/线速度）。给仿真侧同一任务的模型输出与真机遥测做同屏对照，先看遥测量级是否合理，再谈驱动验证。驱动测试后也可回看该面板的里程计增量与命令的一致性。

### 案例 3：测完即关（默认态恢复）

```bash
# 板端
ssh root@<board> "sed -i '/ENABLE_DRIVE/d' /root/rdk-board-agent/agent.env; systemctl restart rdk-board-agent"
# 平台侧 env 删除 RDK_SIM2REAL_STATION_DRIVE_ENABLED=1 后重启工作台
# 验证：两侧都应回 false，POST 应 409
```

恢复只读后，面板回到「未启用」说明态，控制区隐藏；急停仍然可用（它不依赖开关）。

## 接入其他机型

受限驱动通道是机型无关的：`/cmd_vel`（geometry_msgs/Twist）是 ROS2 差速底盘的通用约定。接入新机型需要确认/调整：

1. **底盘订阅者**：bringup 后 `/cmd_vel` 有订阅者（握手自动验证）。
2. **固件看门狗等价物**：底盘在命令流静默 ~500 ms 后自动停车（这是安全地板，必须有）。
3. **遥测节点话题清单**：改 `board-telemetry-node.py` 里的话题名与字段映射，评测页「真机对比」面板读取的 `originbot` 字段结构保持一致即可。
4. **预热/急停无需改动**：发布器、状态机、急停路径与机型无关。

## 故障排查

| 现象 | 含义 / 处理 |
| --- | --- |
| `409 publisher-unavailable` | 发布器 8 秒内未完成就绪握手（TROS 环境坏、底盘不在）。看 `journalctl -u rdk-board-agent | grep drive` 与 `/tmp/board-drive-publisher.log` |
| 命令 accepted 但机器人不动 | `originbot-bringup` 是否 active；`/cmd_vel` 订阅者是否存在（`ros2 topic info /cmd_vel`）；看发布器日志 `cmd -> lin=...` 是否出现目标速度 |
| 面板不出现滑条 | 双开关任一未开，或平台代理不可达（面板说明文字会区分这两种情况） |
| 遥测卡片变「无数据」 | bringup 停了或遥测节点挂了（agent 会自动重启它）；agent 重启后首几秒为空属正常 |
| 402/502 代理超时 | 隧道/网络抖动；命令时间盒保证机器人此时静止，直接重试 |
