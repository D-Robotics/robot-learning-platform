# 首个公开闭环：RDK-X5 目标点导航

这是平台 0～30 天的首个可复用任务包，目标是把一次训练结果变成其他用户可以
Fork、评测和部署的公开资产。

## 固定范围

- **机器人**：RDK-X5 + 通用差速底盘适配器（仿真先行，真机 Canary 需现场安全确认）
- **任务**：清场目标点导航 `goal-navigation-clear-arena`
- **输入/输出**：`imu-gravity-v1` 观测，`diff-drive-vw-v1` 动作
- **公开基线**：任务包中声明的 seeded baseline；训练策略必须同时提交 baseline 对比
- **发布链**：Dataset → Run → Artifact → Evaluation → Deployment

## 用户路径

1. Fork 任务包和公开 baseline。
2. 选择数据集版本，启动真实训练 Run。
3. 等待 Run 产出带 SHA-256 的模型制品。
4. 在 nominal/hard 两个评测信封中比较 baseline 与 trained。
5. 评测通过后创建部署计划；X5 上板仍经过只读预检和人工审批。
6. 将真机遥测绑定回 Run；失败轨迹进入失败案例库，作为下一次训练数据。

## 公开验收标准

- 新用户无需修改引擎代码即可 Fork 并启动 Run。
- Run 详情能看到数据集版本、模型指纹、评测报告和部署计划的完整血缘。
- 评测报告必须同时包含 baseline 和 trained；缺失或 trained 未超过 baseline 时发布闸门失败。
- 失败案例必须带 `taskId`、`runId`、环境信封、失败原因和可复现轨迹引用。
- Mock 结果、仿真结果和真机证据在 UI 与 API 中明确区分。

## 本地验证

```bash
npm run verify:task-pack
npm run verify:goalnav
```

这两个命令验证任务声明、训练/评测契约和发布门槛；它们不把仿真成功冒充成真机成功。
