# RDK Robot Learning Platform 插件使用说明

**版本：0.6.32** · 适用：Qoder、RDK Studio，以及支持 MCP 与 Markdown 链接的 Agent 宿主。

这是通用机器人学习平台的跨宿主插件，支持按机型和任务组织学习流程。OriginMan 舞蹈和受扰恢复是可选任务。

本手册说明插件能做什么、如何安装连接、常见任务怎么说、每个 Skill 和 MCP 工具负责什么，以及结果应如何判读。学员日常使用自然语言即可；工具名和 ID 主要供维护者排查。每次操作仍以当前平台实际返回的 `tools/list`、账号权限和运行结果为准。

## 1. 插件能做什么

- **训练与评测**：提交平台训练、查询状态和日志、读取质量门、评测、血缘和重训建议；也可按仓库已有能力训练 ACT、BC、DP、SmolVLA 等任务。
- **数据、模型和项目**：查看或登记项目、数据集和模型，检查 manifest、Run、制品、评测以及来源关系。
- **仿真与遥测**：打开浏览器仿真、查看轨迹和遥测、回放运行证据。
- **设备与机器人**：发现和连接 RDK 设备，读取板端健康与策略状态，指导逐机验收；在平台门禁与明确授权允许时使用受控策略或 D6A 机械臂工具。
- **制品与部署流程**：查询制品，做部署预检、查看历史和版本计划、执行已授权的受控生命周期操作。
- **官方资料、课堂与平台运维**：查 RDK 官方手册、分步引导新学员或新机器人、做健康/就绪/发布前预检和平台开发。
- **Workshop 学习流程**：打开课程工作台，查看参考，选择算力和预算，训练、同源评测、查看曲线、比较轮次与回放。
- **OriginMan 舞蹈训练**：独立 PPO 仿真链路；编排动作、核对专用模型契约与训练资源、提交单次 Run，并直达该 Run 的详情页。

插件的工具目录包含平台工具和课程、连接、工作流扩展。部分工具受宿主、平台部署、登录身份、权限或设备适配器限制；列表中有工具不等于当前环境具备其依赖。

## 2. 安装与更新

### Qoder

1. 把发行 ZIP 解压到会长期保留的目录，保留隐藏文件。
2. macOS 双击 `setup-qoder-macos.command`；受支持的 Windows x64 环境双击 `setup-qoder-windows.cmd`。安装器准备兼容 Node，并生成本机 MCP 配置和 **Qoder本机导入包.zip**。
3. Qoder Desktop 进入“扩展 → 已安装 → 添加 → 上传 Plugin”，选择安装器生成的本机导入包。不要上传未配置的原始发行 ZIP，也不要把带本机路径的导入包转发给他人。
4. 更新插件后刷新插件连接，再新建空白聊天。无需另建同名 MCP 连接。
5. 用“检查插件版本”或 `rdk_plugin_status` 确认版本与 `loadedSourcesMatch=true`。

### RDK Studio

1. 解压发行 ZIP 到最终目录。
2. macOS 双击 `setup-macos.command`；Windows 双击 `setup-windows.cmd`。
3. 在已初始化的 Studio 中导入/启用生成的插件。按需使用宿主账号继承；默认浏览器授权只连接本插件。

### 其他 MCP 宿主

运行插件安装器后，将安装目录里的 `.mcp.json` 接入宿主，并按宿主要求重启 MCP。安装器生成的配置含本机绝对路径，不可直接复制到其他机器。不同宿主支持的技能、内置浏览器导航和媒体播放能力不同。

### 登录与账号

- 未登录时说“连接学习平台”或“登录学习平台”，在浏览器完成授权，再说“检查平台连接”。
- 说“切换学习平台账号”开始切换；确认当前账号后再查询机器和运行。
- 说“退出学习平台”只退出本插件连接；Studio 的宿主账户须在 Studio 账号菜单管理。
- 不要在聊天里发送密码、Cookie、SSH 私钥或 Runner Token。账号凭据只进入对应平台或本机授权入口。

