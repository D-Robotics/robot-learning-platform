# OriginMan 直行残差仿真

这是使用调用方提供的 OriginMan 原始模型包建立的自由底座 MuJoCo 环境，训练
连续腿部残差。不是动作选择策略，也不是用球体或差速底盘代替机器人。

当前实现用于离线研发。模型参数未经过样机标定；任何输出都不具备真机部署资格。
现有首轮实验能迈步和完成训练，但没有证明稳定且明显的纠偏收益。

后续独立PPO及两维脚部修正也已完成单种子冻结评测，仍未取得抗扰行走优势。
完整结果见[验证记录](../../docs/originman-rl-validation.md)。本目录同时保留失败实验，
不能将脚本可运行或模型可导出视为动作能力已验收。

## 独立训练器复核

`requirements-sb3.txt` 在原仿真依赖上增加精确固定版本的 Stable Baselines3 和
Gymnasium。`sb3_trial.py` 支持 `--mode joints`（十关节残差）和 `--mode feet`
（两维脚部修正）；两者使用4帧归一化本体观测，均不读取扰动力或世界位置。
脚部动作通过原模型雅可比转换，仍受原环境的接管、幅度及变化率限制。

```bash
uv pip install --python .eval-venv/bin/python -r engines/originman-straight/requirements-sb3.txt
python engines/originman-straight/sb3_trial.py --scene <场景> \
  --experiment <实验JSON> --out <全新目录> --mode feet --steps 1000000
python engines/originman-straight/sb3_receipt.py --run <训练目录> --seal
python engines/originman-straight/tune_axis_feedback.py --scene <场景> \
  --experiment <实验JSON> --out <全新调参目录>
python engines/originman-straight/sb3_evaluate.py --run <训练目录> \
  --feedback <调参目录/feedback.json> --plan <预先固定的测试JSON> --out <全新评测目录>
```

测试JSON包含 `cases`（force与start）及 `plannedRuns`（允许的训练目录名）。
普通反馈的物理轴符号已修正，须重新调参，不能将旧反馈的零增益结论直接沿用。
SB3策略必须同时保存ONNX、归一化与历史帧约定，以及两维模式的 `foot-basis.npy`；
`sb3_receipt.py` 在训练后将这些依赖和模型一起封存。默认Worker仍使用原实现，
旧直行等研究入口仍独立运行；连续髋踝恢复Workshop的页面入口见下文，均未接入板端运行时。

## 原地受扰恢复阶段

具体课堂流程见[4小时基础Workshop](../../docs/workshop-originman-basic.md)。
`workshop.py prepare/train/evaluate` 为每组准备独立配置、运行真实训练与同条件
评测，并生成不隐藏失败的图文页。配置修改必须创建新目录；课堂使用公开基准，
不把反复调参后的课堂成绩称作未见测试。短训练未达收益时如实记录，讲师使用
明确标注的完整训练制品完成效果讲解。运行 `workshop.py --help` 查看入口。

最新连续控制实验使用冻结的稳定PD反馈打底，SAC每20ms读取14维本体状态，
输出髋、踝两维连续修正。在预先固定的31个条件中，基础反馈恢复13次，三个
独立训练种子分别恢复28、28、22次；11个条件共同改善，第三个种子有两个退化。
冻结输出和冻结身体观测的对照均明显弱于完整策略。详见
[连续髋踝RL图文验证](../../docs/originman-continuous-residual.md)。

```bash
.eval-venv/bin/python engines/originman-straight/residual_trial.py \
  --scene <调用方适配的原始场景> \
  --experiment engines/originman-straight/experiments/standing-residual.json \
  --out <全新目录> --steps 500000 --seed 7
```

CLI可独立仿真；`workshop_adapter.py`已通过专用引擎接入工作台训练与独立评测，
见[工作台操作](../../docs/originman-workbench.md)。板端受控部署仍未完成。14维输入、两维修正
不能交给原有41维输入、10维动作的适配器执行。迈步与真机均待验证。

以下保留前一阶段的参数学习记录：

`standing_gain_rl.py` 已得到参数学习型RL的可见仿真结果：PPO从零学习Kp、Kd，
每回合只选择一次反馈参数，执行时PD以50Hz连续形成踝侧摆位置残差。
三个种子在同一31个固定条件中分别恢复19、15、19次，参考和训练前为7次；
同预算的非RL标定也达到19次。它不代表逐时刻神经关节策略或迈步已学会。
完整过程、所有失败和迁移边界见[图文验证](../../docs/originman-standing-recovery.md)。

