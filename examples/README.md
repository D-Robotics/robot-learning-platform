# 可运行示例

这些示例是平台 API 的最小输入，不代表真实训练权重：

- `rdk-duck-policy-manifest.json`：一个自定义 RDK Duck 契约，展示如何声明 12 关节、8 维观测、CPU 单线程 ONNX 运控策略，并保留 RDK-X5 编译制品位。
- `telemetry-sample.jsonl`：两帧按时间排序的 Board Agent / 本地导入格式，可在“评测与效果”页导入。
- `services/sim2real-web/public/demo/microduck-telemetry-sample.jsonl`：8 帧、61D/14D 的合成
  MicroDuck 演示证据；页面的“载入合成演示证据”只用于验证上传与评测流程，不代表真实 X5 遥测。
- `local-engine-reference.mjs`：本地训练 worker 的最小外部引擎示例。它只演示
  `request.json → result.json` 协议，不生成真实权重，也不会声称完成 PPO；可直接替换为组织自己的训练入口。

```bash
npm run verify:examples
```

接入本地 worker 时，将 `RDK_SIM2REAL_TRAIN_EXECUTABLE` 指向 Node，并把参数数组设为该文件的绝对路径：

```bash
export RDK_SIM2REAL_TRAIN_EXECUTABLE=/usr/bin/node
export RDK_SIM2REAL_TRAIN_ARGS_JSON='["/绝对路径/rdk-robot-learning-platform/examples/local-engine-reference.mjs"]'
```

worker 会把本次 manifest 写到 `RDK_SIM2REAL_REQUEST_FILE`，示例引擎再把受控的
`artifact://example/...` 协议结果写回 `RDK_SIM2REAL_RESULT_FILE`。生产环境应替换为真实
MicroDuck/RDK Duck 训练入口，并由制品仓库生成真实引用。

真实项目应将 `artifact://example/...` 换成制品仓库生成的不透明引用，并补齐 SHA-256、目标板型与运行时包信息；示例不会生成或伪造模型文件。
