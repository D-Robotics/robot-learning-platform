# 任务仿真、录制与回放

工作台的任务选择器同时选择训练任务和可交互场景。行走、转向、坐下、恢复、踢球和自定义动作使用经过审核的 MicroDuck 浏览器 release；篮球、高跷、稳定球、梯杆、秋千和足球使用训练引擎本身的 MuJoCo 环境。后者由本地 Python 服务执行物理步进，浏览器根据每次返回的几何、位姿和指标绘制 WebGL 场景。

| 任务 | 运行环境 | 操作接口 |
| --- | --- | --- |
| 行走 / 转向 / 坐下 / 自恢复 / 踢球 / 自定义动作 | MicroDuck WASM 与参考策略 | 原有键盘、手柄与触屏；恢复任务提供明确点击的跌倒测试 |
| 篮球 / 高跷 / 大稳定球 / 梯杆 / 秋千 | `microduck-recurrent` 的 MuJoCo 代理模型 | 14 维姿态目标、真实步进、奖励与终止状态 |
| 单鸭射门 / 2v2 / 3v3 | `microduck-football` 的 MuJoCo 代理模型 | 每只受控鸭 4 维高层动作；多人任务包含脚本对手 |

任务动力学、碰撞、观测、动作和奖励仍由训练引擎的代理模型计算。画面优先复用审核后的上游 MicroDuck 可视模型，跟随服务返回的机器人实际参考位置与姿态；可视模型的高度对齐及代理关节到可视骨架的姿态适配只影响显示，不改变物理模型。未挂载可视资产或资产加载失败时，显示明确标注的机械鸭简模。界面会标明当前使用的可视外观及代理动力学，回放快照仍来自实际执行的训练环境。

足球的动作契约是前进、横移、预留转向和踢球，与部署到实体 MicroDuck 的 61D 观测 / 14D 伺服策略契约不同。查看画面、手动驱动和浏览器策略试跑可用于开发验证；制品签发与板端部署仍按平台评测和预检流程执行。

## 本地启动

