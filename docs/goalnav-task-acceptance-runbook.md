# 42D goalnav 任务级真机验收 Runbook（到达目标点并停止）

> **执行条件（缺一不可）**：板子在线且电压 ≥6.5V（2S 空电下限 6.0V）；
> 用户本人在场并明确说“跑”；急停路径随时可用（`POST …/drive/stop`
> 绕过所有开关，物理上可直接扶起机器人）。任何一步不满足立即停在上一步。
> 本 runbook 是机械流程：每步有命令、有判定、有失败分支，不需要临场决策。

背景：2026-09-17 根治的 42D goalnav 契约缺口（goal 槽位零填充 + goalX/goalY
静默丢弃）见 `docs/real-loop-validation-2026-09-14.md` 第 4 节的 09-17 补记。
**旧 runtime 上的任务级验收无意义**——必须先完成第 1 步部署。

## 0. 前置状态自检（无运动）

```bash
# 板子在线
ssh -o ConnectTimeout=6 root@10.208.179.180 'echo alive'
# 前向隧道（Mac 127.0.0.1:19100 → 板端 agent）
curl -m 5 http://127.0.0.1:19100/healthz
# 反向隧道（板端 uploader → Mac 平台 18102）
ssh root@10.208.179.180 'curl -m 5 -s http://127.0.0.1:18102/api/healthz | head -c 200'
# 平台侧
curl -m 5 http://127.0.0.1:18102/api/healthz
# 电压与板端服务
ssh root@10.208.179.180 '/root/bin/read-battery.sh; systemctl is-active rdk-board-agent rdk-board-telemetry-uploader originbot-bringup'
```

判定：全部通过才继续；电压 <6.5V 停止（等充电）。uploader 必须 active
（session 事件要走它回平台）。bringup 不在就
`systemctl restart originbot-bringup.service` 后重查。

## 1. 部署修复后的 runtime（无运动，代码事务）

目标文件：`services/sim2real-web/board-policy-runtime.py` +
`board-agent-x5.py`。先探测板上真实安装路径（不要假设）：

```bash
ssh root@10.208.179.180 "systemctl show -p ExecStart rdk-board-agent | tr ' ' '\n' | grep -o '/.*board-agent-x5.py'"
```

对输出的目录（`/opt/rdk-board-agent` 或 `/root/rdk-board-agent`）执行：

```bash
BOARD_DIR=<上一步的目录>
scp services/sim2real-web/board-policy-runtime.py root@10.208.179.180:$BOARD_DIR/
scp services/sim2real-web/board-agent-x5.py      root@10.208.179.180:$BOARD_DIR/
ssh root@10.208.179.180 "chmod 0755 $BOARD_DIR/board-policy-runtime.py $BOARD_DIR/board-agent-x5.py; \
  md5sum $BOARD_DIR/board-policy-runtime.py $BOARD_DIR/board-agent-x5.py; \
  systemctl restart rdk-board-agent; sleep 3; systemctl is-active rdk-board-agent"
```

（若板子走的是 `scripts/install-x5-board-agent.sh` 的受审 systemd 安装，
等价方式是 `RDK_X5_SSH_TARGET=root@10.208.179.180
./scripts/deploy-x5-board-agent.sh`，它自带 staging/回滚事务并重启两个服务。）

**记录部署 md5**（写入验收记录）。判定：agent active、
`curl http://127.0.0.1:19100/healthz` 返回 `mock:false`。

## 2. 契约验证（零风险：只加载 + 拒绝路径）

```bash
AGENT='http://127.0.0.1:19100/v1/station'
TOKEN=<板上 /etc/rdk-board-agent/agent.env 里的 RDK_SIM2REAL_BOARD_AGENT_TOKEN>
# 加载 42D goalnav 制品（9-14 已留板，sha256 ad281858…）
curl -s -X POST $AGENT/policy/load -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"path":"goalnav42d-policy.onnx"}'
curl -s $AGENT/policy -H "authorization: Bearer $TOKEN"
```

`policy` 快照必须逐项核对：

