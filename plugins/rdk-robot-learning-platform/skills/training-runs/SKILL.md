---
name: training-runs
description: 在 RDK 学习平台选择任务、训练引擎与执行资源，提交训练并跟踪 Run、日志和重训建议；也支持仓库已有的模仿学习和强化学习 CLI。
---

只咨询预算用途、计数单位或完成标准时，直接调用 `rdk_originman_course_brief`，逐字展示返回的两句 `studentReply` 后结束，不再读指南、目录或历史证据；用户明确追问依据再按需读引用。不能推算或编造计数倍率。


## OriginMan 自定义舞蹈

用户要求训练跳舞时使用独立舞蹈链路，不调用受扰恢复的预算选择、训练或评测工具。先 `rdk_experience_guide` 取得 `danceTraining.operation.contextId`，核对用户明确的资源，再调用 `rdk_originman_dance_train`。`modelId` 可省略，工具按专用契约查找或登记；不必先调用 draft，只有用户要求整理草案时才用它。

当当前任务已经是舞蹈时，即使用户只说“带我开始/重新开始 Workshop”，也保持舞蹈意图：新一轮先取得新 `contextId`，沿用当前对话确认过的编舞；有已知活动 Run 时“继续/看看效果”只读查询原 Run，不展示旧结果冒充新一轮，也不重复提交。提交回执、`rdk_training_wait` 和 `rdk_training_status` 都应附带并打开该 Run 的只读详情页；页面按 Run ID 请求平台记录，账号无权查看时明确显示原因，不回退到全局最新记录。

训练参数结构如下，数值必须保留用户要求；此例只说明字段名：

```json
{"contextId":"来自本轮guide","computeResourceId":"已确认资源","dance":{"schemaVersion":1,"title":"简单摆臂","bpm":100,"sections":[{"type":"alternating-arms","beats":8,"intensity":0.25}],"seed":7,"trainingSteps":500000}}
```

舞段类型为 `alternating-arms`、`weight-shift`、`squat-rise`、`open-pose`；每段 `beats` 为 4/8/16，`intensity` 为 0.25–1。预算字段是 `trainingSteps`；draft 接收 `dance` 内的配置对象，不接收外层引用或返回草案的派生字段。工具参数校验失败时按错误中的结构修正，不能反复猜字段。提交取得 Run 后仅对原 Run 使用 `rdk_training_wait`、`rdk_training_status`，失败或引用未知时不换 contextId 重交。

结果核对本轮 `metrics.originmanDance.qualityGatePassed` 与各 BPM 的舞段成绩。出现平台返回的同源 `links.danceVideo` 时用宿主播放器打开本次仿真视频；实际播放和训练、风格达标分别报告。没有媒体链接时保留原结果，不构造未验证的媒体地址，也不为补回放重新训练。舞蹈仿真通过不授权真机部署。

## OriginMan 受扰恢复训练预算与结果口径

默认“开始 Workshop / 继续 / 看看效果”直接使用 `rdk_workshop` 打开按钮工作台，预算在页面选择；不要在聊天重复问。以下仅用于用户明确的高级手动或独立训练：先调用 `rdk_originman_training_choice`。用户未选择预算时传空参数，只展示返回的一个中文选择题并等待；不要默认短训。已明确“快检/短训/8192”传 `choice=quick`，已明确“正式/50万”传 `choice=formal`，不重问。回答“不清楚”传 `choice=unknown` 并暂停，不能自动提交。用户说先不开始时只记录选择。

预算单位是训练步：8192 步不是8192次优化或外层迭代。旧进度字段iteration也可能记录步数，按本引擎回执说明单位。

8192 步快检只验训练→评测→回放链路，可能比基线差；50 万步正式效果实验用 `rdk_originman_train({contextId,timesteps:500000})` 和 `rdk_originman_evaluate`，不能落到固定短训工具。预算改变须新实验，原实验用工具返回引用恢复，不手抄或猜 UUID。完整 Workshop 仍先看基础 PD 参考，再按已选预算执行。

分别报告：流程执行是否完成、同源仿真效果是否达到收益判据、实体效果是否验证。`completed` 仅说明执行结束。必须读取本轮 `rdk_originman_evaluation_read`，核对来源、两组条件与 original/tuned/rl 实际恢复数；`clearGain=false` 明确“效果未达标”，无评测或来源未核对保持待验证，仿真成功不代表真机成功。历史结果不能当本组成绩。正常回答三句以内加实验页链接；历史解释只在追问时读 [预算对照证据](../../references/workshop-training-evidence.md)，不要重复读整包。


# 训练与 Run

用户要求完整 OriginMan Workshop 时，使用 [体验流程](../experience-preparation/SKILL.md)：调用rdk_workshop后由页面负责参考、预算和后续步骤；不再把下述高级工具串成默认学员流程。用户明确只要求训练时按其范围执行。

## 通用 Sim2Real 训练门禁

用户训练新任务且目标包含真实机器人时（不限定舞蹈或机型），先明确任务成功指标、失败/停止条件和目标机器人配置；沿用机器人已有硬限制，不让任务参数覆盖关节范围、动作变化率、反馈时效或急停规则。提交前对已选资源调用 `rdk_training_prepare`，确认Worker健康、任务环境和训练引擎就绪；该预检只准备参数，不提交训练。