## 3. 快速开始

### Workshop：受扰恢复课程

在新聊天中说：

> 带我开始 Workshop

默认课程是 OriginMan 仿真受扰恢复：看讲师参考，在页面选择算力和预算，明确点击开始后才训练；随后平台对同一策略做仿真评测。页面可以查看训练曲线、基线对比、轮次、日志和回放。默认入口只准备工作台，不会因打开课程而自动训练。

- **继续**：接续当前账号已选实验，查询原 Run；不会重新提交。
- **看看效果**：直接打开本轮结果和质量证据。
- **开始新实验 / 改一个参数再试**：保留旧实验，复制成新实验后只调整已确认的变量。
- **换算力机**：明确说“用「机器名称」开始 Workshop”；新实验才会使用新资源。
- **暂停后续步骤**：只暂停自动接续，不会取消已经提交的 Worker 任务。

预算选择：8192 步适合确认流程链路，不保证效果；50 万步是正式预算选项，不等于质量通过。自定义预算、seed 或扰动配置须先检查页面展示的配方并确认。

### OriginMan 强化学习跳舞

| 你可以这样说 | 插件会带你做什么 |
| --- | --- |
| “重新开始，我想训练 OriginMan 跳舞” | 保留舞蹈目标，准备新实验，再补齐编舞、算力和预算。 |
| “用我这台电脑跑” | 显示本机算力的接入状态和执行资源入口。提交后在 Run 查看实际设备。 |
| “看看这轮效果” | 打开这条 Run 的进度、曲线、分段结果和可用回放。 |
| “保持编舞，把这轮改成 50 万步再训” | 从原 Run 读取配方，显示改动，确认后提交新 Run，并给出两条运行链接。 |

明确表达任务，避免沿用默认受扰恢复课程：

> 我要训练 OriginMan 强化学习跳舞，不做平衡或扰动恢复。欢快版：交替摆臂 8 拍、左右换重心 8 拍、下蹲起身 8 拍、展开定格 8 拍；128 BPM，强度 0.85。

插件会沿舞蹈专用 PPO 流程处理，不调用恢复课入口。舞蹈目标范围：每段 4/8/16 拍，80–140 BPM，1–8 段，强度 0.25–1，总长不超过 128 拍；默认 50 万训练步、8 个并行环境。8192 步只用于用户明确要求的链路快检。缺资源、契约或 Worker 引擎证据时停止，不改跑其他任务。

提交后会提供当前 Run 的平台链接；Qoder 可自动打开并置前，其他宿主显示可点击链接。详情页按该 Run ID 读取舞段、训练配置、真实上报曲线和质量门；账号无权访问或记录不存在时明确提示，不切换到“最新 Run”。**训练完成不等于舞蹈质量达标**。只有平台返回同源、绑定本 Run 的视频链接且策略/轨迹摘要匹配时才显示播放器；缺少链接时详情页会明确说明不能播放，不再把“看回放”写成可执行下一步。此舞蹈链路仅仿真，不提供真机部署入口。

查看算力机时会带出 Worker 最近一次健康检查报告的引擎和 Mock 标记；舞蹈候选优先筛选报告支持 `originman-dance-ppo`、明确标记为非 Mock 的机器。没有候选时，先测试一台引擎能力未知的机器以刷新清单。能力记录仅是最近一次报告，舞蹈提交仍会重新测试所选 Worker 的连接、Mock 状态与引擎注册，任何一项未通过都不提交。

算力机可以是自己的电脑。通用训练按引擎能力使用 CPU 或 GPU。OriginMan 舞蹈要求平台能直接访问已登记的 Worker，支持本机部署的独立平台，线上平台需要配置可达连接。舞蹈 PPO 默认用 CPU，Worker 可以配置 NVIDIA CUDA 或 Apple MPS。查看 Run 的 `metrics.trainingDevice` 确认实际执行设备，MuJoCo 仿真仍用 CPU。

