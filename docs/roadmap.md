# Sim2Real 平台路线图（差距分析 → 验收标准）

定位：**RDK 机器人策略的证据链与安全交付控制面**。平台用通用机器人学习工作流承载
不同机型，但当前产品承诺聚焦于可审计的 Run → Artifact → Evaluation → Deployment 链路。
OriginBot 是第一台参考机型；换一台底盘机器人应当只需要换“机型适配包”（观测槽位映射 +
动作投影 + 安全参数），而不是改平台。通用机型生态属于后续扩展目标，不把尚未完成的现场
适配和车队能力写成当前承诺。

## 术语

- **P0** = 安全底线或主链路断点；**P1** = 闭环完整性；**P2** = 规模化与体验。
- 每项带验收标准（怎么算"完成"），避免"看起来做了"。

## 已落地（本仓库当前状态）

| 能力 | 状态 | 验收 |
| --- | --- | --- |
| 训练协议 + 台账（Mock） | ✅ | `npm run verify` ui/recorder/deployment/examples 全绿 |
| 真实 PPO starter（numpy+torch） | ✅ | `npm run demo:starter` 产出真实 `policy.onnx`，`mock=false` |
| ONNX 导出契约（61D/14D/50Hz） | ✅ | shared/sim2real.ts 契约 + 测试断言布局 |
| 板端只读预检（X5） | ✅ | 白名单命令 + 预检探针，token 认证 |
| 上位机站（真实遥测流） | 🟡 参考实现 | 浏览器 → 代理 → 隧道 → agent → TROS 的代码路径与契约已具备；现场 `mock:false` 证据仍按发布清单归档 |
| 受限驱动 Canary | 🧩 代码门禁已具备 | 双开关、速度钳制 0.3/1.0、窗口 ≤2s、底盘看门狗 500ms；真实运动验收仍需现场记录 |
| **板端策略运行时（本轮新增）** | 🧩 参考运行时 | 板上 load 真实 61→14 onnx → ready 的路径、拒载和 stop 恒可用契约已验证；现场推理/运动指标需设备验收 |
| 平台策略代理路由 + UI 面板 | ✅ | vitest 9/9；面板如实显示开关状态、obsSlots、推理指标 |
| **Task-Pack 声明式训练（本轮新增）** | ✅ | 任务 JSON + 机型 JSON 驱动引擎；`verify:task-pack`/`verify:goalnav` 进 verify 链 |
| **真实机器人任务训练（本轮新增）** | ✅ | 目标点导航：CPU 800 迭代，8D 布局 nominal 74%、42D 布局 90% [CI 0.79,0.96]；gate 以 Wilson CI 下界如实判定（碰撞侧 CI 上界未达标=诚实 FAIL） |
| **域随机化 + 课程学习（本轮新增）** | ✅ | 8 参数 episode 级随机化（含丢帧/滑移）；钉死 nominal/hard 评测信封；课程按机型独立声明（8D 封顶 [1.4,1.6]）；hard envelope 量化鲁棒性代价 |
| **可量化质量门（本轮新增）** | ✅ | fail-closed；Wilson 95% CI（50 episodes/信封）下界判定；引擎 eval-report.json + TS 侧重算裁决（`validateTaskPackEvalForRelease`）；指标或置信界缺失=FAIL |
| **第二机型（平台声明实证，本轮新增）** | ✅ | generic-differential-drive（S100 契约）42→2 同引擎同任务族训练，nominal 90%、成功率侧过 CI 门；诚实标注 simulation-only |
| **统计功效 + 跨进程可复现（本轮新增）** | ✅ | Wilson CI 进 gate；torch 全局播种修复，同请求跨进程 eval 指标逐项相等（契约测试守护）；超参敏感性研究落档 `docs/research/` |
| **PPO 数值稳定性根因修复（本轮新增）** | ✅ | clamp-动作 log-prob 悬崖 → NaN 的根因修复（训练未截断动作 + log-ratio 护栏），两条引擎路径统一；800/1600 迭代不再崩溃 |
| **评测诚实化（本轮新增）** | ✅ | 碰撞/末端距离在 auto-reset 前采集（消除 collisionRate≡0 假象）；workspace.bound 越界终止；dwell 奖励破极限环（nominal 0%→90% 的根因，轨迹级诊断佐证） |
| **SAC 算法路径（本轮新增）** | ✅ | `training.algorithm` UI→API→引擎全链（未知值 400）；twin-Q + 自动温度 alpha，与 PPO 同骨干/同 ONNX 契约/同评测门；`verify:starter-engine` 双算法断言（alphaCurve 非空 = 梯度真实执行） |
| **rsl_rl 引擎适配器（本轮新增）** | ✅ | `engines/mjlab-rsl-rl-adapter/`：kinematic 后端经真实 rsl_rl `OnPolicyRunner` 训练 GoalNavEnv，`physicsBackend` 如实标注；mjlab 钩子为显式接入点；`verify:mjlab-adapter` 进 verify 链 |
| **视觉观测训练引擎（本轮新增）** | ✅ | `engines/visual-ppo/`：CPU MuJoCo 离屏渲染 48×48 顶置相机帧 + 4D 本体感受 → 纯 JAX CNN+PPO → Conv 算子 ONNX（与 JAX 前向数值等价断言）；无渲染栈 exit 3 拒绝，`physicsBackend=cpu-mujoco-vision`；`verify:vision-observation` 进 verify 链，见 [docs/engines/visual-ppo.md](engines/visual-ppo.md) |
| **物理级域随机化（本轮新增）** | ✅ | MJX 引擎任务包契约新增 `physicalDomainRandomization`（轮摩擦/底盘质量/伺服 kv 按 episode 重采样，写进 vmap 轨迹，jit 常量折叠有回归断言）；不 opt-in 的包行为与历史逐位一致 |
| **dm_control 生态适配（本轮新增）** | ✅ | `engines/dm-control-adapter/`：dm_control 1.x `rl.control.Environment`/`Task` 钩子驱动平台 goal-navigation 任务，物理与 MJX 同源 MJCF（`physicsBackend=dm-control-mujoco` 复合名，如实标注）；`verify:dm-control-adapter` + 15 单元测试进 verify 链；Playground 不在 PyPI 的如实结论由 `scripts/probe-dm-control-ecosystem.mjs` 记录，见 [docs/engines/dm-control-adapter.md](engines/dm-control-adapter.md) |
| **模仿学习路径（offline-bc v2，本轮新增）** | ✅ | `engines/offline-bc/`：v1 线性占位换真 MLP + Adam + train/val 分离（标准化只从 train 估计）+ 确定性种子 + ONNX 导出带 onnxruntime 数值等价证明（未验证的导出不落盘）；非线性拟合对闭式线性基线的显著优势是硬测试；fail-closed 数据规则全保留；provenance 三块（source/dependencies/dependencyLockSha256）与 runner 引擎同规范，`verify:offline-bc` + `verify:training-provenance` 均已覆盖，见 [docs/engines/offline-bc.md](engines/offline-bc.md) |
| **仿真-真机相关性度量（SimplerEnv 方法论，本轮新增）** | ✅ | `shared/sim-real-correlation.ts` + `GET /runs-correlation`：跨 run 配对仿真侧指标（task-pack nominal successRate，回退训练 recentSuccess）与真机侧遥测评测 actionMae，报 Pearson + Spearman（排序保持为主读数）+ MMRV 相对误差摘要；退化输入一律 null + 原因（不足对数/零方差/无相对误差对），跳过按原因计数；方法论证据、刻意不做发布门禁；13 项 vitest + openapi 契约登记 |
| **SmolVLA 真微调入口（本轮新增）** | ✅ | `engines/smolvla/` 真实路径重写为委托 lerobot 0.4.4 原生训练器，并已在 GPU 5090 实证执行：真实 Hub 数据集（aloha_static_battery，经 lerobot-converter/直接装载）→ `lerobot/smolvla_base`（450M，SmolVLM2 骨干）全参微调 375 步 / finalLoss 0.053 / 281.5s → 906MB 制品（SHA256SUMS 契约）+ result.json（mock=false, cuda=true, 依赖四件套如实记录）。实证驱动的 seam 修正：`transformers.AutoModel` 无法加载 lerobot policy 制品（transformers 无原生 smolvla）→ 委托原生训练器；`--policy.repo_id` 必填、`policy.push_to_hub` 默认开须显式关、`--rename_map` 顶层旗标做相机名映射（aloha→camera1/2/3）、num2words 为 SmolVLM processor 硬依赖。29 项契约测试 + 引擎锁重生成（98 包） |
| **LeRobot 数据格式互操作（本轮新增）** | ✅ | `engines/lerobot-converter/`：export 轨迹 JSONL → LeRobot v3.0 数据集目录（mono8 无损 H.264 视频管线；tabular-only 合法）；import v2.1/v3.0（含当前 main 的 file-sharded 布局与 pandas `__index_level_0__` 任务表——真实 Hub 数据集实证并拦截修复）→ ACT 可直接训练；多相机数据集 `--video-key` 显式点名、`--tabular` 显式放弃相机（忽略项记入 header note），绝不静默选相机；54 项契约测试 `verify:lerobot-converter` 进 verify 链，`npm run convert:lerobot` 直达，见 [docs/engines/lerobot-converter.md](engines/lerobot-converter.md) |
| **ACT 动作分块模仿（本轮新增）** | ✅ | `engines/act/`：真 ACT（Zhao et al., RSS 2023，LeRobot 旗舰算法）——Transformer 编解码器 + CVAE 风格隐变量（KL 权重对齐论文量级 10）+ k 步动作分块 + 时序集成（纯 NumPy `ensemble_predictions`，板端可逐字复制）；episode 级 train/val 划分（chunk 不跨界，标准化只从 train 估计）；无 episode 结构的转移数据 fail-closed 拒绝；注意力用原生算子手写使 ONNX 图为 torch 前向逐节点镜像，导出后 onnxruntime 逐元素等价断言、失配即删；模型 JSON 即模型（`rebuild_model` 往返 atol=0）；**RDK 差异化**：`--ensembled-onnx` 把时序集成折进图里（最近 k 观测 → 融合动作，torch 等价 + NumPy 参考漂移双重证明）、`IncrementalEnsembler` 板端增量 runtime（全速率 parity / 摊销模式诚实降级）、`--edge-evidence` 实测解码延迟 + chunk 摊销 + decisionHz 预算判定（hostContext 标注，硬门禁仍是板端 rehearsal 收据）、[-1,1] 钳制进图对齐板端速度轨道；28 项契约测试 + provenance 三块进 `verify:act` / `verify:training-provenance` / `lock:engines`，见 [docs/engines/act.md](engines/act.md) |
| **真机遥测发布证据（本轮新增）** | ✅ | canary/live 闸门要求 board-agent 来源遥测评测（证据非阈值语义，fail-closed）；`release-evidence` 12 测试 |
| **BPU 工具链探针（本轮新增）** | ✅ | preflight 白名单命令新增 `bpu_toolchain=present/missing`（hbdk-sim + hbrtmlin/hbrt-tv 存在性，不猜版本）；三方（TS/mjs/Python）字节一致测试守护；预检结果如实回显、不作为硬阻断 |
| **MicroDuck 任务级评测底座（本轮新增）** | 🟡 门禁/诚实性已通，执行器保真度待解 | `engines/microduck-eval/`：CPU MuJoCo 无头回放 + 信封（seed/回合/初态/球位/丢帧/噪声/负载）+ 任务判据（踢球需位移≥0.35 m 且峰值球速≥0.5 m/s 且未摔倒）+ Wilson 与平台公式逐位一致 + `dynamicsFacts` 强制记录动力学/执行器/场景/policy 摘要；**声明式任务规格**（`--task-spec`：阈值/信封/命令由 JSON 驱动，`duck-stand` 作为纯声明式新任务族落地，坏 spec 一律报错）；**装置资格双重 fail-closed**：(a) 零动作基线全倒 ⇒ 装置不合格；(b) 带 `--trusted-policy` 时训练策略全倒而基线站住 ⇒ 装置不合格（既不许认证好策略，也不许判死坏策略）；TS 归一化层保留任务测量量并提升 `fallRate`/`meanEpisodeLength`。`verify:microduck-eval` 已进 verify 链（无 MuJoCo 时如实 SKIP）。**实测缺口**：足量训练产物（4096×6000，训练环境回合长度 938/1000 步≈18.8 秒）在本机每次都摔，而观测层已与训练侧逐位一致（差 0.0）→ 分歧在动力学/执行器，逐项扫描（位置伺服 0.55→128、BAM 端口、厂商 `bam.mujoco.MujocoController`、上游摩擦模型）全部未通过，详见 `engines/microduck-eval/docs/actuator-fidelity-investigation.md` |
| **声明式观测布局（环 B，本轮新增）** | ✅ | adapter `runtime.observationLayout` 驱动板端观测装配（`originbot-imu-odom-v1` / `imu-gravity-v1` / `auto`）；显式布局与模型维度矛盾 → `layout-model-mismatch` 拒载；未知布局 start 拒绝；`verify:policy-provider-layout` 契约测试（真 onnxruntime 会话）进 verify 链 |
| **BPU provider 可切换（环 C，本轮新增）** | ✅ | `RDK_BOARD_POLICY_PROVIDER`（env/adapter）选 cpu/bpu；bpu 请求在无 BPU provider 构建上 fail-closed 拒载（`bpu-provider-unavailable`，绝不静默降 CPU）；provider/providerRequested/providersAvailable 如实上报进 station UI |
| **制品→板端下发（环 D，本轮新增）** | ✅ | worker `/runs/:id/artifact`（服务前重哈希）→ 平台 `/board-station/policy/stage`（发布证据 + SHA-256 交叉比对）→ agent `/policy/upload`（写盘前验哈希、原子落盘）；staging≠加载≠运动；station 页一键下发 + policies/ 列表 |
| **遥测飞轮（环 A，本轮新增）** | ✅ | `GET /runs/:id/retraining-advice`：action-mae/done-ratio/stale-observation-ratio 三信号 + 120 样本证据底（不足=insufficient-evidence，非静默 healthy）；run 详情建议卡 + 操作员显式「按建议重训」；绝不自动发起 |
| **生产加固（本轮新增）** | ✅ | 自家页面严格 CSP（`script-src 'self'`）+ 可选 HSTS，MicroDuck 上游 WASM 所在的 `/mujoco` 刻意放宽；进程内限流（429 + `Retry-After`，探针与 `/metrics` 豁免）；JSON 行结构化日志（字段白名单，绝不读 token/cookie/请求体）；Prometheus `/metrics`（标签归一化 + 基数上限）；`originbot-dashboard.html` 内联脚本/样式已抽取为独立文件 |
| **遥测有界读 + 保留（本轮新增）** | ✅ | 小 `limit` 的列表请求解析到第 N 条即停止（乱序迟到分块自动回退全量以保证逐字节一致）；`RDK_SIM2REAL_TELEMETRY_RETENTION_DAYS` 按天淘汰过期遥测，分片与台账索引同生共死，默认关闭 |
| **单写者租约（本轮新增）** | ✅ | 写台账前获取/续租 `<storage>/writer-lease.json`；同主机按 pid 存活、跨主机按心跳新鲜度判定；冲突 fail-closed 并映射为 503 + `retryable:false` + 可执行建议；`RDK_SIM2REAL_STORAGE_LEASE=0` 可关闭（排障用） |
| **前端注入门禁（本轮新增）** | ✅ | `verify:escape-audit` 扫描 `innerHTML`/`outerHTML` 模板插值，未转义即失败；豁免必须带理由，写在模板字面量文本里的"注释"不被承认 |
| **工程护栏（本轮新增）** | ✅ | ESLint（flat config，error 级零违规）+ Prettier + EditorConfig；Vitest 5 覆盖率阈值（lines 71、statements 68、functions 74、branches 61）；Dependabot（npm/Actions/pip）；CI Node 22/24 矩阵（Node 20 已退役） |
| 诚实性原则 | ✅ | mock 永远标注、遥测不伪造、fail-closed、急停常开 |