| 字段 | 期望 | 不满足时 |
| --- | --- | --- |
| `state` | `ready` | 查 `lastError`，修复后重载 |
| `model.inputDim / outputDim` | `42 / 2` | 制品不对，停 |
| `observationLayout` | `imu-gravity-v1`（或 auto+42D 生效） | 见下 |
| `obsSlots`（slotPlan） | `goal_delta: real (/odom + goal)`、`twist: real (/odom)`、`slots_real:10`、`slots_adapter:32` | **部署的仍是旧 runtime**，回第 1 步 |
| `actionOutput` | `normalized-twist`（42D 训练器语义） | 在 agent.env 设 `RDK_SIM2REAL_ACTION_OUTPUT=normalized-twist`（及 42D 维度/布局 env，见下）后 restart 重载 |
| `actionScale` | linear ≤0.05、angular ≤0.2（金丝雀钳制） | 记录实际值；>0.05 先收紧再继续 |

若 `observationLayout` 不是 `imu-gravity-v1`：在板上
`/etc/rdk-board-agent/agent.env` 追加
`RDK_SIM2REAL_POLICY_OBS_DIM=42`、`RDK_SIM2REAL_POLICY_ACTION_DIM=2`、
`RDK_SIM2REAL_OBSERVATION_LAYOUT=imu-gravity-v1`（或
`RDK_SIM2REAL_ADAPTER_CONFIG` 指向已部署的
`adapters/generic-differential-drive.json`——它是 42D goalnav 的声明源），
`systemctl restart rdk-board-agent` 后重做本步。

**修复在位的活体证明（零运动）**——无 goal 启动必须被拒：

```bash
curl -s -X POST $AGENT/policy/start -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"direction":1.0}'
```

期望：`{"ok":false,"error":"goal-required", "message":"42D goalnav
(imu-gravity-v1) 策略需要 goalX/goalY（odom 绝对坐标）"}`。返回 ok=true
就是旧 runtime 在跑——**立即 `POST $AGENT/policy/stop` 并回第 1 步**。

平台侧同一道门（走 Mac）：`curl -X POST
http://127.0.0.1:18102/api/sim2real/board-station/policy/start -d
'{"direction":1.0}'`（平台开关未全开时是 409 `SIM2REAL_STATION_*_DISABLED`，
属预期；开关全开后无 goal 是 400/409 goal-required）。

## 3. 开关序列（运动前置）

用户已说“跑”。顺序：平台双开关 → 板端双开关。

```bash
# 平台侧（Mac；持久化到 .data/station-switches.json，运行时覆盖优先于 env）
curl -s -X PUT http://127.0.0.1:18102/api/sim2real/board-station/switches \
  -H 'content-type: application/json' -d '{"drive":true,"policy":true,"confirm":true}'
# 板端双开关：/v1/config 原子改 agent.env 的两行并自动 restart（约 2 秒）。
# 键名是完整 env 变量名；也可以走平台代理 POST /api/sim2real/device-connections/<id>/config
# body {"switches":{"RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE":true,...}}（需设备已连接）。
curl -s -X POST $AGENT/config -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"switches":{"RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE":true,"RDK_SIM2REAL_BOARD_AGENT_ENABLE_POLICY":true}}'
# 复核四道闸门
curl -s http://127.0.0.1:18102/api/sim2real/board-station/policy | \
  python3 -m json.tool | grep -E 'enabled|motionAuthorized|state'
```

判定：平台 drive+policy 均 true、板端 `enabled:true` 两项、
`motionAuthorized:true`。等价的手动路径见 `docs/actuator-drive.md`。

## 4. 短窗冒烟（2 秒 · 真实运动的快速体检）

先读当前位姿并定目标（goal 在车头方向 0.3m， odom 绝对坐标）：

```bash
ssh root@10.208.179.180 'python3 -c "import json;d=json.load(open(\"/var/lib/rdk-board-agent/telemetry/snapshot.json\"))[\"data\"][\"odom\"];print(d[\"positionX\"],d[\"positionY\"]) "'
```

（无 `yaw` 字段时用 IMU 四元数解算；目标也可直接取
`goalX = x + 0.3*cos(yaw)`、`goalY = y + 0.3*sin(yaw)`。）

```bash
curl -s -X POST http://127.0.0.1:18102/api/sim2real/board-station/policy/start \
  -H 'content-type: application/json' \
  -d '{"direction":1.0,"goalX":<x>,"goalY":<y>}'
sleep 2
curl -s -X POST http://127.0.0.1:18102/api/sim2real/board-station/policy/stop \
  -H 'content-type: application/json' -d '{"reason":"smoke-window"}'
```

