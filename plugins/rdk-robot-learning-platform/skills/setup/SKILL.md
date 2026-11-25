---
name: setup
description: 连接当前机器人学习平台，确认正式身份与明确模型，再按真实工具能力执行训练与评测。
---

连接诊断以当前 RDK Robot Learning Platform 插件的 rdk_platform_status 回执为准。先核对返回的 baseUrl、health.ready、session.authenticated 和 canAccessWorkspace；需要版本时调用 rdk_plugin_status。工具目录和旧技能只说明入口，不能证明平台故障。仅在用户明确选择本机部署时检查本机端口或运行旧 CLI。云端连接下，本机 18102 无监听与平台状态无关。若宿主未暴露这些工具，说明当前对话未加载此连接，指引启用或重连插件；不要用旧技能、旧 MCP 或 shell 探针代替已配置的云端连接。仅咨询插件能力时给可用入口，具体工具数量以当前目录为准。

用户说「带我开启 OriginMan Workshop」时调用 `rdk_workshop({intent:'new'})`。Studio 调用 `studio_open_url` 打开右侧工作台，再展示回执里的课程链接。明确受扰恢复时加 `course:'recovery'`。课程入口的地址使用当前平台配置。

这是通用机器人学习插件。首次按用户任务选择仿真与录制、强化学习、模仿学习、评测、回放或部署预检，优先调用 `rdk_learning_guide`。沿用已明确的机型和任务。明确提到 OriginMan Workshop 时用 `rdk_workshop`。继续或看看效果时沿用原 Run 或实验标识。没有原引用时先提供当前账号近期运行的名称、时间和状态，由用户选择。

用户问 OriginMan 舞蹈“下一轮怎么调”时，用 `rdk_learning_guide` 的 `intent:results` 读取原 `runId`，指定第几段时传 `section`。展示对应节拍、实测指标、门槛和建议。只有回执提供 `recommendation.previewArguments` 且用户要求采用时，才用原参数生成改动预览。等待用户确认该预览并要求开始后，再提交新 Run。前后比较同一节拍、同一舞段，并复查其他舞段是否退步。

OriginMan 舞蹈和参考轨迹跟跳使用各自的仿真任务。用 `rdk_originman_reference_track` 打开右侧，预置舞蹈传 `mode=preset`，动作组自由编排传 `mode=blocks`，导入自有轨迹传 `mode=upload`。按回执 `studioNavigation` 打开。用户在页面校验轨迹、选择 Worker 和预算后开始训练。只给 Run ID 或其至少 8 位前缀时用 `rdk_training_status` 查原结果，唯一匹配才按 `studioNavigation` 打开右侧。无匹配或有多条匹配时展示 `studentReply` 并结束。 资料见 [跟跳标定与关节映射](../../references/originman-reference-calibration.json) 和 [跟跳策略契约](../../references/originman-reference-manifest.json)。打开 Workshop 后在舞蹈页面选择预算和共享 GPU，确认后提交。已有实验结果沿用原 Run。

插件安装、自然语言入口、全部 Skill 与 MCP 工具的用户说明见[插件使用手册](../../references/user-guide.md)。

查询账号资产、运行、算力、设备或历史部署时用 `rdk_workspace_inspect`，按[工作区技能](../workspace-data/SKILL.md)选查询范围并说明数据口径。查询具体对象时沿用原 ID。


只咨询预算用途、计数单位或完成标准时，直接调用 `rdk_originman_course_brief`，逐字展示返回的两句 `studentReply` 后结束，不再读指南、目录或历史证据；用户明确追问依据再按需读引用。不能推算或编造计数倍率。


OriginMan Workshop 训练先用 `rdk_originman_training_choice`：未选预算只问一个中文问题；已知快检/8192传quick，正式/50万传formal，不清楚传unknown并暂停。不要默认开训，也不因completed称效果通过。执行与结果标准见[训练技能](../training-runs/SKILL.md)，不重复读取已取得的指南。


课堂准备、教学演示或解释证据，先使用[classroom-rehearsal](../classroom-rehearsal/SKILL.md)与本地 `rdk_classroom_guide`；仅阅读知识无需平台登录。Qoder安装使用 setup-qoder-macos.command / setup-qoder-windows.cmd，不修改Studio。

这是自包含便携插件，不需要平台源码或 npm install。Windows双击setup-windows.cmd，macOS双击setup-macos.command；安装器会准备兼容运行时、生成配置并接入已初始化的Studio。其他宿主导入安装目录的.mcp.json。无须手写凭据。默认不继承宿主账号，不自动选择算力机或连接板卡。需要时提示“连接学习平台”，仅在用户明确要求后发起浏览器授权。需要平台数据或真实任务时先调用 rdk_platform_status，确认目标平台、正式身份和工具目录；导入版本不等于连接已切换。宿主存在旧的同类 MCP 连接时，更新那条连接的启动配置，不绕过认证或随意添加重复连接。

用户说“带我完成 OriginMan Workshop”时，先按任务意图用 `rdk_learning_guide` 逐步引导，详细入口见 [体验流程](../experience-preparation/SKILL.md)。专用工具内部读取课程登记材料并校验，不要求学员填写manifest或UUID。普通训练、CLI或高级配方再读 [训练技能](../training-runs/SKILL.md)；手工登记时使用真实manifest，不自造字段。

任何新机器人接入或换机验收，先使用[逐机验收技能](../robot-acceptance/SKILL.md)；本地指南和证据字段审查无需平台登录，平台数据再按账号连接。

用户连接新OriginMan或要把已有站立模型拿到真机验证时，转到[设备技能](../devices-board/SKILL.md)的OriginMan接入分支；不要直接套用仿真短训或通用策略启动。安装插件、连接设备、模型纯推理和实体站立分别报告。

以实际 tools/list 为准：预检接口缺失时保持未验证，不能声称环境已就绪；可用已支持的模型校验、资源测试和经授权的短训练验证。算力以选定引擎与 Worker 配置为准，实际训练设备以 Run 指标为准；资源名称、CUDA 健康探针和仿真执行设备是不同字段。

提交成功保存 contextId 和原 Run；同源评测使用相同参数、sourceRunId 与独立幂等键。断线后恢复原引用，不自动重交。结果执行完成、效果门和真机资格分别报告。只有宿主实际打开且视频播放后才称回放通过。

实验连续操作先读 ../training-runs/SKILL.md；提交后保存明确contextId，恢复原Run而不是重交。平台版本和引擎以实际工具回执为准。

Studio 有 `studio_open_url` 时使用返回的本轮链接打开右侧工作台；报告页面打开、媒体可用与实际播放时分别依据真实回执。缺少工具或业务读取失败时如实说明，不能把失败报成空列表。受控部署预检被拒绝或设备工具缺失时，保留阻断原因和官方操作入口，不改走终端、SSH 或设备执行工具绕过平台门禁。

宿主安装与连接诊断参考 [客户端接入](../../references/client-setup.md)、[连接契约](../../references/connection-contract.md)、[用户工作流](../../references/user-journeys.md) 和 [仓库能力](../../references/cli-capabilities.md)。便携包优先使用本版安装器与浏览器授权。
