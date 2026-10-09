# isaac-lab adapter — Isaac Lab 上游训练栈，平台契约之下

参考教程：论坛帖 **[Nexus 01] RoboParty RPO 运动策略训练与 Sim2Sim 验证**
（forum.d-robotics.cc/t/topic/35763，2026-09-28）。本适配器不复现任何物理、
不重写训练循环，只把教程的三步上游命令逐字驱动起来，并纳入平台契约与诚实
证据链。

## 教程步骤 ↔ 适配器行为对照

| 教程步骤 | 教程命令 | 适配器行为 |
| --- | --- | --- |
| 1. 训练（Isaac Lab, PPO, 域随机化） | `isaaclab.sh -p <train.py> --task=RPO-Flat ...` | `./isaaclab.sh -p <isaacTask.train> --task=<upstreamTaskId> --num_envs=<N> --max_iterations=<M>`；rsl_rl 迭代块解析为平台奖励曲线 |
| 2. Isaac Lab 内回放验证 | `play.py --task=RPO-Flat --num_envs=1 --plane --checkpoint=$CKPT` | 发现 `logs/**/model_*.pt` 最新检查点后逐字驱动 `isaacTask.play`；exit code 入 `metrics.replayExitCode` |
| 3. Sim2Sim（MuJoCo 迁移验证） | `sim2sim_rpo.py --load_model=$POLICY` | 逐字驱动 `isaacTask.sim2sim`；exit code 入 `metrics.sim2simExitCode` / `sim2simPassed` |
| 4. 接口对齐（观测构建 + 关节顺序映射） | 教程在两侧配置里人工核对 | 契约层强制：任务包声明 78 维单帧 + 10 帧历史堆叠（780 维输入）+ 23 维动作；适配器启动时校验 `contract.observationSize == frameWidth × frames`，不一致即拒绝。关节顺序映射仍属上游工程步骤，本适配器如实记录命令与日志而不代替人工核对 |

## 任务包

`tasks/isaac-origin-rpo-flat.json` + `adapters/isaac-origin-rpo.json`：

- 单帧观测 78 维：`gyro(3) + projected_gravity(3) + 命令(3) + 关节位置偏移(23) + 关节速度(23) + 上一拍动作(23)`（教程口径）。
- 观测历史：`policy.observationHistory: {"frames": 10, "order": "oldest-first"}`，策略输入 780 维；堆叠语义与平台 starter-ppo / 板端运行时一致（见 `docs/task-pack-training.md` 观测历史章节）。
- 动作 23 维关节位置偏移；教程给出的关节映射序列记录在任务包 `isaacTask.jointOrderMapping`。
- `deployable` 恒为 false：平台没有该机器人的板端运行时，制品只作训练与
  Sim2Sim 证据。

## 部署（GPU 主机）

需要一块有 Isaac Sim + CUDA 的机器：

```bash
git clone https://github.com/isaac-sim/IsaacLab ~/IsaacLab
# 上游工作区（含 robolab/scripts/... 的工程）按其自身文档安装
export RDK_ISAAC_LAB_ROOT=$HOME/IsaacLab
```

worker 引擎注册（`RDK_SIM2REAL_TRAIN_ENGINES_JSON`）：

```json
{
  "isaac-lab": {
    "executable": "/usr/bin/python3",
    "args": ["<repo>/engines/isaac-lab-adapter/adapter.py"]
  }
}
```

## 诚实边界

- 缺 Isaac Lab 工作区 → **exit 3**，不回退其他物理后端，不伪造完成。
- `physicsBackend` 只有在训练真跑了之后才是 `"isaac-lab"`；`cuda` 只在本进程
  探测到 CUDA 时为 true。
- 上游命令逐字记录在 `training-summary.json.steps`（command/exitCode/logTail），
  回放或 Sim2Sim 失败会如实体现在 `sim2simPassed=false`，不会被吞掉。
