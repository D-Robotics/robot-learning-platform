# Workshop 分层验收

用户要求“插件能否从零到一完成 Workshop”“只接开发板先走软件”“复测教学链路”时读本页。
先声明本轮终点：软件训练、策略闭环质量、板端纯计算和实体运动是四个独立结果。
使用当前源码与新收据，不复用旧截图或旧账本作为本轮通过证据。

## 1. 验证宿主真的接入插件

用受支持 Node 运行 `npm run verify:plugin` 和
`npm run verify:studio-plugin -- --studio-root <目标Studio源码>`。
核对真实 importer → 默认 MCP loader → stdio Tool.execute → 认证平台路由，
以及默认 MossApp 技能注册表 → 精确 load_skill；不能手工注入 extraDirs 冒充默认接线。
保留设置覆盖、禁用、账号隔离和 shared-web 边界。

另在用户实际客户端发起只读技能/状态请求。源码 fixture 通过与已安装应用是不同对象；
网关报错且未调用工具时记录模型通道阻断，不把它记为平台业务失败或 Workshop 成功。

## 2. 录制真实且有因果配对的数据

使用独立 storage、随机空闲端口和新 ledger。运行真实 MuJoCo/ONNX，逐段 reset；
等待重生动画和 inputLocked 释放，确认观测的命令槽实际收到目标命令，再计录制时间。
覆盖站立、前进、转向及重复回合，记录真实采样数和仿真时间。

只保存同次推理前的实际 observation 和该次输出 action，逐帧保留
`pairing=policy-inference-v1`。轮询推理后的 lastAction 会把标签泄漏到输入，
可在变化轨迹上用 last_action 身份基线与输入/输出时序辅助诊断；常量站立片段本身
不能用于证明是否泄漏。旧 browser 数据缺配对标记时重新采集。

UI 上传后通过 owner-scoped HTTP 读回核对向量、来源、标记与帧数。MCP 摘要应省去
原始向量；回放总帧数使用服务端权威 scalar，投影后数组长度只代表传输子集。
不得将 12 个投影帧冒充完整轨迹，也不为过预算问题随意截断训练数据。

## 3. 证明数据被训练消费

用 `demonstrationRunId` 提交真实 offline-bc Worker；记录稳定幂等键和 Run。
核对 canonical JSONL SHA-256、平台 trainingData、Worker 消费摘要、ONNX 字节与清单。
`datasetIds` 只关联血缘，queued、文件存在或低损失都不能证明消费完成。

重复同一输入时复用已有录制并声明 reused-recording 与原始摘要；不必重录来排查
与数据无关的传输问题。新建账本与 Run，保留旧失败收据，不能复用一份会增长的 ledger。
按实际源码读取快照、Worker 请求和分片上限，增加预算时保持有界并测试超限拒绝。

## 4. 单独裁决策略质量

在独立 reset 回合比较 reference、learned、zero，测量阶段确认命令、物理时间、
有限状态、跌倒、实际控制器与跟踪误差。自动重生或回退参考控制器不能抹去此前失败。
同轨迹内相邻帧的验证损失不是独立闭环泛化证据。

加载器拒绝时保存原始原因，实际 learned rollout 计数为零；不要绕过校验，或把
执行完“检查拒绝”说成 learned 控制成功。近零 smoke 可能严重偏离训练观测分布，
应另测真实输入的输出方差并区分全域常量与离分布饱和；诊断原因不自动等于质量通过。

分别报告 softwareExecutionPassed、qualityPassed、deployable、physicalStandOrWalkVerified。
策略质量不过时保留失败与原始制品，不按软件步骤通过数放行部署。

## 5. 开发板与交付

只有开发板时复用 [设备契约](device-contracts.md) 的纯计算路径：核对同字节模型、
完整 ONNX 输入/输出和 synthetic probe，使用唯一临时目录，验证零发布和模板启动拒绝。
本机 ORT 对拍不是板端实测；缺本体不能验收站立或行走。

保存连接失效时先读实际错误。已认证 Studio 终端的新 uname 回显可以验证恢复，
不要因独立 BatchMode SSH 失败读取保存密码，也不要只凭缓存的“SSH已连接”标头。
保留生产环境和运动开关；只清理本次创建且路径已核对的临时目录。

提交前运行当前仓库对应门禁，逐项记录 exit code。冻结审核因源码变化失效、
上游锁漂移、依赖缺失、策略拒载或断连都须保留，不更新基线来伪造通过。