## 差距与计划

> **当前发布边界（请勿把计划记录当成执行完成）**：仓库内的 deployment API
> 已实现证据门禁、只读 preflight、Canary/Live 计划和显式人工审批（`/approval`）。
> 审批通过只会把计划置为 `ready`，不会伪称已经上板；真实 BoardAgent 执行、
> 时间盒、现场确认和自动回滚仍由外部发布适配器完成。公开发布前必须保留该边界，
> 不能把“审批通过”写成“已上线”。

### P1 — 训练→上板闭环的真实性

1. **用 starter-ppo 真产物走通完整链**（目前演示模型结构真实但未训练）
   - 验收：`demo:starter` 产出的 `policy.onnx` → 传入板端 `policies/` → load ready →
     obsSlots 正常 → 推理指标连续 1Hz 出现在 station 页。
   - 进展：task-pack 训练已在仿真侧产出真实训练的 `policy.onnx`（42D 布局
     nominal 90%、CI 下界过 0.70 gate；8D 布局 74% 待更长预算，见
     `docs/research/goalnav-eval-2026-09-10-round2.json`）；制品到板的下发链
     （环 D）已闭环——station 页填 runId 即可校验+落盘 `policies/`；
     **已闭环（2026-09-14）**：42D clear-arena 策略真机策略驱动运动 0.096m +
     急停生效，见 `docs/real-loop-validation-2026-09-14.md`。剩余：任务级
     到达点验收（42D goal 装配缺口 2026-09-17 已修复待上板，流程见
     `docs/goalnav-task-acceptance-runbook.md`）。
