# Sim2Real Lab 演示脚本

这份脚本用于现场投屏。它验证的是**软件控制面和协议闭环**：仿真入口（或内置演示证据）→
训练请求 → 运行台账 → 评测回放 → X5 只读预检 → 安全闸门。Mock worker、合成遥测和
reference BoardAgent 都会在界面上明确标识，不能被介绍成真实 PPO 或真机结果。

## 启动

在仓库根目录执行：

```bash
npm ci
npm run demo:sim2real
```

打开启动器打印的地址，通常是
`http://127.0.0.1:18102/?demo=1`。`?demo=1` 会固定 MicroDuck、行走任务和投屏视图，
并使用临时台账预置一台 `x5-demo` 模拟板卡。退出终端会停止三个子服务并清理临时数据。

## 90 秒讲解顺序

1. **总览**：说明顶部上下文、四步交付流程和“安全边界已开启”。投屏时可以点击右上角
   “退出演示”暂时恢复普通导航。
2. **训练与模型**：点击“运行 Mock 协议演示”，展示 `queued → running → completed`。
   运行卡片会写明“协议演示”，详情里的 `mock=true` 和 `deployable=false` 是刻意保留的
   证据。
3. **评测与效果**：点击“载入合成演示证据”，确认 8 帧、61D/14D、50Hz；再点击
   “上传演示样例并评测（不解锁发布）”。关键指标只显示契约状态，性能数字保持为空，
   页面会标出“合成证据 · 非真实遥测”。
4. **部署到 X5**：点击“生成预检计划”，再点“执行只读预检”。预期返回
   `SIM2REAL_PREFLIGHT_MOCK_ONLY`，页面显示“协议已验证，但不是真机预检证据”和
   `NO MOTOR`。这是演示成功的安全结果，不要把它改讲成部署成功。
5. **记录与版本**：打开记录页，展示 Run、发布计划和“已保存回放”三类证据；刷新页面后，
   回放摘要仍在，且继续标记为演示样例。

## 有上游 MicroDuck 资源时

先按 [`MICRODUCK-UPSTREAM.md`](../services/mujoco-web/MICRODUCK-UPSTREAM.md) 固定版本并
校验 release，再显式挂载：

```bash
RDK_SIM2REAL_MICRODUCK_ROOT=/opt/microduck-web/current npm run demo:sim2real
```

也可以使用经过审核的 HTTPS 入口设置 `RDK_SIM2REAL_MICRODUCK_URL`。启动器不会自动下载
或替换上游资源；没有 bundle 时，仿真页会显示安装指引，评测页仍可用内置合成证据完成
软件流程演示。

## 真实训练演示（starter-ppo）

需要真实 PPO 闭环（不再只是协议演练）时，另开一个终端：

```bash
python3 -m pip install --user numpy torch onnx   # 一次性
npm run demo:starter
```

约 1–2 分钟（笔记本 CPU，默认 240 轮）后控制台会打印：

```
[demo:starter] training completed: step reward 0.917 -> 0.997, successRate=1, fallRate=0
[demo:starter] real ONNX artifact: policy.onnx (95370 bytes)
[demo:starter] evaluation: samples=200 actionMAE=... actionRMSE=...
```

讲解要点：运行详情里 `mock=false`、metrics 来自真实评测回放；`policy.onnx` 是
`torch.onnx.export` 的真实制品；评测页的 MAE/RMSE 是训练后策略对未训练基线的
动作偏差。训练仍是 numpy 近似物理（不是 MicroDuck 全身动力学），`deployable=false`
保持诚实——上板依旧需要 X5 编译制品和只读预检。详见
[`docs/engines/starter-ppo.md`](engines/starter-ppo.md)。

## 现场边界

- Mock 只验证请求协议、状态流转和台账，不运行 PPO，也不生成可部署权重。
- 合成遥测只验证导入、分片、回放和评测渲染，不代表真实 X5 采样。
- reference BoardAgent 只返回固定的只读板卡护照，不连接 SSH、不执行任意命令、不驱动电机。
- 真实闭环还需要真实 RL worker、X5 BoardAgent/Protobuf、制品编译与签名、OTA/回滚以及
  一台实体 X5 的验收。
