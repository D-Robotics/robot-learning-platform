# Qoder 安装与验收

## 安装

1. 将原始 ZIP 解压到最终目录，保留 `.qoder-plugin`、`.mcp.json` 等隐藏文件。原始包不含账号凭据，移动已配置目录后需要重新配置。
2. macOS 双击 `setup-qoder-macos.command`；Windows 双击 `setup-qoder-windows.cmd`。安装器准备摘要校验的兼容 Node 并生成绝对路径 MCP 配置，Qoder 入口不修改 Studio。已有兼容 Node 可在目录运行 `node setup.mjs --host qoder`。安装器会在该目录生成 `Qoder本机导入包.zip`，包含本机MCP路径。没有平台源码/npm依赖也可运行。
3. Qoder桌面使用“扩展→已安装→添加→上传Plugin”，选择安装器新生成的 `Qoder本机导入包.zip`，不要再上传未配置的原始发行ZIP。Qoder IDE若支持目录导入，可导入已配置的完整目录；Qoder CLI 按当前可执行文件名称运行 `qoder plugins validate /绝对路径/插件`，再在目标项目内运行 `qoder plugins install /绝对路径/插件 --scope local`。国内版命令可能是 `qoderclicn`，先用 `--help` 核对。不要只导入 `.mcp.json` 后声称已经安装全部技能。
4. 在已安装插件里确认版本为 0.6.3；更新后刷新插件连接，再新建空白聊天。无需额外创建同名 MCP 连接。
5. 输入 **带我开始 Workshop**。首次需要平台授权时按浏览器提示确认，返回原对话继续；正常安装后直接在页面选择预算。学员不需要记工具名。Qoder 与学习平台账号分别验证，跨软件接续使用相同学习平台账号。

官方入口：[CLI 插件](https://docs.qoder.com/cli/plugins)、[IDE 插件](https://docs.qoder.com/extensions/plugins)。安装以当前宿主实际反馈为准。此包不内置Qoder模型账号，也不携带OriginMan权重或实时执行适配器。

## 学员入口

新建空白聊天只说“带我开始 Workshop”。助手静默打开内置工作台后只给一句提示和入口。顶部四步进度负责定位，页面负责参考、预算、训练、评测与回放，不再逐条发提示词。内置页面未展开时点任务产出中的“网页查阅”。用“继续”在同一账号跨软件接续，多个实验用卡片选择。完整教程见 [学员使用教程](workshop-first-run.md)。

“新机器人接入”等高级任务仍按独立技能处理，不强制走 OriginMan 教程。实际播放以播放器进度为准，不用模型文字或视频链接替代。

本轮支持范围及未测项见交付验收报告；原始分享包不含账号凭据，本机导入包不用于分发。

## 维护者诊断

按需使用离线 `rdk_plugin_status` 核对实际加载版本 0.6.3 和 `loadedSourcesMatch=true`；业务连接再核对认证状态。逐机接入、离线课堂与硬件验收仍使用各自技能，不插入默认 Workshop。IDE/CLI 与连接细节见 [客户端接入](client-setup.md)。
