# Studio 插件体验测试教程

适用：便携插件0.1.15、OriginMan仿真流程。建议预留30–45分钟；这只是体验安排，不是训练耗时承诺。无需机器人或板卡。

本版适合导师带领试用。已实际验证训练、同源评测、媒体播放与引用恢复；尚不适合无人值守整班交付。短训练不保证效果提升，主线使用已验证参考策略。

## 开始前

- Studio插件中心能看到RDK Robot Learning Platform 0.1.15，且已启用。
- 最终安装目录已完成私人认证配置；插件包本身没有账号或GPU。
- 指定一条正确的学习平台MCP连接，避免旧连接/同名工具串用。
- 具备一个已登记OriginMan模型和在线真实GPU Worker。
- 每次新实验使用新标识，例如`try-originman-001`。同一标识不能覆盖到另一训练。

如果机器没有配置好，先按[插件接入说明](plugin-experiment-handoff.md)安装。下方提示词中的“已确认模型/GPU”必须来自真实查询；不让Agent猜ID。GPU不可用先排障，不能静默切CPU。

## 1. 先确认接入

复制到Studio：

> 使用已配置的机器人学习平台连接，检查目标平台、正式账号身份、可用模型和GPU资源。只做查询，不提交任务、不操作板卡。模型列表只有ID时，用明确OriginMan任务的运行记录和血缘核对模型，不按第一条猜测。把准备使用的模型ID、资源ID和连接名称列出来。

预期：目标服务正确、正式身份已认证、平台ready；明确选择OriginMan模型和一个GPU资源。若模型/资源有歧义，先选定再继续。

不通过：anonymous、要求登录、目标平台不对、资源离线。此时不要继续提交。网页登录不等于MCP连接已经切换成功。

## 2. 看参考体验

> 打开OriginMan的参考仿真或已验证参考报告，让我先看站立和受扰恢复对照。说明这是参考策略还是实时仿真，不提交新训练、不操作板卡。

预期：能看到对应OriginMan内容。没有实时仿真证据时，明确使用参考报告/视频。录屏和离线报告不能记作实时仿真通过。

## 3. 提交一次GPU短训练

> 新实验try-originman-001。使用刚确认的OriginMan模型、GPU资源和连接。先做训练准备检查；缺任务预检接口就如实说明未验证，不反复调用。我授权受控短训练：backend=local，taskId=originman-recovery，profile=standard，engine=originman-recovery-reflect，algorithm=sac，numEnvs=4，maxIterations=32；originmanWorkshop为phase=train、timesteps=8192、seed=7、pushMaxForce=8.1、groupId=try-originman-001、device=cuda。幂等键try-originman-001-train-01。只提交一次，立即保存实验引用，查询原Run至终态；失败保留原Run和日志，不自动降级CPU，不操作板卡。

记录：contextId、训练Run ID、终态、actualTimesteps、trainingDevice、physicsDevice、policySha256。

预期：训练完成8192步；网络训练实际CUDA，物理仿真CPU符合当前引擎设计。资源健康里的cuda=null不等于实际CUDA验收，须看完成Run和Worker计算回执。

当前核心缺少任务预检时，`incomplete / taskEnvironmentVerified=false`是明确限制，不能写成“预检通过”。本步骤是在授权范围内用短训练验证实际执行。

## 4. 换对话，继续同一个实验

在Studio新建对话，输入：

> 使用同一个已配置连接，恢复实验try-originman-001。只读取已保存的原训练引用和实时状态，不选择最新任务、不重新提交训练、不操作板卡。

预期：训练Run ID与步骤3完全一致。恢复依赖本机私有书签和当前正式账号；换电脑不会自动同步。

不通过：返回别的组Run、创建新训练、仅凭旧聊天文本说完成却没有查询。

## 5. 同源评测

> 评测try-originman-001。先恢复准确训练引用，用原模型、GPU资源、引擎、预算、seed、推力、groupId和device提交一次phase=evaluate、sourceRunId=原训练Run、video=true的评测；幂等键try-originman-001-eval-01。保存同源评测引用，查询至完成，重新核对模型、父Run和策略摘要，报告两套对照结果与clearGain。不要操作板卡。

预期：评测Run有独立ID，sourceRunId等于步骤3，策略摘要一致。排队时可暂存明确父Run，但执行摘要尚未验证；终态才核对实际摘要。

注意：OriginMan这里是evaluate Run，不是其他引擎的独立evaluation实体。`evaluations_list`为空不能直接推断没有本次评测。

`completed`表示执行完成。`clearGain=false`也必须如实展示；8192步短训可以比基线差，不能降低门槛或把参考策略当成刚训练的策略。

## 6. 实际回放

> 打开try-originman-001的准确评测视频，使用宿主打开链接能力。MP4不做网页正文抓取，不申请新的截图/系统权限；无法自动观察播放就说明未自动核验，不用隔离浏览器的401推断当前播放器未登录。

