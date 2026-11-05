---
name: setup
description: 连接当前机器人学习平台，确认正式身份与明确模型，再按真实工具能力执行训练与评测。
---

用户说“带我开始 Workshop”“继续”或“看看效果”时优先使用 `rdk_workshop`，打开带按钮的工作台；不要先问预算或启动旧多工具编排。课程入口见 [体验流程](../experience-preparation/SKILL.md)。高级操作仍按用户明确请求处理。


只咨询预算用途、计数单位或完成标准时，直接调用 `rdk_originman_course_brief`，逐字展示返回的两句 `studentReply` 后结束，不再读指南、目录或历史证据；用户明确追问依据再按需读引用。不能推算或编造计数倍率。


OriginMan Workshop 训练先用 `rdk_originman_training_choice`：未选预算只问一个中文问题；已知快检/8192传quick，正式/50万传formal，不清楚传unknown并暂停。不要默认开训，也不因completed称效果通过。执行与结果标准见[训练技能](../training-runs/SKILL.md)，不重复读取已取得的指南。


课堂准备、教学演示或解释证据，先使用[classroom-rehearsal](../classroom-rehearsal/SKILL.md)与本地 `rdk_classroom_guide`；仅阅读知识无需平台登录。Qoder安装使用 setup-qoder-macos.command / setup-qoder-windows.cmd，不修改Studio。

这是自包含便携插件，不需要平台源码或 npm install。Windows双击setup-windows.cmd，macOS双击setup-macos.command；安装器会准备兼容运行时、生成配置并接入已初始化的Studio。其他宿主导入安装目录的.mcp.json。无须手写凭据。需要平台数据或真实任务时先调用 rdk_platform_status，确认目标平台、正式身份和工具目录；导入版本不等于连接已切换。宿主存在旧的同类 MCP 连接时，更新那条连接的启动配置，不绕过认证或随意添加重复连接。

用户说“带我完成 OriginMan Workshop”时，直接使用 [体验流程](../experience-preparation/SKILL.md)。专用工具内部读取课程登记材料并校验，不要求学员填写manifest或UUID。普通训练、CLI或高级配方再读 [训练技能](../training-runs/SKILL.md)；手工登记时使用真实manifest，不自造字段。

任何新机器人接入或换机验收，先使用[逐机验收技能](../robot-acceptance/SKILL.md)；本地指南和证据字段审查无需平台登录，平台数据再按账号连接。

用户连接新OriginMan或要把已有站立模型拿到真机验证时，转到[设备技能](../devices-board/SKILL.md)的OriginMan接入分支；不要直接套用仿真短训或通用策略启动。安装插件、连接设备、模型纯推理和实体站立分别报告。

以实际 tools/list 为准：预检接口缺失时保持未验证，不能声称环境已就绪；可用已支持的模型校验、资源测试和经授权的短训练验证。默认 GPU，CPU 必须显式选择；GPU不可用不自动降级。训练 device=cuda 不表示物理仿真也在 GPU。

提交成功保存 contextId 和原 Run；同源评测使用相同参数、sourceRunId 与独立幂等键。断线后恢复原引用，不自动重交。结果执行完成、效果门和真机资格分别报告。只有宿主实际打开且视频播放后才称回放通过。

实验连续操作先读 ../training-runs/SKILL.md；提交后保存明确contextId，恢复原Run而不是重交。默认GPU，CPU必须显式选择。平台版本和引擎以实际工具回执为准。

宿主安装与连接诊断参考 [客户端接入](../../references/client-setup.md)、[连接契约](../../references/connection-contract.md)、[用户工作流](../../references/user-journeys.md) 和 [仓库能力](../../references/cli-capabilities.md)。便携包优先使用本版安装器与浏览器授权。