训练结束后，以同一策略摘要和仿真配置绑定独立评测。除任务专属成功指标外，检查留出场景/种子、仿真到实机相关扰动、动作边界、失败恢复和策略/环境版本是否有证据。使用 `rdk_robot_acceptance_assess` 的 `simulation` 阶段记录这些通用迁移证据；仅 `documented` 表示字段覆盖完整，不代表原始收据已核实、仿真足够逼真或策略可上机。缺证据或有任一项失败时保持待验证/受阻，给出具体缺项。

只有仿真评测通过后，才进入目标设备只读检查和零致动 `shadow` 验证；再按平台/板端门禁逐级请求实体测试。训练、仿真评测和准备检查都不授权实体动作。不同任务只替换任务指标，不复制舞蹈专属动作、BPM或关节参数；逐机身份与标定仍单独绑定。

收到 stopWorkflow=true 后停止新提交；已有 Run 继续按原引用只读恢复，未取得提交回执则保持未知。不能把引用保存失败说成尚未提交，不能换 contextId、资源或参数重交。普通结果使用 studentReply，技术明细按需展开。

平台或硬件交付类验收才读取 [分层验收流程](../../references/workshop-acceptance.md)。OriginMan 仿真课程不要求板端纯计算或实体运动验收。

交付单次可追踪的训练请求和 Run 状态，完成时绑定真实产物。读 [训练/评测/部署契约](../../references/workflow-contracts.md)；参数查 [工具目录](../../references/tool-catalog.md)。

用户说“用我的轨迹训练并部署”时按 [用户工作流](../../references/user-journeys.md) 先核对真实数据与训练路径。登记 dataset/传入 datasetIds 只保留来源关联，不保证当前执行器读过这些字节；ACT/BC/DP 的 synthetic-smoke 不能替代用户数据。远程 Agent 没有输入文件时先准备明确的上传/挂载，不凭路径字符串猜数据已到 worker。

1. 确认用户任务、模型、数据、预算和目标设备。用 `rdk_models_list`、`rdk_datasets_list`、`rdk_golden_path` 找可用资源。
2. `rdk_compute_resources_list` 后对选中的 `computeResourceId` 调 `rdk_compute_resource_test`。训练后端和引擎是两项；支持范围取当前资源、worker 配置及任务包，不把已存在的 Python 训练器当作已注册到所有 worker。
3. `rdk_training_submit` 显式传实际 `modelId`、`taskId`、`projectId`、`datasetIds`、`computeResourceId`（适用时）、`backend`、`engine`、`profile` 及预算。默认 backend 是 local、profile 是 smoke；用户要求真训练时先确认 worker 不是 Mock。未知 backend 和本工具不支持的轨迹路径/续训/嵌套 training 字段会在任何请求前拒绝；不改成另一路径重试。读取返回的 `resolvedTraining` 与 `defaultsApplied`，说明所选模型与预算，避免缺参默认首模型被误认成用户选择。用稳定 `idempotencyKey`，提交一次保存返回 `runId`。
4. 用 `rdk_training_status(runId)` 查状态、`rdk_run_logs(runId, after)` 增量读日志。等待间隔随耗时调整，不为查进度再次 submit。结束后查 `rdk_artifacts_list`、`rdk_lineage_get`；再用 `rdk_retraining_advice` 辅助诊断。

## 实验接续（有扩展工具时）

提交成功后，为本次训练选择一个新的明确 `contextId`（ASCII字母数字、点、下划线或短横线），调用 `rdk_experiment_remember({contextId, runId})`。它只保存当前平台和正式账号下的任务引用，不提交训练。新训练必须使用新标识，不能覆盖旧训练。

用户说“继续这个实验”时，用已明确的标识调用 `rdk_experiment_resume({contextId})`；标识不明确时询问，不猜全局最新Run。它会实时核对权限和状态；404、失效登录、blocked都保留失败，不自动重交。书签保存在当前系统用户的私有目录，不保存账号原文或凭据；换电脑不会自动同步。

评测仍使用平台现有提交工具与原训练参数。提交后用同一标识调用 `rdk_experiment_remember({contextId, runId, evaluationRunId})`，核对父Run、模型及策略摘要后才建立关联。未知引擎的评测来源没有明确字段时，保留独立Run，不能猜测已关联。

恢复工具提供的工作台链接不保证自动选中Run；视频入口也不保证文件已生成。用户要求打开时复用宿主打开接口，实际核对登录、Run和播放；不能仅凭链接说已播放。不能把MCP请求取消等同于后台训练停止。此扩展不提供后台自动轮询、训练取消或真机部署。

训练运行完成不等于质量门通过或可上板。平台、worker 或引擎拒绝时报告原因和残留 Run；不换成 Mock 伪装成功。改变任务/参数才创建新的逻辑操作键。没有资源、模型或可用数据时先完成准备，不擅自启动计费资源。