```bash
.eval-venv/bin/python engines/originman-straight/standing_gain_rl.py train \
  --scene <调用方适配的原始场景> \
  --experiment engines/originman-straight/experiments/standing-recovery.json \
  --out <全新目录> --episodes 2048 --seed 7
```

`standing_env.py` 定义静态参考和恢复检查；`standing_gain_baseline.py` 做匹配预算的
非RL标定；`standing_sensitivity.py` 冻结控制参数检查物理假设；`standing_render.py`
与 `standing_report.py` 生成回放与图文报告。神经策略的未成功实验通过
`standing_trial.py`、`standing_sac.py` 保留。模型、源码、逐回合记录、初始权重、
检查点、最终权重和控制系数均分实验目录保存。恢复实验不接设备，不具备硬件部署资格。

## 复用了什么

- `microduck-football/train_football.py` 的通用 ActorCritic 网络；不调用其足球环境训练。
- `microduck-eval/microduck_eval/wilson.py` 的统计函数。
- 原有 `local-training-worker.mjs` 的请求、进度、制品校验及结果协议。
- 训练引擎 ID `originman-straight` 已进入服务端允许清单。没有新增工作台选择器、
  机器人档案或板端驱动，不把 Worker 接通描述成工作台全流程完成。

## 准备

在仓库根目录运行。Python 3.12 已验证；`requirements.txt` 是本次安装的精确版本快照。
模型与生成网格存到被 Git 忽略的 `artifacts/`，不重新分发厂家模型资产。

```bash
uv venv --python 3.12 .eval-venv
uv pip install --python .eval-venv/bin/python -r engines/originman-straight/requirements.txt

export ORIGINMAN_MODEL_SOURCE=/path/to/originman_urdf.zip
.eval-venv/bin/python engines/originman-straight/model.py \
  --source "$ORIGINMAN_MODEL_SOURCE" --out artifacts/originman-straight/model

RDK_ORIGINMAN_PYTHON="$PWD/.eval-venv/bin/python" \
  node scripts/verify-originman-straight.mjs
```

`--source` 也接受解压后的 ROS 包根目录。ZIP 模式记录原始包 SHA256；生成清单
记录每个网格摘要。模型转换保留原始关节变换及惯性，添加自由根、地面、位置执行器、
陀螺和加速度传感器。每个连杆采用原始碰撞 STL 的包围盒，关闭自碰撞。

位置执行器增益、阻尼、力矩限制、摩擦和采样周期都是可修改的仿真假设。
它们不代表控制板和舵机的实际能力，也不能用这些参数直接驱动样机。

## 训练与配对评测

```bash
.eval-venv/bin/python engines/originman-straight/train.py \
  --scene artifacts/originman-straight/model/scene.xml \
  --out artifacts/originman-straight/run-seed7 \
  --iterations 120 --num-envs 8 --steps 128 --seed 7 --reward-profile legacy

.eval-venv/bin/python engines/originman-straight/evaluate.py \
  --scene artifacts/originman-straight/model/scene.xml \
  --policy artifacts/originman-straight/run-seed7/policy.onnx \
  --out artifacts/originman-straight/eval-seed7 --episodes 30 --seed 1000
```

参考步态由原模型的腿部运动学与 IK 构建，并非已经校准的厂家动作组转换。
每个回合随机化左右腿位置伺服增益与初始偏航。PPO 不使用教师标签。
`straight` 奖励配置为额外试验，首轮表现退化，不是推荐配置。

输出包括检查点、带配置和代码摘要的训练说明、训练曲线、ONNX、逐例评测报告及轨迹。
ONNX 通过结构检查和 Torch/ORT 数值一致性后才从 pending 文件改为正式输出。

### 观测动作约定

| 槽位 | 内容 |
| --- | --- |
| 0 至 2 | 模拟 IMU 三轴角速度 |
| 3 至 5 | 由理想仿真姿态得到的投影重力 |
| 6 至 7 | 相对目标世界 X 方向的航向 sin 与 cos |
| 8 至 17 | 腿部位置相对初始姿态的偏移 |
| 18 至 27 | 腿部角速度乘以 0.1 |
| 28 至 37 | 上一步实际执行的归一化残差 |
| 38 至 39 | 步态相位 sin 与 cos |
| 40 | 参考步幅除以周期 |

