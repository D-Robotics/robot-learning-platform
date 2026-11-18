# Studio 两轮 Run 查询验收

同一 Studio 会话先用完整 Run ID 问策略留存和下载，再只说「刚才那条 Run」。
Promptfoo 检查两轮各有一次成功的 `rdk_training_status` 调用、参数指向同一 Run、
每轮实际核验下载链接、回复包含留存状态及链接，而且平台只收到 GET 或 HEAD。
仅引用历史答案、调用等待或评测工具、查询另一条 Run 都会失败。

先用 Node.js 24 安装本仓库的依赖并执行 `npm run build`。将
`RDK_STUDIO_SOURCE_DIR` 指向已安装依赖的 Studio 源码目录。评估会在临时
profile 导入候选插件，用 Studio 原生 Moss 会话、实际 MCP 进程和隔离的本地
Run 服务完成测试。

```bash
RDK_STUDIO_SOURCE_DIR=/path/to/studio \
RDK_STUDIO_EVAL_SCRIPTED_MODEL=pass \
PROMPTFOO_DISABLE_TELEMETRY=1 \
npx --yes promptfoo@0.125.1 eval --config evals/studio-run-routing/promptfooconfig.yaml --no-cache
```

把 `pass` 改成 `history-only` 会模拟只读历史的模型，命令应以非零状态退出。
脚本模型用于复测 Studio 会话、工具调用和断言。验收模型自主选工具时，改用
`RDK_STUDIO_EVAL_MODEL_CONFIG=/path/to/agent-config.json`，并移除
`RDK_STUDIO_EVAL_SCRIPTED_MODEL`。评估使用配置里的活动条目，也可用
`RDK_STUDIO_EVAL_MODEL_ENTRY` 选择单个条目。模型接收的是合成 Run 的对话和回执。