提交响应中的 `dataUsage.consumptionVerified=false` 表示它没有证明用户数据被消费；`syntheticData.confirmed=null` 表示尚无来源证据，`builtinSmokePath` 只提示当前仓库内置包装的风险，不推断自定义 worker 的实际输入。`status=blocked|failed` 与 `summary`/`note` 原因优先于“请求已登记”，不要把登记成功说成训练已启动。

训练提交只接受 schema 声明的平铺字段及 `idempotencyKey`。额外的 `learningRate`、`seed` 等未公开参数会明确拒绝，不能报告调优生效；字符串/布尔/数值类型必须匹配，例如 `numEnvs` 使用 JSON 数字，不能传 `"16"`。显式无效模型/profile 不会回退默认任务。更细超参用当前引擎 CLI 的真实参数，在同数据、seed、split 和协议下对比；查看留出结果用于调参后，该留出集属于开发评估，最终质量需新独立数据。

仓库 CLI 完成真训练后，报告输入摘要、输出模型/ONNX/验证结果及它们与平台实体的实际关联。离线产物不会自动生成符合发布证据的 completed non-Mock local Run；缺少这条证据时明确停在离线学习结果阶段，不能登记 contract 演练或手改状态冒充可发布 Run。

MCP 无训练取消/续训专用工具。用户取消时停止继续提交和轮询；通过真实工作台/API 查询已提交任务能否取消，不把 MCP `notifications/cancelled` 当成 Run 已停止。续训和更细的 CLI 超参先读实际引擎接口。执行资源 CRUD、运行关联/中继等没有专用 MCP 工具的操作走 [版本化 API 工作流](../../references/api-workflows.md)。

引擎、任务包、自定义奖励、GPU 接入、LeRobot、足球和循环策略的可用仓库入口见 [仓库能力](../../references/cli-capabilities.md)。凭据与执行器路径从部署环境读取，不进入请求 manifest 或共享产物。

真实浏览器示教 BC：提交时指定 `engine=offline-bc`、`demonstrationRunId` 和真实 local worker。平台冻结 observation/action 字节与摘要，校验同账号、同模型和维度；完成后核对数据消费回执与 ONNX。录制必须配对同一次推理前输入和输出，避免当前动作泄漏到 last_action 槽。闭环评测需新 reset，覆盖站立、前进、转向及 zero/参考对照；拒载或跌倒保留失败，不绕过验证器。

模型列表若只返回 ID，不按第一个条目猜模型。用明确 taskId 的运行记录与同一 modelId 的血缘/契约交叉核对；需要校验 manifest 时使用真实登记原文，不能自造不完整字段。宿主未提供文件读取能力时，不能声称已读插件引用。

可选准备工具的能力以当前 tools/list 为准。核心没有任务预检时返回未验证；不要反复调用不存在的接口。queued 评测可能尚无执行摘要：按平台明确 sourceRunId 暂存引用，并在终态重新核对摘要，不把排队关联当作执行验证。

视频回放只用宿主打开链接能力，不对 MP4 调用“网页正文抓取”。抓取超时或没有正文不能推断 401、登录墙或播放器未加载；仅有明确 HTTP/页面证据才报告认证问题。宿主没有播放器观测能力时说明“入口已打开，工具未自动核验播放”，不要为补截图申请新的系统权限或循环重试。OriginMan 的 evaluate Run 不是独立 evaluation 实体，不能把 evaluations_list 为空当作没有评测。

恢复结果的`playback.state=recorded`只说明有历史视频回执，`endpointVerified=false、verifiedInPlayer=false`仍要求宿主实际播放确认。`missing`时不生成视频入口，不自动重交评测；`blocked`时先看原评测summary和日志。评测failed/blocked/cancelled而没有执行摘要，不应误称策略摘要冲突；父Run或已提供摘要确实不一致时仍拒绝关联。查询期间账号或目标平台变化，整个恢复停止，不保存引用。

视频回执存在也不证明当前媒体端点可达。recorded表示历史上记录了摘要和字节数；原Worker掉线时仍可能返回503/VIDEO_UNVERIFIED。此时保留原结果，恢复原Worker连接后重新打开同一视频，不重提评测。

## OriginMan 学员短训

首次流程读 [学员安装、登录与恢复](../../references/workshop-first-run.md)，完整课程契约见
[OriginMan manifest](../../references/originman-manifest.json)。首次短训核对当前账号的模型和资源，
不依赖历史成功 Run；资源通过准备后才按需要登记课程模型。多个资源按名称让学员选择，
不给学员技术 UUID 填写题。保留提交记录与原 Run，提交结果未知不重交。

回放优先打开 `experiment_resume.links.experiment`；旧平台没有此链接时才用 `links.workbench`，按 `selection` 核对训练与评测 Run 并展开播放器；不要把原始 WebM/MP4 当新网页导航。页面不保证自动选择本次Run，不能用全局最新结果代替。用户要求先看参考时，先在课程仿真页启动并观察基础PD，再训练；页面打不开先排查。截图与诊断日志写入独立验收目录，不写入学员项目，也不清理无关文件。

普通课堂结果优先使用工具 `studentReply`，详细数据在实验页查看；用户要求技术明细时再展开，不默认输出参数、摘要和英文套件表。