2. **观测适配的持久化配置**（现在是代码内写死 MicroDuck 契约形状）
   - 验收：机型适配包以声明文件存在（obs 槽位→真传感器/零填充、动作投影、钳制参数），
     平台按机型加载；新增机型不改 Python 运行时代码。
   - **已完成**：训练侧 `adapters/*.json` + `tasks/*.json` 声明式 task-pack（新机型
     零引擎改动，S100 实证）；板端运行时已按 adapter `runtime.observationLayout`
     声明装配观测（环 B 闭环），未知布局/布局-模型矛盾 fail-closed。
3. **真机评测回写**：板端策略运行的 inferMs/published/指令序列回写为 Run 证据
   - 验收：记录页能看到一次"上板会话"的起止、推理统计与停止原因，标记 `mock:false`。
   - **已完成（代码侧）**：board-agent 遥测回流已进发布闸门（fail-closed）；遥测飞轮
     （环 A）把板端漂移分析成重训建议（run 详情卡）；板端会话的起止/推理统计/停止
     原因已结构化展示——runtime 把 `session-started`/`session-stopped` 生命周期事件
     写入遥测 spool、随样本同链路上传，`GET /runs/:id/board-sessions` 聚合后渲染进
     run 详情"上板会话"卡（模型指纹、attested 徽章、中断会话如实标注"未见停止
     事件"）。**已闭环（2026-09-14 晚）**：1.42MB 真机 spool 全量上传（3296
     样本 / 15 会话事件）、`board-sessions` 聚合 8 会话（含 51 推理 PASS 会话）、
     replay 3281 帧全链验证一致，见 `docs/real-loop-validation-2026-09-14.md` §3。