Run 详情页属于机器人学习平台的前端资源；插件 ZIP 只包含插件与说明，不能替代平台服务发布。平台尚未部署匹配页面时，先更新平台服务，再使用插件里的 Run 链接。当前代码库没有舞蹈 MP4 读取 API，也没有舞蹈奖励实现；本版本不调整质量门阈值或宣称奖励已校准。若平台没有返回经过核验的舞蹈视频链接，详情页仍显示训练信息、曲线和质量门，并说明回放链接缺失。

### 其他训练

按目标说明机器人、任务、引擎、数据和执行资源，例如：

> 用当前项目的演示数据做 ACT 训练，先检查数据和算力，不要使用合成数据；给我看 Run 和模型来源。

插件先核对账号、模型/任务契约、资源健康和真实工具能力。用户指定的数据未被训练器实际读取时，不声称模型由该数据训练；Mock、dry-run 和 smoke 结果不能作为真实学习或质量通过证明。

## 4. 常见操作指引

| 目标 | 可以这样说 | 主要结果 |
| --- | --- | --- |
| 检查连接与工作区 | “检查平台连接和当前工作区” | 当前平台、账号、服务就绪、模型/资源/运行摘要 |
| 看我的机器 | “查看我的开发机” | 分开列出算力机与 RDK 板卡 |
| 测试某台算力机 | “检查算力机「GPU 名称」” | 对明确资源做健康测试；不会偷偷换机器 |
| 连接某块板卡 | “连接板卡「设备名称」” | 建立受控连接/SSH 隧道并探测 BoardAgent；连接本身不会启动策略 |
| 管理项目和数据 | “列出项目和数据集” / “登记这批轨迹的数据集信息” | 项目/数据集台账、数据来源与 ID |
| 检查或登记模型 | “检查这个模型能否用于 X5” / “登记已验证模型” | manifest 校验；登记前仍需业务门禁 |
| 看运行和制品 | “列出最近失败的 Run” / “查 Run 的来源链” | 过滤运行、制品、评测及 lineage |
| 打开仿真和录制轨迹 | “打开浏览器仿真，带我录一段轨迹” | 仿真入口、录制与实际数据检查 |
| 查询评测或失败 | “比较这两轮评测” / “说明这次 Run 为什么失败” | 指定 Run 的质量证据、日志、遥测和重训建议 |
| 查 RDK 官方资料 | “查 RDK X5 的官方烧录步骤” | 官方文档优先，论坛只作补充；第三方搜索会标明来源层级 |
| 新机器人课堂引导 | “带新同学做离线课堂准备” / “检查这台新机器人验收还缺什么” | 每次只问一个缺项；离线指导不会连接或动作 |
| 部署预检 | “对这个模型做只读部署预检” | 平台检查与计划；不是批准、板端加载或动作完成证明 |
| 查平台运维状态 | “检查平台 health 和 ready” | 健康、就绪、诊断与发布前预检 |
| 插件开发 | “为平台新增一个 MCP 工具，先核对工具模板和门禁” | 工具/引擎/UI/API 的仓库开发指引 |

插件不要求用户输入工具名、UUID 或内部 MCP 参数。对资源名称有歧义时让用户选择，不猜默认设备或首条资源。

## 5. 13 个 Skills（按任务自动调用）