动作 10 维按左腿、右腿依次排列：hip_roll、hip_pitch、knee、ank_pitch、ank_roll。
目标为参考角度加受限连续残差。没有身体外力、焊接、位置瞬移或运动学速度注入。
世界位置只用于奖励和评测，不输入策略。姿态与航向目前使用理想仿真值，
板端 IMU 姿态估计、航向积分和漂移处理仍需开发，不能称为已经对齐真机的观测。

### 如何判断改善

评测对参考步态和 RL 使用完全相同的初态、伺服差异和时长，记录侧偏、前进距离、
航向、跌倒及左右脚单支撑帧数。报告保留每例结果、配对侧偏差异的 bootstrap 区间，
以及复用现有函数计算的行走成功率 Wilson 区间。

探索性改善检查要求：两组能迈步，侧偏改善区间为正，且保留至少 95% 前进距离。
它仅用于防止“少走所以偏得少”，不是发布闸门。不能用训练奖励升高代替测试结果。
独立训练种子之间的方差需要另外报告，不能把某个策略的回合置信区间当成训练稳定性。

```bash
# 固定首个案例，可观看双画面真实模型步态；需要可用的本地 OpenGL 与 ffmpeg。
.eval-venv/bin/python engines/originman-straight/render.py \
  --scene artifacts/originman-straight/model/scene.xml \
  --policy artifacts/originman-straight/run-seed7/policy.onnx \
  --report artifacts/originman-straight/eval-seed7/eval-report.json \
  --out artifacts/originman-straight/comparison-seed7-case0.mp4
```

## 现有 Worker 接入

可信服务配置 `ORIGINMAN_SCENE`，请求不接受客户端任意模型路径。
`RDK_SIM2REAL_TRAIN_ENGINES_JSON` 中注册 `originman-straight`，executable 为 Python
绝对路径，args 为本目录 `platform_adapter.py` 的绝对路径。保留现有引擎注册项。

请求使用 `taskId=originman-straight-residual`、41 维观测和 10 维动作，算法只接受 PPO。
当前 Worker 适配固定训练 seed 7 和 legacy 配置，使用请求中的环境数和迭代数；
独立算法研究走 CLI。所有结果均为 `deployable=false`。

```bash
# 自己创建 Worker、随机端口和独立账本；完成后关闭自己创建的进程，不连接设备。
.eval-venv/bin/python engines/originman-straight/worker_smoke.py \
  --scene artifacts/originman-straight/model/scene.xml \
  --out artifacts/originman-straight/worker-rehearsal
```

`worker_smoke` 只证明真实 Worker 能执行短训练、解析进度并校验产物，不能作为步态质量证据。
厂家与真机待办单独见 [确认与验证清单](../../docs/originman-confirmation-and-hardware.md)。

## 原始脚底网格与受扰步态验证

模型转换可显式选择 `--foot-collision convex-mesh`，将两个脚底的碰撞包围盒改为
原始碰撞 STL 的凸包。IK 使用独立脚部坐标系，初始接地高度按网格顶点计算；
保留原来的质量惯量，身体其他碰撞仍是包围盒，自碰撞默认关闭。这不是实测脚底模型。

`contact_probe.py --source <模型包> --frozen <踢球实验目录> --out <新目录>`
比较两种脚底与四个步长，保留正常迈步和冻结踢法的完整结果。

受扰训练仍复用原 PPO、源码快照和可视化日志。环境配置中的 `push_max_force`
默认为零；启用时，每回合在1.2至2.4秒内随机安排一次侧向躯干质心扰动，
持续 `push_duration` 秒，力在正负最大值之间采样。力不作为策略输入。
`velocity_filter_seconds` 只平滑奖励所用速度，默认为零；不向策略增加速度真值。

训练参数 `reward_scale` 只缩放学习回报，原始奖励继续记录；`target_kl` 为非零时
限制策略更新幅度。默认值分别为1和0，兼容旧实验。它们不改变动作成功标准。

```bash
# 实验JSON明确包含扰动、奖励、学习参数和预算，必须使用新输出目录。
python engines/originman-straight/train.py \
  --scene <模型场景> --experiment <实验JSON> --out <新训练目录>

# 调参只用TUNE_CASES；13个旧测试条件在看过结果后作为开发/回归检查。
python engines/originman-straight/push_eval.py \
  --scene <模型场景> --policy <训练目录/policy.onnx> --out <新评测目录>

# 新最终条件需预先声明，并在plan.plannedRuns中列出实验名；只评测最终权重。
python engines/originman-straight/push_final_eval.py \
  --plan <最终条件JSON> --scene <模型场景> --policy <训练目录/policy.onnx> \
  --feedback <调参目录/feedback.json> --out <新最终评测目录>

python engines/originman-straight/render_push.py \
  --scene <模型场景> --evaluation <评测目录> --out <对照.mp4>
```

