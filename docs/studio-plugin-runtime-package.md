# Studio 自带运行时安装包

为每个桌面目标选择 `plugins/rdk-robot-learning-platform/runtime-downloads.json` 锁定的 Node 归档。构建器会核对归档摘要并从中提取运行时和许可证。

```bash
npm run package:plugin -- --out-dir <制品目录> --studio-target darwin-arm64 --studio-runtime <Node归档>
```

解压 macOS 的 `-studio-<目标>.zip` 后，在 Studio 扩展中心选择「添加 → 导入工具目录」。导入后插件详情显示「打包的 MCP（1）」。Studio 使用导入目录内的 Node 启动 MCP。需要读取账号数据时按 Studio 或平台提示登录。Windows 导入后仍需运行 `setup-studio-windows.cmd`。通用 ZIP 和 Qoder 安装流程沿用各自的 setup。

发布前在空白的正式版 Studio 配置中导入插件，然后移走解压来源。在 PATH 不含 Node 的条件下核对捆绑 MCP 数量为 1、实际启动文件属于 Studio 的导入副本，并调用只读工具。按目标操作系统和架构分别验证。

可在扩展中心停用或卸载插件。旧安装如曾在 MCP 设置中单独登记同名连接，可在 MCP 设置中管理该连接。