| Skill | 用途 |
| --- | --- |
| `setup` | 平台登录、身份确认、连接和入口选择。 |
| `experience-preparation` | Workshop 开始/接续、当前课程分流和 Run 可视化跳转。 |
| `training-runs` | 训练任务、引擎、算力、Run、日志和重训建议；也包含舞蹈专用流程。 |
| `workspace-data` | 项目、模型 manifest、数据集以及从数据到 Run 的来源链。 |
| `simulation-replay` | 浏览器仿真、轨迹录制、遥测和运行回放。 |
| `evaluation-feedback` | 训练/真机评测、质量门、比较、反馈和重训建议。 |
| `artifacts-deployments` | 制品生命周期、部署预检、审批状态、版本计划和取消。 |
| `devices-board` | RDK 连接、板端状态、策略和 D6A 机械臂能力。 |
| `robot-acceptance` | 新机器人、换机、标定、只读探测及逐机验收证据。 |
| `classroom-rehearsal` | Qoder 课堂演练、资料收集和逐步教学。 |
| `rdk-platform-docs` | RDK 官方资料和平台自身工作流/API 查询。 |
| `platform-operations` | 健康、就绪、发布/演示预检及平台台账运维。 |
| `platform-development` | 扩展平台 MCP、引擎、适配器、事件、奖励和工作台。 |

Skill 是按任务使用的操作说明，不是权限提升。实际工具、宿主审批和平台服务仍决定动作能否执行。

## 6. 57 个平台 MCP 工具

工具目录按同源平台契约生成，含完整参数 Schema 和只读/写入提示，见 [MCP 工具目录](tool-catalog.md)。下表按功能索引全部平台工具；工具是否出现在当前连接中以实际 `tools/list` 为准。

### 工作区、项目和来源

| 工具 | 能力 |
| --- | --- |
| `rdk_platform_status` | 平台健康、就绪和当前会话身份。 |
| `rdk_workspace_overview` | 当前模型、设备、训练资源和运行概览。 |
| `rdk_workspace_summary` | 项目、数据集、运行、部署摘要。 |
| `rdk_golden_path` | 某项目/模型/任务从数据到反馈的主链路进度。 |
| `rdk_projects_list` / `rdk_project_create` | 列出或创建项目并绑定模型/数据集。 |
| `rdk_datasets_list` / `rdk_dataset_register` | 查数据集或登记已有数据/遥测来源。 |
| `rdk_models_list` / `rdk_model_validate` / `rdk_model_register` | 列模型、检查 manifest、登记已验证模型。 |
| `rdk_runs_list` | 按模型、项目、状态、后端或关键词查 Run。 |
| `rdk_artifacts_list` | 查模型、检查点、录制和发布制品。 |
| `rdk_evaluations_list` | 查训练/真机评测。 |
| `rdk_lineage_get` | 查询 Run、制品、评测和项目的来源关系。 |

### 算力资源、设备和板端状态

| 工具 | 能力 |
| --- | --- |
| `rdk_compute_resources_list` / `rdk_compute_resource_test` | 列算力资源并测试明确资源的健康状态。 |
| `rdk_device_discover` / `rdk_device_connect` / `rdk_device_disconnect` | 发现、受控连接或断开 RDK 设备。 |
| `rdk_board_health` / `rdk_board_onboarding_preflight` | BoardAgent、磁盘、传感器以及接入前检查。 |
| `rdk_board_station_status` / `rdk_board_station_command` | 读取板端状态或执行白名单只读命令。 |
| `rdk_board_policy_status` / `rdk_board_policy_files` | 查询策略运行时状态和已暂存 ONNX 文件。 |
| `rdk_board_sessions` | 查看运行所关联的板端策略会话和停止原因。 |
| `rdk_board_arm_status` | 查询 D6A 机械臂能力与位姿预检。 |

### 训练、评测、日志和仿真

| 工具 | 能力 |
| --- | --- |
| `rdk_training_submit` / `rdk_training_status` | 提交受控训练任务或查询 Run 状态/指标。 |
| `rdk_training_prepare` | 刷新指定资源健康并核对机器人任务环境，不提交训练。 |
| `rdk_run_logs` | 读取有界训练日志。 |
| `rdk_telemetry_list` / `rdk_runs_replay` | 列遥测分片并读取遥测回放/评测证据。 |
| `rdk_replay_video` | 为满足证据条件的真机运行渲染遥测视频。 |
| `rdk_evaluation_summarize` / `rdk_feedback_summary` | 汇总评测证据或工作台反馈。 |
| `rdk_retraining_advice` | 根据 Run、评测和遥测生成重训建议。 |
| `rdk_simulator_open` | 打开浏览器参考仿真入口。 |
| `rdk_workflow_inspect` | 只读检查指定产品/任务/实验的流程证据。 |

