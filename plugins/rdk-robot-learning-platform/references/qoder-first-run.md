# Qoder 安装与验收

## 安装

1. 将原始 ZIP 解压到最终目录，保留 `.qoder-plugin`、`.mcp.json` 等隐藏文件。原始包不含账号凭据，移动已配置目录后需要重新配置。
2. macOS 双击 `setup-qoder-macos.command`；Windows 双击 `setup-qoder-windows.cmd`。安装器准备摘要校验的兼容 Node 并生成绝对路径 MCP 配置，Qoder 入口不修改 Studio。已有兼容 Node 可在目录运行 `node setup.mjs --host qoder`。安装器会在该目录生成 `Qoder本机导入包.zip`，包含本机MCP路径。没有平台源码/npm依赖也可运行。
3. Qoder桌面使用“扩展→已安装→添加→上传Plugin”，选择安装器新生成的 `Qoder本机导入包.zip`，不要再上传未配置的原始发行ZIP。Qoder IDE若支持目录导入，可导入已配置的完整目录；Qoder CLI 按当前可执行文件名称运行 `qoder plugins validate /绝对路径/插件`，再在目标项目内运行 `qoder plugins install /绝对路径/插件 --scope local`。国内版命令可能是 `qoderclicn`，先用 `--help` 核对。不要只导入 `.mcp.json` 后声称已经安装全部技能。
4. 新开对话或重载插件，确认出现 `robot-acceptance` 技能及 `rdk_robot_onboarding_guide`、`rdk_robot_acceptance_assess` 工具。MCP服务器键为 `rdk-learning-platform`；无需新建同名重复连接。
5. 先调用 `rdk_classroom_guide` 读取课堂流程，或调用 `rdk_robot_onboarding_guide` 读取接入流程；这些本地工具无需平台登录。检查安装时调用离线 `rdk_plugin_status`，核对实际 `pluginRuntime.version=0.6.0` 与 `loadedSourcesMatch=true`；需要平台数据时再调用 `rdk_auth_status`，未认证使用 `rdk_auth_login` 的浏览器确认入口，再查状态。Qoder账号与RDK平台账号分别验证，不复制Cookie或密码。

官方入口：[CLI 插件](https://docs.qoder.com/cli/plugins)、[IDE 插件](https://docs.qoder.com/extensions/plugins)。安装以当前宿主实际反馈为准。此包不内置Qoder模型账号，也不携带OriginMan权重或实时执行适配器。

## 学员入口

新建空白聊天只说“带我开始 Workshop”。页面负责参考、预算、训练、评测与回放，不再逐条发提示词。内置页面未展开时点任务产出中的“网页查阅”。用“继续”在同一账号跨软件接续，多个实验用卡片选择。完整教程见 [学员使用教程](workshop-first-run.md)。

“新机器人接入”等高级任务仍按独立技能处理，不强制走 OriginMan 教程。实际播放以播放器进度为准，不用模型文字或视频链接替代。

本轮支持范围及未测项见交付验收报告；原始分享包不含账号凭据，本机导入包不用于分发。