在仓库根目录准备服务的固定依赖。当前锁定的 NumPy 要求 Python 3.12 或更新版本：

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -r services/mujoco-web/requirements.txt
node scripts/start-task-simulator.mjs --check
node scripts/start-task-simulator.mjs
```

启动器先导入真实服务并编译所有已声明的任务模型，通过后才启动 Uvicorn。默认使用 `127.0.0.1:18100`。显式设置 `RDK_SIM2REAL_PYTHON` 可指定解释器；否则依次检查仓库 `.venv/bin/python`、服务目录 `.venv/bin/python` 和 `python3`。`--root` 可选择打包后的根目录，`--port` 和 `--host` 可设置监听位置。

另开终端启动工作台，通过现有同源桥接访问任务 API：

```bash
RDK_SIM2REAL_MUJOCO_WEB_URL=http://127.0.0.1:18100 npm run dev:sim2real
```

在工作台选择高跷、篮球或足球任务后，场景准备完成才启用操作。使用“开始仿真”“单步”和动作滑杆驱动物理环境；“重置”建立新回合。足球场景聚焦后可用 W/S 前后、A/D 横移、空格踢球，键盘控制智能体 1，其余受控智能体使用各自滑杆。脚本对手由训练引擎驱动。

这组任务的物理步进无需上游 MicroDuck 静态包，未挂载时采用机械鸭简模。若要使用上游外观，将审核后的浏览器 release 挂载到 `RDK_SIM2REAL_MICRODUCK_ROOT`；浏览器读取其中 `robot/mjlab/microduck.glb` 的命名几何体和 `kinematics.json` 的装配层级。基础动作任务仍需要完整浏览器 release。获取、来源登记、许可与校验流程见 [`services/mujoco-web/MICRODUCK-UPSTREAM.md`](../services/mujoco-web/MICRODUCK-UPSTREAM.md)，本地挂载配置见 [`services/mujoco-web/README.md`](../services/mujoco-web/README.md)。这些上游可视资产不复制进公开仓库，部署者保留原 release 的许可证、模型文件条款和归属文件。更新覆盖层后，用 `install-microduck-overlay.py` 把本仓库最新的任务桥、录制和策略装载功能同步到该 release。

## 自有机器人外观

训练引擎任务页面可使用部署者审核过的自有可视模型。先把 GLB 与 `kinematics.json` 部署到工作台的同源静态目录，再在已有模型 Manifest 的 `simulator` 中设置目录；下面是局部配置，`policyArtifactId` 仍引用该模型已经登记的 ONNX 制品：

```json
{
  "simulator": {
    "backends": ["local"],
    "policyArtifactId": "your-existing-policy",
    "visualAssetBase": "/sim2real/visual-models/my-duck/"
  }
}
```

`visualAssetBase` 是以 `/` 开头并结尾的同源绝对目录路径，路径段只使用字母、数字、点、下划线、连字符或 `~`。配置不接受完整 URL、双斜线、`..`、单独的 `.` 路径段、百分号编码、查询参数、片段或反斜线。归一化保留合法路径，不会在服务端抓取任意 URL。工作台通过现有 `duckAssetBase` 参数把这个目录交给任务 iframe；未设置时保留审核后的 MicroDuck 默认外观。

`kinematics.json` 中的 `bodies` 描述命名网格、父子层级、局部位置、四元数和可选 hinge 关节。GLB 使用带 POSITION 和三角索引的命名网格，网格名须与装配文件一致。装配文件可增加以下外观设置：

```json
{
  "visualModel": {
    "displayName": "My Duck",
    "meshFile": "robot.glb",
    "palette": "source"
  }
}
```

保留该文件实际的 `bodies` 装配数据；`meshFile` 只能指定同目录的 GLB 文件名。可视装配最多 100 个 body，关节索引范围为 0–255；`defaultPose`、`postureScale` 和 `postureMap` 可配置默认角度、显示增量比例及任务姿态通道映射。它们是外观适配，不是实测关节角。资产加载失败会明确显示机械鸭替代外观，任务物理仍可独立操作。

这个配置仅替换画面中的机器人外观，当前任务的碰撞、质量、关节、观测、奖励和物理快照保持原训练环境的定义。接入自有机器人的真实物理与训练，需要部署自己的 MJCF、任务适配器和策略契约，并验证对应环境与控制链路。

## 共享部署的身份边界

共享服务中，基础 MicroDuck WASM 场景可用于游客试玩；Python 引擎与 OriginBot 的会话操作需要登录。模型、项目、运行及证据台账按 owner 隔离。浏览器检测账号切换、退出或会话失效时，会停止录制和策略、卸载主场景与回放 iframe，并清除旧账号的本地轨迹、遥测、回放和项目/模型/设备选择；延迟消息和响应无法恢复旧账号数据。正常匿名本地刷新保留当前本地录制。

Node 与 Python 服务须通过私有运行配置设置相同的 `RDK_SIM2REAL_SIMULATION_SECRET`，密钥至少 32 个 UTF-8 字节；Node 同时配置 `RDK_SIM2REAL_MUJOCO_WEB_URL` 指向内部 Python 服务。密钥由服务端签名桥使用，不传给浏览器、Manifest 或公开文档。共享部署缺失有效密钥时，会话接口拒绝服务。两类仿真会话共用每账号 4 个、全局 32 个的配额；达到配额时返回明确的容量错误，关闭闲置场景后再创建。

## 录制与回放

“开始录制”保存真实环境返回的观测、动作、奖励、终止状态和完整物理快照，可导出 JSONL，并自动进入工作台遥测和回放流程。切换任务前结束并保存上一段轨迹，避免把两种模型混在同一录制中。离开仿真视图会停止该视图的运行和录制。

引擎任务回放要求任务 ID 与当前场景匹配，并携带完整引擎快照；服务校验状态维度和数值后恢复实际 MuJoCo 状态。基础 MicroDuck 新录制包含完整 `qpos` / `qvel`；历史轨迹若只有浮动基座状态，会明确报告仅恢复基座。缺少状态快照或属于另一任务的轨迹会给出失败原因。

基础 MicroDuck 的隐藏视图与回放通过覆盖层保持物理状态，并锁定输入。上游 ONNX 控制循环仍可在内部计算；该覆盖层未提供停止上游推理循环的接口。

## 策略试跑

在回放页选择带真实 ONNX 制品的已完成本地训练，点击浏览器策略试跑。任务场景先核对运行归属，再下载平台已校验的制品，并检查 ONNX 的输入、输出、动作数及循环状态接口。循环策略的隐藏状态逐步传递，多智能体足球按实际智能体数生成动作批次。接口或任务不匹配时停止并显示原因。

基础 MicroDuck 先确认上游实际装载了请求的 ONNX 会话，再按任务绑定原生策略槽位：行走、转向和自定义动作使用 `walk`，坐下使用 `sitstand`，踢球使用 `kickL` / `kickR`，恢复使用 `stand`。装载完成只表示已准备；界面收到对应任务模式下的一次有效推理后才显示正在执行，并统计实际任务推理次数。踢球需要按 Q / E 或点击踢球按钮；恢复需要点击“测试跌倒恢复”，由上游跌倒状态机进入恢复阶段后执行。达到推理次数或时间上限、手动停止、替换策略或上游看门狗撤销时，覆盖层恢复所有受影响的参考槽位。

引擎任务由浏览器 ONNX 推理结果驱动相同的 Python MuJoCo 环境，并显示每步奖励。可随时停止；回合结束、策略数值异常或服务失联也会结束试跑。基础 MicroDuck 录制同时限制 30,000 帧与 30 MiB JSONL 字节，自动结束后保留可导出轨迹，给工作台 32 MiB 导入上限留出余量。

## 单独打包 Python 服务

```bash
node scripts/package-task-simulator.mjs --output dist/task-simulator
```

输出保留 `services/mujoco-web`、必要引擎模块、OriginBot 标定资产和启动器的相对布局，包含每个文件的 SHA-256 清单。目录必须为空；训练 checkpoint、视频、引擎证据、虚拟环境、凭据和设备配置均不会进入包。部署时在输出根目录安装 `services/mujoco-web/requirements.txt`，运行 `node scripts/start-task-simulator.mjs --check` 再启动服务。工作台单独部署并配置 `RDK_SIM2REAL_MUJOCO_WEB_URL`；共享部署还须按上面的身份边界配置双方私有密钥。

使用 [`install-nginx-route.py`](../services/mujoco-web/install-nginx-route.py) 安装具体 API 路由：`/mujoco/api`、`/mujoco/api/` 及兼容的 `/sim2real/mujoco/api` 路径先经过 Node 工作台服务的身份和签名门禁，再由 Node 转发到内部 Python 服务。`/mujoco/` 的普通静态/实验室页面路由可以继续保留；不要让更具体的会话 API 直接绕过 Node。部署后同时检查 Nginx 的有效路由与 Node/Python 的私有配置。

沿用 `mujoco-web.service` 时，按 [`services/mujoco-web/README.md`](../services/mujoco-web/README.md) 的生产步骤复制整个包，把 `current` 指向包中的 `services/mujoco-web` 子目录。相邻的 `engines/` 和 `assets/` 需要保留在发行根目录；仅复制服务子目录会缺少任务模块和标定资产。部署者自有的模型注册 JSON 通过配置管理加入发行版的 `services/mujoco-web/registry/`，不会从开发机自动打包。

验证服务时，检查 `GET /healthz` 与 `GET /api/task-scenes`，再实际创建任务会话、执行单步并删除会话。通过工作台的同源桥接时 API 路径为 `/mujoco/api/task-scenes` 和 `/mujoco/api/task-sessions`。`--check` 证明依赖、模块和模型编译可用；浏览器主路径还应实际完成切换场景、操作、录制、回放与异常状态检查。

## 回归检查

```bash
.venv/bin/python -m pip install -r services/mujoco-web/requirements-test.txt
npm run verify:simulation
```

检查覆盖任务场景编译与真实步进、物理状态恢复、录制导出、工作台场景联动、策略装载和遥测上传的回放快照保留。缺少 Python 测试依赖会明确失败；`RDK_SIM2REAL_PYTHON` 可指定已准备好的解释器。

本次录制会显示在「轨迹与回放」中，无需先建立训练 Run；点击「回放本次录制」可在回放页查看实际场景并拖动时间轴。刷新页面前请导出 JSONL。重新导入带物理快照的文件可继续本地回放。

循环任务轨迹的观测与动作符合 `microduck-policy-v1` 的 61D / 14D 接口，仅可上传到同任务且契约匹配的 Run。代理场景来源仍作为普通仿真导入证据保存，不产生板端认证。足球轨迹保留自身 4D 高层动作契约，可本地回放和导出，不能直接绑定到 14D 伺服契约 Run。