### 制品、部署和受控动作

| 工具 | 能力 |
| --- | --- |
| `rdk_artifact_promote` | 按生命周期规则推进或撤销已登记制品状态。 |
| `rdk_deployment_preflight` | 对明确模型/Run/设备做只读部署预检。 |
| `rdk_deployment_status` / `rdk_deployment_history` | 查询部署计划当前状态和历史证据。 |
| `rdk_deployment_version_switch` | 为部署计划生成另一模型版本的检查计划。 |
| `rdk_deployment_cancel` | 取消尚未执行板端动作的计划。 |
| `rdk_board_policy_stage` / `rdk_board_policy_load` | 将真实训练制品暂存并在板端受控加载。 |
| `rdk_board_policy_start` / `rdk_board_policy_reset` / `rdk_board_stop` | 在安全门禁内启动、复位或停止板端策略。 |
| `rdk_board_arm_move` / `rdk_board_arm_gripper` / `rdk_board_arm_stop` | 在双安全开关、工作空间限制下控制 D6A 机械臂/夹爪或停止命令。 |

### 官方资料与公开搜索

| 工具 | 能力 |
| --- | --- |
| `rdk_docs_search` / `rdk_docs_manuals` / `rdk_docs_toc` / `rdk_docs_page` | 检索官方手册、列目录、章节和读取官方正文。 |
| `rdk_web_search` | 搜索公开网络资料；结果属于第三方信息，需核验来源。 |

## 7. 26 个插件扩展工具

| 工具 | 能力 |
| --- | --- |
| `rdk_plugin_status` | 离线核对加载版本和源码是否匹配。 |
| `rdk_originman_course_brief` / `rdk_originman_training_choice` | 课程预算/完成标准说明；手动高级训练预算选择。 |
| `rdk_learning_guide` | 新手逐轮选任务、编舞、算力和预算，保留真机目标与已知选项。 |
| `rdk_originman_dance_draft` / `rdk_originman_dance_train` | 整理有界舞段配置；校验后提交独立 PPO 仿真训练。 |
| `rdk_workshop` | Workshop 开始、继续、查看结果统一入口；页面选择预算，不直接提交。 |
| `rdk_development_targets` | 查看算力机和板卡，测试算力机或连接明确板卡。 |
| `rdk_classroom_guide` / `rdk_robot_onboarding_guide` / `rdk_robot_acceptance_assess` | 课堂分步提问、新机器人指南和验收字段覆盖检查。 |
| `rdk_auth_login` / `rdk_auth_switch_account` / `rdk_auth_status` / `rdk_auth_logout` | 登录、切换、查看和退出插件账号连接。 |
| `rdk_originman_train` / `rdk_originman_evaluate` | OriginMan 受扰恢复高级训练和原策略同源评测。 |
| `rdk_originman_short_train` / `rdk_originman_short_evaluate` | 固定配方的仿真快检和同源评测。 |
| `rdk_training_wait` | 对已提交 Run 等待到终态或一个有界时间窗口。 |
| `rdk_experiment_remember` / `rdk_experiment_resume` | 保存明确实验 Run 引用并按该引用恢复；不会查找或替换为全局最新。 |
| `rdk_originman_evaluation_read` | 读取指定 OriginMan 评测结果和来源。 |
| `rdk_experience_guide` / `rdk_experience_prepare` | 高级课程指南和同账号场景/策略入口准备。 |

扩展工具提供自然语言工作流；平台工具提供原子能力。默认学员流程优先使用 `rdk_workshop`；用户明确要求高级操作时才切到相应原子工具。

## 8. 结果与安全边界

