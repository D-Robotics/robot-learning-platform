# 机器人学习平台插件 0.3.1 交付范围

本版提供便携安装、账号接入、OriginMan 课程资源检查、短训练编排、同源评测、实验恢复和回放入口。首次使用说明见 [workshop-first-run.md](../plugins/rdk-robot-learning-platform/references/workshop-first-run.md)。

## 已有实际验收

2026-11-04，在正式安装的 macOS Studio、当前登录账号和教师已配置的在线课程资源下，学员输入一句话完成新训练、同源评测和本次视频播放，无需补充模型 ID 或训练参数。训练与评测各提交一次，视频实际播放至 0:06。此次短训练为 8192 步；评测 `clearGain=false`，流程通过不代表策略超过基线。

本版核对正式 OriginMan 契约，禁止 Agent 覆盖教师资源绑定；提交后保留原 Run，阻止更换实验标识或绕过编排重复提交。等待工具提供同 Run 续查游标，并在核对父 Run 与策略摘要后返回评测入口。

## 可重复检查

```bash
npm run verify:plugin:contracts
node --test scripts/plugin-experiment.test.mjs
node scripts/verify-workshop-distribution.mjs --plugin-dir <未配置的便携插件目录>
node scripts/verify-workshop-distribution.mjs --plugin-dir <未配置的便携插件目录> --failure-case
```

契约套件包含 107 项检查，实验引用套件包含 15 项检查。繁忙机器上，stdio 测试的 200 毫秒超时可能在并行启动时触发；可用 Node 的 `--test-concurrency=1` 串行运行同一组测试定位。便携通信检查应使用安装器支持的 Node 版本，检查的是合成课堂服务，不替代真实训练效果验收。

## 尚未完成

- Windows 原生安装及完整业务流程；目前只有代码与模拟契约验证。
- 双真实账号交叉越权、整班并发和全新电脑首次体验专项验收。
- 常驻课堂算力与资源分配；安装插件不会自动购买或创建计算资源。
- 真机部署、板端调优和回滚闭环。
- Studio 的分支选择、过程展示及播放器状态反馈仍需宿主配合。

后续平台预检和 Worker 诊断开发不属于这份 0.3.1 交付快照。不得把后续源码改动视为已经更新到本版便携核心。

## main 集成边界

本次将 0.3.1 插件源码、安装器、编排、打包及验证脚本整合到 main，保留 main 当前服务端与工作台实现。插件来自 `ea2e609` 的封存快照；旧分支中的其他平台改造没有随插件一起替换 main。

可转发的 0.3.1 分享包使用已验证且按摘要固定的便携 MCP 核心。源码连接器的工具目录从当前 main 生成，不能把它与便携核心的 OriginMan 服务能力视为相同。运行课程须连接支持该课程的正式平台和 Worker；本次源码合入不代表更新服务器、重新签发核心或完成真机部署。体验教程已同步为一句话流程。