判定：odom 有小位移（≤0.1m）、停止后冻结、`stopReason:smoke-window`、
`lastCmdVel {0,0}`。**失败分支**：任何异响/无位移/方向异常 →
`drive/stop` 急停，回第 2 步查 `actionScale`/`observationLayout`。

## 5. 任务级验收窗口（主验收）

同一起点重新 start（会话计数从 0 开始，事件带 goalX/goalY）：

```bash
# 后台 1Hz 采样（≥40 秒，记录 odom 轨迹）
ssh root@10.208.179.180 'for i in $(seq 40); do \
  python3 -c "import json,time;d=json.load(open(\"/var/lib/rdk-board-agent/telemetry/snapshot.json\"))[\"data\"];o=d[\"odom\"];print(time.time(),o.get(\"positionX\"),o.get(\"positionY\"),o.get(\"linearX\"),o.get(\"angularZ\"),d.get(\"battery\"))"; \
  sleep 1; done' > /tmp/goalnav-accept-trace.log &
curl -s -X POST http://127.0.0.1:18102/api/sim2real/board-station/policy/start \
  -H 'content-type: application/json' \
  -d '{"direction":1.0,"goalX":<x>,"goalY":<y>}'
```

**操作者全程注视机器人**，出现以下任一情况立即急停
（`curl -X POST …/board-station/drive/stop -d '{}'`，绕过所有开关）：

- 位移超过 1.0m 或明显偏离目标方向（>90° 背离）；
- 窗口超过 30 秒未到达；
- 撞障碍/异响/轮子打滑空转；
- 采样轨迹显示 odom 停止推进 >5 秒但 `lastCmdVel` 非零。

正常路径：机器人驶向 goal（0.3m @ ≤0.05 m/s，约 6–10 秒），接近目标后
策略输出自然衰减（`lastCmdVel` 线速度趋零）——此时操作者主动收口：

```bash
curl -s -X POST http://127.0.0.1:18102/api/sim2real/board-station/policy/stop \
  -H 'content-type: application/json' -d '{"reason":"task-acceptance-done"}'
```

急停验证（收口后必做，验证闸门在窗口后仍有效）：重新 start → 1 秒内
`drive/stop` → 确认 `operator-emergency-stop`、odom 冻结。

**PASS 判定（全部满足）**：

1. 终点位姿与 goal 距离 ≤0.15m（任务包 `termination.goalDistance`）；
2. 到达后、stop 前的 `lastCmdVel` 线速度已衰减（|linear| 明显低于巡航值，
   建议判据 <0.02 m/s，或对比轨迹中段峰值减速 ≥50%）；
3. `stopReason` = `task-acceptance-done`（正常收口）而非急停；
4. `published` 与 `inferenceCount` 一致、`inferMs` 合理（~0.5ms 量级）；
5. session-started 事件带 `goalX/goalY`（平台
   `GET /api/sim2real/runs/:id/board-sessions` 可见）。

**FAIL 处理**：如实记录轨迹与判定失败项，不重试超过 2 次；若 0.3m 目标
失败但方向正确，可做一次 0.8–1.2m 目标（对齐训练课程区间）+ 60s 窗口的
复测臂，两条轨迹都归档。

## 6. 收尾（安全默认，验收后必做）

```bash
# 平台双开关关
curl -s -X PUT http://127.0.0.1:18102/api/sim2real/board-station/switches \
  -H 'content-type: application/json' -d '{"drive":false,"policy":false}'
# 板端双开关关（agent.env 归零并 restart）
curl -s -X POST $AGENT/config -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"switches":{"RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE":false,"RDK_SIM2REAL_BOARD_AGENT_ENABLE_POLICY":false}}'
# 终态确认：idle、lastCmdVel {0,0}、无运动进程
curl -s $AGENT/policy -H "authorization: Bearer $TOKEN" | python3 -m json.tool | head -20
ssh root@10.208.179.180 'pgrep -af "board-drive-publisher|board-policy-runtime" || true'
```

归档（写入 `docs/real-loop-validation-2026-09-14.md` 第 4 节）：
部署 md5、电压、目标坐标、odom 轨迹摘要、终态距离、lastCmdVel 衰减证据、
published/inferenceCount/inferMs、PASS/FAIL 判定、收尾状态。**如实记录，
失败就是失败**——mock 永远不得标注为真机证据。