### P2 — 多机型与规模化

4. **第二台参考机型**（验证"通用平台"声明）
   - 验收：新底盘（如另一款轮式或带腿机型）只新增适配包 + agent 配置，平台 UI/路由/
     安全层零改动即出现对应遥测卡与驱动面板。
5. **BPU 推理路径**（现在是 CPUExecutionProvider）
   - 验收：RDK BPU 工具链编译量化模型，板端推理 provider 可切换且延迟显著低于 CPU
     路径，inferMs 如实上报两种模式。
   - 进展：工具链存在性探针已进 preflight；provider 切换开关已闭环（环 C：
     `RDK_BOARD_POLICY_PROVIDER`，fail-closed + station UI 如实显示可用列表）；
     剩余：BPU 侧量化编译产物（hbdk 工具链）实测与延迟对比。
6. **视觉观测上板**（训练侧已闭合：`engines/visual-ppo` 真像素训练 + ONNX 数值等价；
   61D 契约里的相机槽与板端相机帧观测装配仍开放）
   - 验收：策略输入扩展出图像分支，板端相机帧进入观测构建，评测页可回放对齐帧。

### P2 — 工程与运营

7. **制品编译/签名/OTA 回滚**：上板模型带版本与校验，失败自动回退
   - 验收：坏模型 load 拒绝且 runtime 回到 ready/fault 可恢复态；板上可查当前模型指纹。
   - 进展：模型指纹（sha256/provider/维度/字节数）已随会话事件上板→入 run 详情
     "上板会话"卡（`GET /runs/:id/board-sessions` 的 `model` 字段），station 页
     model 卡同步显示；剩余：坏模型 load 拒绝的板端实测与自动回退演练。
8. **多人权限**：策略开关按用户角色下放，操作审计入台账
   - **已完成控制面**：角色权限、跨租户边界、部署审批和 NDJSON 审计已落地；剩余
     是把审计事件接入组织的 SIEM/长期不可变存储，并在真机适配器侧复核每个执行动作。
9. **演示自动预检脚本**：`demo:sim2real` 前一键检查（板可达/隧道/开关/模型在位）
   - **已完成**：`npm run demo:preflight`——全部只读 GET，逐项 ✓/✗ + 修复提示，
     `--strict` 拒绝 mock、`--json` 供脚本消费；自测 `npm run verify:demo-preflight`
     守护 ✓/✗ 分级与"永不发 POST"的安全不变量；demo-runbook 清单已与之一一对应。

## 安全不变量（任何路线项都不得破坏）

- 运动三重开关（平台策略 + 平台驱动 + 板端驱动/策略），默认全关；
- 速度/角速度钳制与 500ms 底盘看门狗是最终底线，急停（含空格键）永远可用；
- 诚实性：mock/合成数据永远标注，遥测与指标永不伪造，fail-closed；
- 浏览器永不直连板端 agent，一律走带认证的代理；
- 真机运动前必须人工确认在场（UI 确认弹窗 + 现场清场）。