先检查恢复回执：`playback.state=recorded`才有视频入口；`missing`表示缺失或生成失败，`blocked`表示评测未成功，保留原评测查日志。`endpointVerified=false、verifiedInPlayer=false`不是播放失败，而是尚未观察播放器。

在Studio播放器点播放，实际检查：

- 打开的是步骤5评测Run的视频。
- 时间从开头推进，机器人画面随时间变化。
- 视频播放到结束，无错误页。

本轮既有验收的视频为6秒；你的实际视频长度以播放器为准。仅返回链接或HTTP200，不算播放验收。浏览器需要正常正式登录；不要把Cookie放进链接或对话。

## 7. 体验失败恢复

### 未保存标识

> 恢复实验try-originman-does-not-exist。没有记录就明确说未保存，不猜最新任务、不提交任务。然后恢复try-originman-001，确认仍为原训练和评测。

预期：第一次明确失败，随后原实验正常恢复，无新任务。

### 错误覆盖保护（可选）

需要另一个**明确存在且属于当前账号的训练Run**。没有就跳过，不凭空填ID或为了测试额外训练。

> 尝试将try-originman-001绑定到我提供的另一个训练Run。预期拒绝覆盖。之后恢复try-originman-001，确认原训练和评测ID未改变。不提交任务、不操作板卡。

预期：明确拒绝，原引用不变。此测试仅验证引用保护；不是模拟GPU宕机或checkpoint自动续训。

评测执行失败、Worker掉线等情况保留原Run和平台日志，人工排障。当前扩展没有自动取消、GPU故障续训或后台调度能力，不把Agent回复结束当成训练停止。

## 8. 填一份体验记录

| 项目 | 记录 |
|---|---|
| 日期、Studio/插件版本 | |
| 连接名称、目标平台、身份已认证 | |
| contextId | |
| 模型ID、资源ID | |
| 训练Run / 评测Run | |
| 实际步数、网络/物理设备 | |
| 父Run和策略摘要是否一致 | |
| clearGain及主要对照数值 | |
| 播放时间推进、结束是否正常 | |
| 未保存标识是否明确拒绝 | |
| 恢复前后ID是否相同、是否产生重复任务 | |
| 卡点、原错误、复现步骤 | |

体验合格标准：接入正确、任务不串组、提交不重复、结果不夸大、回放真实可播、引用失败可解释并能恢复。不要用“RL效果必须提升”代替流程验收。

## 已知不足与本轮测试范围

- Studio仍可能显示“结果尚未验证”；平台Run完成与宿主统一验收提示分开。本轮没有修复Studio本体。
- 当前核心没有完整任务预检接口；插件明确返回未验证。
- 多条同类连接自动消歧、无人值守容量、新手独立完成、Windows和真机均未通过本轮验收。
- 已有实际验收是一个正式账号、串行真实GPU Worker；CPU方式保留，本轮未再次跑CPU或50万步。
- 源码定向测试及包入口门禁不替代实际Studio自然语言与视频播放验收。

开发者回归命令与职责边界见[接入与实验引用说明](plugin-experiment-handoff.md)。本教程不内置任何个人凭据或设备地址。

## 0.1.15新增回归检查

以下故障用隔离fixture测试，不要让新手故意断开共享GPU或重提评测：

| 场景 | 应有行为 |
|---|---|
| 评测排队后失败、没有摘要 | 保留真实failed/blocked/cancelled及summary，指向原评测日志，不误报摘要冲突、不重交 |
| 评测完成却未生成视频 | playback=missing，无视频URL；查看原日志 |
| 平台请求与执行结果的父Run互相矛盾 | 明确拒绝关联，不持久化错误引用 |
| 查询过程中切换账号/平台 | 拒绝返回或保存实验，确认连接后再查询 |

实际已有实验仍应恢复到同一对Run并保持摘要一致。当前故障覆盖不等于GPU宕机自动续训；具体本轮验证范围见更新资料包。

视频回执存在也不证明当前媒体端点可达。recorded表示历史上记录了摘要和字节数；原Worker掉线时仍可能返回503/VIDEO_UNVERIFIED。此时保留原结果，恢复原Worker连接后重新打开同一视频，不重提评测。

版本检查：恢复或指南回执中的`pluginRuntime.version`应为0.1.15，`loadedSourcesMatch=true`。该信息核对当前进程加载的编排模块与本地分发记录，不代表服务端版本或签名认证。若为null或false，刷新旧MCP连接后重试；不能只看插件中心的版本号。

若Studio本轮只暴露`video_generate`，没有学习平台MCP工具：这是宿主任务分支选择问题。新建一个任务，先说“机器人学习平台插件软件诊断”，明确调用已配置连接的`rdk_platform_status`和`rdk_experiment_resume`。成功后再说“机器人学习平台实验结果回看，打开恢复回执的links.video（已有制品，不是创作生成）”。不要靠禁用权限或换匿名平台绕过；这个宿主问题尚未由插件关闭。