- **Run 完成不代表效果达标**：执行状态、质量门、仿真指标、实体效果分别报告。
- **训练、评测是不同阶段**：核对评测来源 Run、模型摘要、seed 和条件，不把其他轮次的结果当本轮成绩。
- **Mock、dry-run、示例和合成数据须标明**：它们不能代替真实训练、用户数据消耗、真实产物或质量通过。
- **注册不等于训练器已读取数据**：数据集登记保存来源信息；需核实训练执行器真实读取的数据字节和 lineage。
- **预检不等于部署/运动**：计划、审批、暂存、加载、启动和真实动作是不同步骤。需要用户明确目标并通过平台门禁。
- **设备连接不等于控制**：建立隧道/探测 BoardAgent 本身不会启动策略或驱动电机。
- **链接不等于播放成功**：只有宿主播放器真实打开并推进，才能称为已播放。舞蹈详情页只使用平台返回的同源、Run 绑定媒体地址。
- **ID 属于当前账号**：Run 链接根据明确 ID 查询；401/404 按登录、权限或记录缺失处理，不自动改看其他账号或最新任务。
- **停止与取消有边界**：停止助手轮询不会取消 Worker 任务；部署取消也只适用于尚未执行设备动作的计划。

## 9. 常见问题

| 现象 | 处理方式 |
| --- | --- |
| 插件已上传但没有技能/MCP 工具 | 确认上传的是安装器生成的 Qoder 本机包；刷新连接/重启宿主并新建聊天；用 `rdk_plugin_status` 检查加载版本。 |
| 平台未连接/登录过期 | 运行 `rdk_auth_status` 或重新登录；不要把 Cookie/密码粘贴到聊天。 |
| 找不到算力机或板卡 | 确认当前账号、平台登记和访问权限；按名称查列表。资源未授权或健康不明时停止，不自动换用其他机器。 |
| 训练链接打不开 | 确认平台已部署匹配的 Run 详情页版本、浏览器使用同一账号；检查链接的 Run ID。页面无权访问时不会替换记录。 |
| 舞蹈没有视频 | 详情页仍显示配置、实际曲线和质量门；只有平台提供本 Run 的同源媒体链接且 SHA 对得上才显示播放器。不要把质量通过当作已有视频。 |
| Run 排队或暂时无日志 | 对同一个 Run 等待/查状态；不重复提交。资源或引擎校验失败时先处理明确错误。 |
| 连接板卡但不能运行 | 连接只做受控通道与探测；按设备验收、制品、评测、部署门禁逐项检查。不能仅凭 SSH/连接成功启动策略。 |
| 结果看起来和上一轮相同 | 检查当前实验/Run ID、模型摘要和评测来源；新实验须用新的上下文并保留旧结果。 |

## 10. 进阶参考

- [首次 Workshop 教程](workshop-first-run.md)：页面按钮、预算、曲线、对比、单变量实验与故障接续。
- [Qoder 安装和验收](qoder-first-run.md)：本机导入包、账号切换和宿主检查。
- [客户端接入](client-setup.md)：Studio/Qoder/其他客户端安装细节。
- [训练/评测/部署契约](workflow-contracts.md)：Run、质量、来源和部署阶段。
- [API 工作流](api-workflows.md)：未提供专用 MCP 工具的受控平台 API 能力。
- [连接契约](connection-contract.md)、[设备契约](device-contracts.md)：身份、权限、设备和操作边界。
- [舞蹈配置契约](originman-dance-manifest.json)、[舞蹈幅度与有效限幅](originman-dance-envelope.md)、[舞蹈实现状态与证据](originman-dance-status.md)。
- [CLI/工作台能力](cli-capabilities.md)、[用户工作流](user-journeys.md)、[新机器人验收](new-robot-acceptance.md)。

平台页面、API 和运行时可能随发布变化。以插件安装包实际版本、平台实际 `tools/list`、API 响应和本次 Run 记录为准；不要用本文或旧聊天记录替代当前状态。
