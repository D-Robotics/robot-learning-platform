# visual-ppo 引擎（相机像素 → CNN PPO → ONNX）

`engines/visual-ppo` 把「策略真正看像素」补进平台能力矩阵：CPU MuJoCo 离屏渲染
固定顶置相机帧（48×48 灰度）+ 4 维本体感受作为观测，纯 JAX CNN+PPO 训练，
导出带 Conv 算子的 ONNX。此前视觉只在 mujoco-web 的回放端出现，从未进入训练
回路——本引擎闭合该缺口。

引擎目录内的 [README](../../engines/visual-ppo/README.md) 是运行手册（依赖、
环境变量旋钮、契约表）；本页补平台视角：能力定位、跨引擎关系和验证口径。

| 引擎 | 依赖 | 定位 |
| --- | --- | --- |
| `engines/visual-ppo` | mujoco（含离屏渲染栈）+ jax + optax + onnx | **视觉观测训练（CPU 路径）**：渲染像素 + 本体感受混合观测，CNN PPO，ONNX 数值等价可复算 |

## 能力定位

- **观测真的是渲染像素**：每步 `mujoco.Renderer.render()` 采样相机帧，没有
  渲染栈（无 GL）时拒绝运行（exit 3 REFUSED），绝不退回「假装看过像素」。
  测试断言帧随世界变化（机器人动/目标标记动 → 像素变）。
- **物理场景是共享单一源**：编译 mjx-adapter 的 `build_mjcf`（墙、标定机器人、
  力限速度伺服、mocap 障碍），再附加相机与 mocap 目标标记——视觉训练与状态
  训练看到同一个世界，不手搓第二台机器人。
- `physicsBackend = "cpu-mujoco-vision"`，`deployable` 恒为 `false`（板端部署
  需要 BPU 视觉管线，本引擎只产出源策略工件）。
- CPU 路径，分辨率刻意压在 48×48——够分辨机器人/障碍/目标盘，CNN 小到 CPU
  可训。更高分辨率的视觉训练属于 mjlab/Warp GPU 路线，不在此引擎冒充。
- smoke 评级不保证成功率：successRate 如实上报，质量门语义与其他引擎一致。

## 跨引擎关系

与其他引擎同一物理内核（`build_mjcf` 单一源），质量门跨引擎可比：

| 引擎 | 观测 | 物理 |
| --- | --- | --- |
| starter-ppo | 板载 8D | 运动学（numpy） |
| mjx-adapter | 板载 8D / 42D | MuJoCo MJX 接触动力学 |
| visual-ppo | **2308 = 48×48 灰度 + 4 本体感受** | MuJoCo CPU（同源 MJCF） |
| dm-control-adapter | 板载 8D | MuJoCo CPU（同源 MJCF，经 dm_control env API） |

## 测试与验证

```bash
# 单元测试（9 个：共享场景源、像素真实性、ONNX 数值等价与 Conv 存在、worker 协议）
engines/mjx-adapter/.venv/bin/python -m unittest discover -s engines/visual-ppo -p 'test_visual_ppo.py' -v
# 端到端 verify（真实跑 smoke 训练 + 导出 + 评测；无渲染栈/无 Python 栈 SKIP 退出 0）
npm run verify:vision-observation
```

ONNX 与 JAX 前向数值等价是硬断言（同输入逐元素一致），不是「形状对就过」——
这是视觉策略能被下游评测信任的前提。
