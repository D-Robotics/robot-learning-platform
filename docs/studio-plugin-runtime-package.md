# Studio 自带运行时安装包

同一份 `-studio-universal.zip` 适用于 Windows x64 和 Apple 芯片 Mac。安装器会自动加载对应的 Node.js 运行时。

把 `plugins/rdk-robot-learning-platform/runtime-downloads.json` 锁定的 `win32-x64` 和 `darwin-arm64` Node 归档按原文件名放进同一目录。构建器会核对两份归档的摘要，提取运行时和许可证，并将两种系统的安装入口打进同一份 ZIP。

```bash
npm run package:plugin -- --out-dir <制品目录> --studio-universal-runtime-dir <Node归档目录>
```

仍可按单个目标构建较小的安装包。

```bash
npm run package:plugin -- --out-dir <制品目录> --studio-target darwin-arm64 --studio-runtime <Node归档>
```

解压后，在 Studio 扩展中心导入并启用插件目录。Windows 双击 `setup-studio-windows.cmd`，macOS 双击 `setup-studio-macos.command`。安装器核对导入副本，用包内的 Node 配置机器人学习 MCP。首次连接按浏览器提示登录。基础插件 ZIP 和 Qoder 安装流程沿用各自的 setup。

发布前在空白的正式版 Studio 配置中完成导入和安装，然后移走解压来源。在 PATH 不含 Node 的条件下核对 Studio 只创建一个机器人学习 MCP 连接，启动文件来自导入副本，工具可用，首次认证状态正确。按实际验收过的系统和架构记录结果。

正式版 Studio 将插件开关和 MCP 连接开关分别保存。需要停用时，也在 MCP 设置中停用 `rdk-robot-learning-platform`。卸载前，先在 MCP 设置中删除该连接，再卸载插件，避免留下指向旧安装目录的入口。
