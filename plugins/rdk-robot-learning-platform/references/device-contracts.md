# 板端与机械臂契约

## 连接和只读诊断

`rdk_device_discover` 返回已保存连接，`rdk_device_connect` 接受真实 connectionId，SSH 使用部署服务器现有密钥/agent，不保存密码。多个 device 的 station 类 handler 支持可选 `deviceId`，应按用户目标传入。

读取 health/onboarding/station/policy/files/arm 状态。板端没有接入时 503、相机不可用、TROS 必需话题缺失、遥测陈旧等都保留为阻断，不生成假画面/假遥测。`rdk_board_station_command` 只接受白名单 ID，不扩大成 shell。

## 策略暂存、加载和启动

`rdk_board_policy_stage` 必需 runId，默认文件名由平台生成。真实 completed、非 Mock local ONNX、SHA-256 与发布证据通过后，worker 服务前重哈希 → 平台交叉比对 → agent 写盘前校验。staging 只原子落盘，不加载不运动；同名仅相同哈希可幂等重下发。

`rdk_board_policy_load` 的 path 是 policies 目录内文件名。开启加载 rehearsal 门禁的部署还需要 `artifactSha256` 和真实 `rehearsalReceipt`，平台绑定已暂存文件摘要再裁判。传入 `rehearsalReceipt` 或摘要字段不意味着 handler 会信任它，门禁会核对来源和内容。

输入布局、provider 和 ONNX 图必须与 adapter/contract 一致。请求 BPU 但 runtime 无相应 provider、循环输入未实现、存在未绑定图输入、状态/维度失配均须明确拒绝，不能静默用 CPU/零状态降级。

`rdk_board_policy_start` 必需数值 direction，可附 goalX/goalY。三层/多重开关的具体组合从当前平台与板端代码读取；插件不假设开启一个开关即可。运动前的范围、现场授权与设备装配不得由软件 preflight 代替。

## D6A 机械臂

先读取 arm status 真实 capability、当前位姿和 workspace。move 的 x/y/z 单位为 mm，speedMmPerS 为速度；gripper action 只能 open/close，value 为正数（open=宽度 mm、close=力）。平台与板端都钳制并门控，不将“钳制后成功”报告为完全执行用户越界要求。

`rdk_board_arm_stop` 停止新命令并尽力回 home，可能实际移动；返回 homed=false 就未证明归位。`rdk_board_stop` 独立尝试策略、底盘、机械臂停止，部分失败意味着对应状态未知。回读状态后报告送达和执行情况。

## 更多真实入口

相机流、传感器/ROS UI、Local Bridge、设备登记/删除、受控开关和 policy-infer 均有实际工作台/HTTP 入口，见 [API 工作流](api-workflows.md)。policy-infer 批量推理上限 64 行，不驱动电机，因此不要求运动开关；仍需平台鉴权、加载模型和维度/有限值校验。

现场安装、只读 preflight、标定、纯推理与延迟测试见 [仓库能力](cli-capabilities.md)。脚本 SSH 坐标从环境提供，不写进插件。调用站内 API 与现场 SSH CLI 时保留凭据边界与当前用户授权，不扩展到任意主机维护。
