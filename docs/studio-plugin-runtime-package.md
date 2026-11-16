# Studio 自带运行时安装包

为每个桌面目标选择 `plugins/rdk-robot-learning-platform/runtime-downloads.json` 锁定的 Node 归档。构建器会核对归档摘要并从中提取运行时和许可证。

```bash
npm run package:plugin -- --out-dir <制品目录> --studio-target darwin-arm64 --studio-runtime <Node归档>
```

解压 `-studio-<目标>.zip` 后，在 Studio 扩展中心导入并启用该目录，再运行解压目录里的 `setup-studio-macos.command` 或 `setup-studio-windows.cmd`。安装器核对导入副本并配置机器人学习 MCP，使用包内校验过的 Node。首次连接按浏览器提示登录。通用 ZIP 和 Qoder 安装流程沿用各自的 setup。

发布前在空白的正式版 Studio 配置中完成导入和安装，然后移走解压来源。在 PATH 不含 Node 的条件下核对捆绑 MCP 数量为 1、实际启动文件属于 Studio 的导入副本、MCP 工具可用、首次认证状态正确。macOS 与 Windows 分别验证。

正式版 Studio 将插件开关和 MCP 连接开关分别保存。需要停用时，也在 MCP 设置中停用 `rdk-robot-learning-platform`。卸载前，先在 MCP 设置中删除该连接，再卸载插件，避免留下指向旧安装目录的入口。
