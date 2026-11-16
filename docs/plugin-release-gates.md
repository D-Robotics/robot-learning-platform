# 插件授权发布门禁

构建器在生成文件摘要之前，对输出目录中的实际 `scripts/plugin-auth.mjs` 执行认证生命周期回归。门禁失败时构建以非零状态退出，不输出成功回执；失败目录不能作为安装包分发。

```bash
node scripts/verify-plugin-auth-release.mjs --plugin-dir <便携插件目录>
```

门禁复用认证测试，要求至少 18 项全部通过，不接受失败、跳过或取消。包括只读状态查询、已确认授权领取、MCP 授权对象重建、实际 Node 进程退出后继续领取、重复登录、过期、网络故障、退出竞争和异常身份回执。测试只使用隔离合成账号与临时私人目录，不读取用户登录缓存或提交真实训练。

工具通过 `RDK_PLUGIN_AUTH_TEST_MODULE` 将测试指向输出包的授权模块；这是测试入口，不影响产品运行时。构建回执的 `authorizationGate` 表明生成包通过本组回归。它不证明反馈者账号已恢复，也不替代原生 Windows、Studio 登录继承、双真实账号、GPU 隔离或真实媒体播放验收。

此门禁用于阻止候选分支遗漏已交付的 0.3.2 修复。合并新功能前应继承 main 的相关修复，版本号增加不能替代行为回归。平台和 Worker 的配套更新仍须按各自发布门禁独立部署。

## Studio 直接导入包

为每个桌面目标选择 `plugins/rdk-robot-learning-platform/runtime-downloads.json` 锁定的 Node 归档。构建器会核对归档摘要并从中提取运行时和许可证。

```bash
npm run package:plugin -- --out-dir <制品目录> --studio-target darwin-arm64 --studio-runtime <Node归档>
```

`-studio-<目标>.zip` 供支持插件相对路径的 Studio 使用。解压后从扩展中心导入插件目录即可。包内记录所带 Node 的平台、版本和摘要，并保留浏览器登录流程。通用 ZIP 和 Qoder 安装流程沿用各自的 setup。

发布前应在空白 Studio 配置中验证导入，在操作系统 PATH 不含 Node 的条件下确认捆绑 MCP 数量为 1、连接工具可发现、首次认证状态正确。再移动安装来源并复核解析到的是导入目录内的 Node 和脚本。macOS 与 Windows 的签名、权限和实际运行分别验收。
