# 新用户工作流与验收用例

这份参考用于 RDK Studio、WorkBuddy 和其他 MCP 客户端接入后的实际使用。技能和工具被发现只证明入口已加载；客户端导入、平台连接、真实训练、Sim2Real 证据、板端推理和实体运动分别验收。下面是测试定义，不是历史通过记录；运行结论从本次测试报告读取。

## 一句话完成用户任务

用户说“用我的轨迹训练并部署到这个设备”时，先把可执行目标收敛为文件/数据集、任务与契约、执行资源、训练预算和目标设备。已有授权继续有效，只有缺少会改变结果的输入或平台要求的审批才问用户。能独立完成的文件检查、平台读取和请求准备先做。

1. **检查入口和目标**：本客户端实际能调用 `rdk_platform_status`，会话/ready 有效；核对当前平台和设备，不默认首个模型或首台设备。插件 root/Node 绑定是在执行 MCP 的主机上，不会自动迁移到另一台安装 WorkBuddy 的电脑。远程平台地址也不等于该电脑已经具备 CLI/训练依赖。
2. **检查用户数据**：文件真实可读，记录摘要/来源、episode 边界、维度、时间率和目标契约。`rdk_dataset_register` 登记元数据，不上传轨迹；`datasetIds` 是来源关联，不证明当前引擎消费过这些字节。远程客户端看不到本地文件时明确传输/挂载缺项，不能提交 synthetic-smoke 冒充用户数据。
3. **选择真实学习路径**：用户示教的 ACT/BC/DP 当前通过仓库 CLI；导出 ONNX 是显式选项，默认模型 JSON 不是可下发字节。ACT 至少核对默认验证划分需要的 4 train/2 validation episodes；不自动关闭验证。RL 通过真实注册 worker/engine/task-pack 提交，记录唯一 Run，不用重复提交查询进度。
4. **连接软件证据**：真实训练产物、SHA-256、model/Run/data lineage、评测报告和质量门都绑定到实际台账实体。CLI 产物存在不等于已登记 Run 或已发布；按 [API 工作流](api-workflows.md) 的真实 schema 补齐所需登记，不能把失败/来源不明报告手写成 passed。
5. **做 Sim2Real 预检**：先生成不运动的预检计划，再查看每项检查。Mock、仿真评测、导入来源标记、host 延迟和 board 延迟分别报告。存在实体设备、匹配制品摘要和板端收据后才能说明板端推理资格；纯推理不证明实际动作成功。
6. **受控发布**：preflight、制品发布、Canary/Live 计划、owner/admin 审批、板端 staging/load/start 是独立步骤。没有客户端专用工具时走已有受控 HTTP/CLI 入口，缺执行适配器或现场条件时停在最后一个有证据的阶段。调优改一个已说明的变量，用新逻辑键/新 Run/新制品再比较；不要覆盖原证据。

每次向用户报告结果至少给出“已完成的结果 + 对应实体 ID/文件 + 当前阻断 + 下一项具体动作”。不要要求新用户自己从一串 JSON 寻找下一步，也不要说“部署成功”来泛指预检 passed 或审批 ready。

## 连接与错误恢复

- `fetch failed` / 连接拒绝：先说明 MCP 已加载但目标平台未连通。核对脱敏后的配置地址、网关前缀、平台是否运行及 `/healthz` / `/readyz`；本地未启动时给出仓库 `npm start` 的演练入口，用户要真训练则使用已配置真实服务/worker。不要用重复训练提交探测连通性。
- 401/403：检查 MCP 进程上的 Cookie 或完整登录中继配置；客户端浏览器登录不会自动传给 stdio 子进程。不要打印秘密、关闭鉴权或把不同账号实体当作同一工作区。
- HTTP 200 但 `isError:true`、`ok:false`、`passed:false` 或 `mock:true`：按业务状态报告；预检缺证据不是网络故障，不靠反复重试解除。
- 请求超时：保留该逻辑操作的 `idempotencyKey` 和已收到的实体 ID，先查状态再考虑同键重试；改变训练/部署参数用新键。物理动作不明结果先回读/停止，不自动重放。
- 用户说“停止”：取消客户端等待不等于已取消 Run。先识别是停止轮询、取消仍可取消的部署计划、还是停止真实动作；只调用当前存在的对应接口，说明剩余状态，不能虚构训练取消工具。
- 参数缺失：按 [工具目录](tool-catalog.md) 与 handler 必填规则传 runId、connectionId、direction、arm 坐标/夹爪参数。关键必填、deviceId、摘要与稳定操作键已体现在同源 schema；重要追加字段仍不能因为 `additionalProperties:true` 就假设已被转发。训练工具会明确拒绝不支持的轨迹路径/续训/嵌套配置。

## 用例矩阵

