# RDK Golden Path

RDK 的主线只保留一条：

```text
选择任务 → 准备数据 → 训练或接入模型 → 评测 → RDK 只读预检/部署 → 真机反馈 → 失败回流
```

平台通过 `GET /api/sim2real/golden-path` 输出这条主线的唯一状态读模型。网页、命令行和 RDK Studio 不应各自根据 Run 或 Deployment 猜下一步。

## 查询

```bash
curl 'http://127.0.0.1:18102/api/sim2real/golden-path?projectId=<project-id>&modelId=<model-id>&taskId=goal-navigation-clear-arena'
```

返回包含：

- `stages`：任务、数据、训练、评测、部署、反馈六个阶段及 `pending/ready/running/succeeded/blocked/failed` 状态；
- `progress`：已经完成的阶段数和百分比；
- `nextAction`：当前唯一建议动作及原因；
- `readyForRdkPreflight`：训练和评测证据都完成后才为 `true`；
- `refs`：对应的 dataset、run、evaluation 或 deployment ID，便于页面直接跳转。

接口是只读的，可以在训练 worker 或 BoardAgent 运行期间轮询。它不会把 Mock、仿真评测或没有设备证明的结果标成真机完成。

## 各阶段的完成标准

1. **选择任务**：绑定任务包和 `taskId`。
2. **准备数据**：数据集状态为 `ready`，且没有被撤销。
3. **训练或接入模型**：Run 为 `completed`，或已登记一个可追溯的外部模型。
4. **评测**：最新评测为 `passed`，没有被更新的遥测标记为 stale。
5. **部署到 RDK**：先通过只读预检；Canary/Live 仍需要平台和现场人工闸门。
6. **失败回流**：收到带设备身份的板端遥测证据；失败轨迹绑定回原 Run 后进入下一轮数据。

第一条 RDK 参考路径使用 `goal-navigation-clear-arena`。它复用 LeRobot 数据格式和上游训练能力，平台只对 RDK 契约、制品指纹、板端延迟和发布证据负责。

```bash
npm run verify:golden-path
```
