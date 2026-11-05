# Qoder 安装与验收

## 安装

1. 将原始 ZIP 解压到最终目录，保留 `.qoder-plugin`、`.mcp.json` 等隐藏文件。原始包不含账号凭据，移动已配置目录后需要重新配置。
2. macOS 双击 `setup-qoder-macos.command`；Windows 双击 `setup-qoder-windows.cmd`。安装器准备摘要校验的兼容 Node 并生成绝对路径 MCP 配置，Qoder 入口不修改 Studio。已有兼容 Node 可在目录运行 `node setup.mjs --host qoder`。安装器会在该目录生成 `Qoder本机导入包.zip`，包含本机MCP路径。没有平台源码/npm依赖也可运行。
3. Qoder桌面使用“扩展→已安装→添加→上传Plugin”，选择安装器新生成的 `Qoder本机导入包.zip`，不要再上传未配置的原始发行ZIP。Qoder IDE若支持目录导入，可导入已配置的完整目录；Qoder CLI 按当前可执行文件名称运行 `qoder plugins validate /绝对路径/插件`，再在目标项目内运行 `qoder plugins install /绝对路径/插件 --scope local`。国内版命令可能是 `qoderclicn`，先用 `--help` 核对。不要只导入 `.mcp.json` 后声称已经安装全部技能。
4. 新开对话或重载插件，确认出现 `robot-acceptance` 技能及 `rdk_robot_onboarding_guide`、`rdk_robot_acceptance_assess` 工具。MCP服务器键为 `rdk-learning-platform`；无需新建同名重复连接。
5. 先调用 `rdk_classroom_guide` 读取课堂流程，或调用 `rdk_robot_onboarding_guide` 读取接入流程；这些本地工具无需平台登录。检查安装时调用离线 `rdk_plugin_status`，核对实际 `pluginRuntime.version=0.5.1` 与 `loadedSourcesMatch=true`；需要平台数据时再调用 `rdk_auth_status`，未认证使用 `rdk_auth_login` 的浏览器确认入口，再查状态。Qoder账号与RDK平台账号分别验证，不复制Cookie或密码。

官方入口：[CLI 插件](https://docs.qoder.com/cli/plugins)、[IDE 插件](https://docs.qoder.com/extensions/plugins)。安装以当前宿主实际反馈为准。此包不内置Qoder模型账号，也不携带OriginMan权重或实时执行适配器。

## 对话演示

“我们接了一台新机器人。先不运动，读取接入指南，建立逐机验收记录。检查官方接口、SDK和查询频率，核对关节和IMU标定，完成板端纯推理与真实传感影子检查。通信或温度异常时停下并保留故障证据；需要我在旁配合时再提示。”

首次没有设备身份/摘要时，助手应明确缺失，不能伪造。演示可以用单独标注的合成记录验证：完整绑定但没有evidence时interface应missing、后续blocked；更换机器人或模型后旧证据应needs-review；所有返回均motionAuthorized=false。

## 怎样才算验证过

分别记录：宿主版本；实际目录校验、安装与技能发现；实际MCP工具调用；真实平台登录/设备只读结果；实体动作结果。前两项不代表后两项。合成fixture不代表真实设备或账号验收。纯文档检查不叫Qoder对话验证。验收报告必须列出实际执行与未执行范围。

包内 FILES.sha256 和 provenance.json 用于原始分发内容完整性；安装生成的 `.mcp.json` 会改变，配置后不能再按原始包整体摘要判断篡改，也不要再分发私人配置副本。原始 ZIP 应另行保留。

课堂演示提示词：“读取课堂指南，先按离线方式讲清公开资料、项目改造和实测发现；检查这台新机器还缺哪些证据，不连接机器人、不发动作。”

0.5.1默认中文逐题引导：助手先提取你已说的信息，每轮只问一个待补项，允许回答“不清楚”。未知摘要保持待补；由助手核对原文件，不需要学员填SHA或密码。详细资料仅按需展开。

本机导入包仅用于这台电脑，不能转发；保留原始发行ZIP用于分享。变更安装目录后重新运行安装器生成本机导入包。

Mac 升级后先刷新插件连接，用 `rdk_plugin_status` 检查实际进程版本；仅看到安装列表的新版本不能证明运行版本已更新。不清楚的选项可保留待定，长称呼只在回执中缩略，输入原文仍保留。

## 共用实验页与接续

说“带我完成 OriginMan Workshop。”即可从参考仿真开始，再做本组短训练、同源评测和回放。支持实验会话接口的平台会返回本次实验专属页面，显示真实曲线、比较和播放器；在 Studio 或 Qoder 中继续同一明确实验时，重新验证同一账号并恢复原任务，不重复训练。技术标识在详情中查看，不需要学员抄写。

只有平台已保存实验会话才支持跨客户端接续。旧平台仅保留本机引用，插件会如实标注；不要根据安装版本判断平台功能已部署。支持 MCP Apps 的宿主可显示交互面板，其他宿主打开同一实验页。视频开始播放前保持待验证，短训完成不保证策略优于基线。