写入测试只能用新建临时端口、新存储和本次 fixture；不能对用户现有平台默认实例、账本、真实设备或物理动作执行验收写操作。所有测试保留本次输入、MCP/HTTP 状态、脱敏响应、退出码和实体/产物证据。测试结束清理本次启动的子进程/临时数据，保留报告；不能清理用户原数据。

| ID | 用户输入/前置状态 | 调用或操作 | 预期用户结果 | 必须留存的证据 |
| --- | --- | --- | --- | --- |
| U01 | “连接学习平台”；地址没有监听服务 | initialize/list 后调用 `rdk_platform_status` | 说明入口已加载、服务未连通；给出目标地址检查/启动或修复动作；不得声称 所有工具均可执行 | 客户端启动输出、实际 tool call 失败、无新增 ledger/Run |
| U02 | “连接我的平台”；Cookie 失效/缺账号字段 | 状态/overview，认证失败路径 | 一次受支持重登或明确 401/配置缺项；秘密不出输出；不换 anonymous 绕过 | 401 与登录次数、脱敏请求/响应、账号/会话边界 |
| U03 | “连接这个子路径部署”；反代挂载前缀有效 | status + overview + simulator URL | 业务路径使用版本化前缀，仿真入口留在目标平台/挂载范围 | 实际请求 URL、200 与 schema、浏览器打开的有效资源 |
| U04 | “在 RDK Studio/WorkBuddy 使用这个插件”；执行主机无 repo/binding 或 Node 不兼容 | 客户端导入/启动 + loader check | 给出该客户端配置/仓库/Node 的具体修复；工具列表可用后仍继续业务探针 | 每个客户端实际 GUI 导入与调用结果；只跑 Node 测试不能标 GUI 验收 |
| U05 | “打开仿真，录一段轨迹”；WASM/WebGL 可用 | `rdk_simulator_open` 后浏览器操作录制/导出 | 真实状态/时间推进，用户轨迹可读且有 header/step/episode；仿真不叫真机 | 浏览器画面/控制台、录制 JSONL 摘要、实际 step 和状态变化 |
| U06 | 同上；WebGL/依赖不可用 | 仿真失败，转轨迹检查页 | 明确仿真不可运行；轨迹页仍可看已有证据，不用静态图证明仿真成功 | 真实错误、未运行仿真的结果边界、替代页验证 |
| U07 | “用我的轨迹训练 ACT”；单 episode/维度不一致/NaN | 真实 CLI 数据校验 | 拒绝并指出输入行/episode/split 缺项；不自动 synthetic 或关闭验证；不写合格产物 | 非零退出码、失败原因、无有效模型/ONNX/发布实体 |
| U08 | “用我的轨迹训练 ACT”；足够 episode 的真实 fixture | CLI 显式 JSON/ONNX 导出并检查 split/parity，再按 API 登记来源 | 模型来自该文件摘要，训练/验证按 episode 分开，ONNX 实际生成且等价；如质量不足保留失败 | 输入摘要、split 计数、训练指标、导出摘要/parity、artifact/Run/data ID 与 lineage |
| U09 | “提交真 PPO 训练”；真实 CPU worker、任务/契约匹配 | 显式模型/资源/backend/engine/profile + 固定 key，status/log | 单个 Run 真执行，日志进度可读，完成有真实 artifact；不默认首模型/Mock | worker 来源/engine、Run ID、终态、真实产物摘要/quality report |
| U10 | “用这个资源训练”；资源不存在/不健康/引擎未注册 | 资源读取/test + 提交前检查 | 明确缺资源或支持条件，不隐式转 local/替代引擎/起计费任务 | 资源探针与拒绝原因、无额外 Run/计费请求 |
| U11 | “提交刚才的训练”；同一请求重发、首响应丢失 | 同 key 相同请求重复提交，再查状态 | 返回同一实体，只启动一次；参数变更不复用旧键 | 请求 key、两个响应 Run ID、Run/worker 启动计数；冲突反例 |
| U12 | “继续之前检查点训练”；真实 checkpoint | 对实际 POST runs.resumeFrom 契约做续训 | checkpoint/来源可追踪；当前 MCP 未转发字段时转正确受控 API，不伪装成功 | 入站/实际转发字段、checkpoint lineage、后端结果和拒绝条件 |
| U13 | “训练 SmolVLA”；缺 GPU/权重/LeRobot | 环境检查、计划/dry-run 与真实路径负例 | 指出缺依赖；dry-run 写计划结果但无 artifact，不能标真微调 | 环境/退出码、dryRun 标记、无权重制品、无外部下载/发布副作用 |
| U14 | “看看这次为什么不能部署”；无真实板端/过期评测/低质量 | evaluations/replay/lineage + 部署预检 | 逐项说明来源、质量、freshness、契约/摘要和板端证据缺项，保持阻断 | 平台重算裁决与具体 checks、失败实体、无运动请求 |
| U15 | “用 host 延迟收据发布这个新导出”；摘要/阶段不符 | 制品/评测登记或晋级负例 | 拒绝错误阶段/字节绑定；不能把 host 结果替代 board-onnx | 非通过判决、原/新 SHA-256、stage、状态未非法晋级 |
| U16 | “调好参数再部署”；固定数据/协议，只改单变量；含未知 `learningRate/seed` 或错类型负例 | schema 明确拒绝未公开调参/错误类型且不请求平台；真实 CLI 用新制品比较 baseline 与调优结果 | 真实差异和范围明确；验证集用于调参后属于开发评估；改善不自动免除质量门 | 零请求负例；双方源 SHA/配置/seed/split、指标与产物；最终独立质量数据另验 |
| U17 | “生成上板预检”；reference BoardAgent 返回 mock | `rdk_deployment_preflight` + status/history | 区分计划已生成与真机未就绪；mock 不晋升真机资格 | deployment ID、mock/passed/checks、无stage/load/start调用 |
| U18 | “把策略放到设备，先别运动”；临时 BoardAgent fixture 或用户选中的真实板卡、真实字节 | 受控 stage/file hash/load、batch policy-infer 或 `verify-platform-plugin-board-inference.py` 隔离数值验收 | 字节和收据可复核，只说明相应软件阶段；真实板卡数值向量仍为 synthetic 输入，不声称遥测/运动/发布；motion 请求为零 | 原始/主机/板卡 SHA、loaded/CPU parity、测试输入来源、零 ROS publish/动作请求与未部署声明 |
| U19 | “发布这个版本”；合格软件证据，但没有 owner/admin 通过或真实 executor | Canary/Live 计划/API 审批状态检查 | pending/ready/执行结果分别报告；不自动批准自身请求/绕过缺 executor | 审批身份与决定、历史、无未经授权的stage/start |
| U20 | “取消刚建的部署计划/停止等待”；可取消与已执行两种 fixture | cancel/status/history，客户端取消请求 | 合法计划取消幂等；已执行状态不能撤销则明确拒绝；取消等待不停止 Run | 原/新状态、重复取消响应、存活 Run 状态、不明动作未自动重放 |
| U21 | “这个设备动作超时，重试”；模拟请求结果不明 | 只读状态/安全停止与错误解释 | 不自动重试移动/夹爪/start，不宣称已经停止；按现有服务纪律请求重新确认 | 动作请求计数、后续只读/停止结果、未知安全状态说明 |
| U22 | “统计所有运行”；响应超过投影预算/被截断 | list/filter/分段精确查询 | 明确统计范围并补查询，不能把投影当全量；列表空不填假实体 | projection/数量标记、筛选参数、完整或受限统计口径 |
| U23 | “用刚录制的示教做离线学习”；真实浏览器录制多个 episode | `scripts/verify-platform-plugin-demonstration.mjs`；真实 offline-BC CLI 显式导出 ONNX | 实际消耗录制文件的 step 字节，完整 episode 留出；内部 row-val 与外部 episode 评估分别报告；不伪装合格平台 Run | 原文件/归一化训练输入 SHA-256、分组 manifest、真实模型/ONNX/parity、留出 MSE 与 train-only mean-action 基线 |
| U24 | 同上；父环境残留 REQUEST_FILE/RESULT_FILE | 在 CLI 子进程剥离两个 file-protocol 变量 | 仍走用户显式文件训练，不能因继承环境改成 synthetic-smoke | 规范化输入路径/摘要、CLI metrics/导出、fileProtocolVariablesRemoved 标记，无 synthetic result |
| U25 | 同上；没有真实输入或显式 Python 缺 numpy/ONNX/runtime | 数据/依赖门禁 | exit 2 blocked，指出缺项；不生成 synthetic 占位数据、不静默切换显式 Python | 本次阻断报告、零学习产物；修复后用同一真实源数据重新验收 |

## 测试结论的层级

1. **入口**：manifest/skills/stdio/schema/跨客户端配置文件可解析。
2. **软件请求**：隔离平台中真实认证、数据/Run/评测/制品/部署状态机和负例通过。
3. **真实学习**：用户数据字节进入真实训练器、产物与 parity/质量门有证据；fixture synthetic 不能代替。
4. **板端软件**：目标板卡实际加载/纯推理/延迟收据绑定当前字节，清楚未运动。
5. **实体闭环**：现场授权、实际设备动作、签名遥测回流与发布反馈；本矩阵的隔离验收不执行这一层。

客户端 GUI 导入与操作者一句话主路径必须在对应客户端实际验证。若只导出了配置或跑了 harness，结论标“配置/软件验收通过，客户端 GUI 或实体闭环未验收”。
