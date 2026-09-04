# 可运行示例

这些示例是平台 API 的最小输入，不代表真实训练权重：

- `rdk-duck-policy-manifest.json`：一个自定义 RDK Duck 契约，展示如何声明 12 关节、8 维观测、CPU 单线程 ONNX 运控策略，并保留 RDK-X5 编译制品位。
- `telemetry-sample.jsonl`：两帧按时间排序的 Board Agent / 本地导入格式，可在“评测与效果”页导入。

```bash
npm run verify:examples
```

真实项目应将 `artifact://example/...` 换成制品仓库生成的不透明引用，并补齐 SHA-256、目标板型与运行时包信息；示例不会生成或伪造模型文件。
