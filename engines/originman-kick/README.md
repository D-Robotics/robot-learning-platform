# OriginMan 定点出球距离验证

比较固定踢法、无 RL 的标定插值和 PPO 对目标距离的跟踪。使用调用方提供并适配的
OriginMan 全身模型，新增自由球体与脚球碰撞，不注入球速或机器人前进力。

本项目是离线验证，不是可部署的踢球能力。当前结果表明，PPO 可以学习目标距离到
摆腿参数的映射，但没有稳定优于标定插值，不应把“能踢近踢远”宣传为 RL 独有收益。

## 学习范围

策略每次踢球输出一组连续参数：摆腿前向终点与前摆时长。共同的 IK 和平滑参考轨迹
把它们转换为腿部关节目标。PPO 以完整物理回合结束后的距离、方向、接触和站稳结果
学习。这是单步情境 MDP 的轨迹参数策略，不是逐控制周期的全关节反馈 RL。

球位已知，目标是从球初始位置开始的前向位移，不是距机器人或球门的距离。
没有机载视觉定位，也没有绕球、走近或自主找球。

## 运行

复用 `originman-straight` 的 Python 依赖环境及转换后的原始机器人场景。

```bash
uv pip install --python .eval-venv/bin/python -r engines/originman-kick/requirements.txt

# 全新输出目录；拒绝覆盖已有实验。
.eval-venv/bin/python engines/originman-kick/experiment.py \
  --source-scene artifacts/originman-straight/model/scene.xml \
  --out artifacts/originman-kick/verification-new

# 固定最终权重，补测更密的目标距离，不再训练或挑选检查点。
.eval-venv/bin/python engines/originman-kick/extended_eval.py \
  --root artifacts/originman-kick/verification-new

.eval-venv/bin/python engines/originman-kick/report.py \
  --root artifacts/originman-kick/verification-new

# 需要可用的本地 OpenGL 和 ffmpeg。
.eval-venv/bin/python engines/originman-kick/render_comparison.py \
  --root artifacts/originman-kick/verification-new
```

`experiment.py` 内明确列出训练目标、测试目标、随机种子、参数范围与 PPO 超参数。
首轮先执行 63 个参数标定回合，再对三个种子各训练 384 个物理回合。标定插值只使用
稳定慢速动作的标定点，不使用测试结果。PPO 没有使用标定动作作教师标签。

输出保留逐回合奖励分项、每轮训练指标、多个权重检查点、采样关节及球轨迹、ONNX
数值一致性结果，以及训练开始时的源码快照。最终报告保留全部种子，不选最好一次。

所有距离是 MuJoCo 动力学产生的球位移；测试同时检查脚球接触、跌倒、其他身体部位
撞球、侧向误差、身体平移、最终姿态与球速。跌倒后的碰球不能算成功。

## 行为检查

```bash
ORIGINMAN_SCENE="$PWD/artifacts/originman-straight/model/scene.xml" \
RDK_ORIGINMAN_PYTHON="$PWD/.eval-venv/bin/python" \
node scripts/verify-originman-kick.mjs
```

检查自由机器人和自由球、未接触时球不自行移动、慢速踢球与恢复、摔倒失效、参数重置
和训练测试目标分离。依赖或资产缺失不会以代理底盘代替机器人。

## 边界

沿用当前模型的质量惯量与简化包围盒，关闭自碰撞。球质量、摩擦、伺服增益与接触参数
都是未经过实物标定的仿真假设。球的摩擦也不是策略输入，不能声称策略识别摩擦并补偿。

最终比较是有限、确定性的配对场景覆盖，不是独立随机实机成功率。厂家和真机待办沿用
[单独清单](../../docs/originman-confirmation-and-hardware.md)，并追加球位可见性、标定、
脚球接触及踢后恢复验证。新实验未接入工作台选项或板端运行时，制品不具备硬件部署资格。

## 仿真可信度复核

`fidelity_probe.py` 冻结已训练权重和标定表，分别执行单因素参数敏感性与时间步长检查。
它不重新标定、不重训，也不代表实测硬件参数范围。每个条件对三个固定目标比较
标定插值和三个 PPO 种子，保留全部回合及源码、输入哈希。

```bash
.eval-venv/bin/python engines/originman-kick/fidelity_probe.py \
  --root artifacts/originman-kick/verification-new \
  --out artifacts/originman-kick/fidelity-new --suite sensitivity
.eval-venv/bin/python engines/originman-kick/fidelity_probe.py \
  --root artifacts/originman-kick/verification-new \
  --out artifacts/originman-kick/convergence-new --suite convergence
.eval-venv/bin/python engines/originman-straight/sole_audit.py \
  --meshes artifacts/originman-straight/model/meshes \
  --out artifacts/originman-kick/convergence-new/sole-audit.json
.eval-venv/bin/python engines/originman-kick/fidelity_report.py \
  --sensitivity artifacts/originman-kick/fidelity-new \
  --convergence artifacts/originman-kick/convergence-new \
  --out artifacts/originman-kick/fidelity-report-new
```

物理步长改变时仍保持 20ms 控制周期。固定命令延迟通过目标队列施加，未模拟完整
传感链路。脚底缩小和打开包围盒自碰撞只是压力检查，不等于精确接触几何。
`sole_audit.py` 只检查原始网格局部 Z 底层顶点凸包，不能替代真机接触测量。

当前数据尚未证明毫米级时间步长收敛，原有方法之间的毫米级差异不支持精度排序。
优先处理模型与数值可信度，再继续任务训练；没有样机不标记为已落地。