`push_transfer_eval.py` 另有冻结控制器的假设物理参数迁移检查；参数范围不是
制造商边界。当前理想姿态和关节观测尚未用真机估计链路替代。

详见[能力验证进展](../../docs/originman-rl-validation.md)。尚无可以标记为已落地的
OriginMan RL动作；失败、正常行走退化和测试条件不能从结果中删去。

后续接管试验支持独立值函数 `training.value_network="separate"`、可配置重置范围、
残差代价与基于IMU的接管阈值。默认仍使用共享值函数和全程残差，以读取旧实验配置。
未开放接管的状态仅训练值函数，不用未执行的随机动作更新策略。独立值函数不会通过
共享特征反向改变动作网络；这不等同已证明训练效果。

`diagnose_policy.py` 检查标称无扰动行走保留以及值函数单独更新的动作漂移。
`recovery_report.py` 汇总全部条件，明确列出改善与退化的条件编号。
`render_push.py --case-index N` 可重放指定条件；从结果中选择的例子必须同时提供
完整结果，不能把示例视频当成整体效果。

扰动采样支持 `push_min_force`、`push_start_min`、`push_start_max`。默认保留旧范围；
非零最小力时对正负方向对称采样。最大扰动时刻加持续时间必须落在回合内。
这些设置只供训练和仿真评测，不是实物控制参数。

## 物理推力计时与评测来源

外部扰动现按物理子步施加，不再依赖浮点累加的控制时钟判断整段推力。
`externalImpulseWorldNs`记录控制周期内的冲量；`externalForceWorldN`为该周期
平均力；`externalForceWindowSeconds`记录实际作用窗口。接管保持时间采用控制步计数。
这使非对齐脉冲的冲量不随控制周期变化，但不解决真实传感和通信延迟。

`force_clock_audit.py`核对对齐事件，测试还覆盖非对齐脉冲。`timing_probe.py`
冻结控制器，比较20、40、50ms控制周期；其比例是开发场景覆盖，不是设备实测。
`evaluation_evidence.py`为评测另外保存源码、模型摘要和运行时，结束时检查变更，
不能默认评测使用的环境与训练时完全一致。

最新三个独立种子的500轮训练与25条件评测未产生总体收益。`seed_report.py`
汇总全部预声明种子和条件，不按最好视频或检查点决定结果。当前无合格的实机
动作，下一步需要样机和标定证据；完整结论见能力验证记录。

## Workshop 受扰恢复回放

`standing_render.py` 的 `render(scene, evaluation, out, case_index, font)` 入口保持不变，
课程评测仍由 `workshop_adapter.py` 调用。渲染读取原始四组 `qpos`，只调用
`mj_forward` 更新可视姿态，不重跑动力学、不插值姿态、不改策略或恢复判定。

课堂版使用统一的前侧方固定镜头、10 cm 地面参照网格、浅色壳体与深色关节，
主光、补光和接地阴影仅在渲染模型／可视场景中配置。箭头沿记录中的世界坐标
受力方向绘制；力值取记录样本，不能把采样力解释为更精细的物理子步测量。

四组共用物理时钟和镜头。扰动附近以 0.5 倍速播放，顶部显示真实物理时间与
播放速度；最后停留一秒并标注。输入样本间使用保持前一姿态的方式回放，
不生成新姿态。跌倒组到记录末尾后明确显示“已记录跌倒／保持末帧”，恢复通过
只在该组记录结束后读取原始 `recoverySuccess`。无受力记录时不画箭头、不编造
扰动。时间轴的橙色段是有受力采样支持的区间，不是精确的子步脉冲边界。

`--font <支持中文的字体文件>` 或 Worker 的 `ORIGINMAN_RENDER_FONT` 可启用中文；
不提供字体时使用英文，字体文件不随代码分发。输出 `.case.json` 保留原判定，
另记录输入摘要、渲染源码摘要、运行时、镜头及慢放／停留信息。

验证：`python engines/originman-straight/tests/test_replay_presentation.py`，再使用真实
四组轨迹重渲染并检查受推、恢复与终态帧。画面优化不代表策略质量提升；单个
条件的样片须与全部条件的评测结果区分。历史视频需重新渲染才会使用新画面。
