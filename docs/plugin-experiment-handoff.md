# 插件实验接续与宿主接入

插件扩展负责组合调用和实验引用；平台继续执行账号隔离、权限、幂等和训练/评测业务校验。Studio 本体不包含机器人专属流程。

## 实验引用

提交训练成功后，用新的明确 `contextId` 调 `rdk_experiment_remember({contextId, runId})`；评测提交后附 `evaluationRunId`。`rdk_experiment_resume({contextId})` 每次重新查询原 Run，不选最新任务、不重交。书签以平台、正式账号和实验标识的摘要隔离，文件仅含 Run 引用，私有目录 0700、文件 0600；换电脑不会自动同步。

排队中的 OriginMan 评测可以根据平台请求里的明确父 Run 暂存引用，`association.executionVerified=false`；终态必须重新校验模型、父 Run 和策略摘要。源不一致、摘要变化、404、账号缺失或冲突绑定均拒绝，不回退其他任务。未声明来源契约的引擎不能猜测关联。

## 接入与版本

`build-workflow-plugin.mjs` 将当前编排扩展组合到已封存的便携核心；要求未配置输入和核心摘要匹配，保留来源与许可证。输出包含通用实验工具及可选课程工具；不能把扩展版本当成平台服务端版本。

先导入未配置包，再在最终安装目录运行 `configure.mjs`，通过私人文件或标准输入设置现有认证。配置后的包不得再次分发。宿主有旧的同类 MCP 连接时，更新原连接的启动参数并刷新连接；只看到插件版本更新不能证明 MCP 已切换。不要改其他连接或放宽审批策略。

先调用 `rdk_platform_status`，核对目标服务、正式身份和实时工具目录。核心缺少任务预检时，准备工具返回 `incomplete`，不调用不存在的接口、不将资源在线当作环境或 CUDA 已验收。真实计算设备以完成 Run 和 Worker 计算回执为准。

## 回放和失败

恢复工具返回视频入口不表示已打开或播放。使用宿主打开链接能力；MP4 不调用网页正文抓取。无正文、抓取超时或隔离浏览器的 401 不代表当前播放器未登录。没有播放器观测能力就报告未自动核验，不为补证申请新的系统权限。OriginMan 的 evaluate Run 不等于独立 evaluation 实体。

MCP 请求结束或取消不等于后台训练停止。本扩展不提供后台调度、训练取消、自动调参或真机资格。GPU 不可用应报告，不自动降级 CPU；显式 CPU 方式保留。执行完成、质量门和真机效果分别报告。

## 验证

定向行为测试：`node --test scripts/plugin-experiment.test.mjs scripts/plugin-experience.test.mjs scripts/plugin-workflow.test.mjs scripts/export-studio-plugin.test.mjs`。

包入口门禁：在项目支持的 Node 版本下运行 `node scripts/verify-platform-plugin.mjs`。宿主验收还需实际导入、正式身份、自然语言提交与恢复、同源评测和视频播放；测试通过不能替代这些步骤。

## 人工体验验收

照着执行的自然语言提示词、逐步通过标准和记录表见[Studio插件体验测试教程](plugin-experience-test.md)。

## 失败评测和媒体状态

评测失败、阻塞或取消且没有执行摘要时，保留平台原状态和summary，建议读取原评测日志，不误报摘要冲突。若平台请求和执行结果的来源矛盾或已提供摘要确实不一致，仍拒绝关联。恢复结束前再次确认平台与正式身份，变化时不返回或保存引用。

回放只有在同源完成执行、明确视频SHA256和正字节数均存在时提供入口。`playback.state`区分recorded、missing、blocked、pending，`verifiedInPlayer`始终为false；视频实际播放仍由宿主确认。缺视频不自动重提评测。

视频回执存在也不证明当前媒体端点可达。recorded表示历史上记录了摘要和字节数；原Worker掉线时仍可能返回503/VIDEO_UNVERIFIED。此时保留原结果，恢复原Worker连接后重新打开同一视频，不重提评测。

版本诊断：`pluginRuntime.version`仅在本进程加载时的编排源码摘要与分发provenance一致时返回，旧进程不能靠磁盘文件被替换冒充新版本。它不核验平台服务端版本或签名；没有分发记录时明确返回未验证。
