# visual-ppo — 视觉观测训练引擎（相机像素 → CNN PPO → ONNX）

把"策略真正看像素"补进平台能力矩阵的第一条仓内路径：CPU MuJoCo 离屏渲染
固定顶置相机帧（48×48 灰度）+ 4 维本体感受（sin/cos yaw、v/w 一阶滞后）作为
观测，纯 JAX CNN+PPO 训练，导出带 Conv 算子的 ONNX。此前视觉只在
mujoco-web 的回放端出现，从未进入训练回路 —— 本引擎闭合该缺口。

## 诚实边界（先读这个）

* **观测真的是渲染像素**：每步 `mujoco.Renderer.render()` 采样相机帧，
  没有渲染栈（无 GL）时拒绝运行（exit 3），绝不退回"假装看过像素"。
  测试断言帧随世界变化（机器人动 / 目标标记动 → 像素变）。
* **物理场景是共享单一源**：编译 mjx-adapter 的 `build_mjcf`（墙、标定
  机器人、力限速度伺服、mocap 障碍），再附加相机与 mocap 目标标记 ——
  视觉训练与状态训练看到同一个世界，不手搓第二台机器人。
* **physicsBackend = `cpu-mujoco-vision`**，deployable 恒为 false
  （板端部署需要 BPU 视觉管线，本引擎只产出源策略工件）。
* **是 CPU 路径**：渲染与训练都在 CPU（macOS CGL / Linux EGL 皆可），
  分辨率刻意压在 48×48 —— 够分辨机器人/障碍/目标盘，CNN 小到 CPU 可训。
  更高分辨率的视觉训练属于 mjlab/Warp GPU 路线，不在此引擎冒充。
* **smoke 评级不保证成功率**：successRate 如实上报（smoke 迭代次数下
  通常为 0），质量门语义与其他引擎一致 —— 视觉策略要达标请用
  standard/high-vram 档真实训练。

## 运行

共享 mjx-adapter 的 venv（mujoco 3.13 + jax + optax + onnx）：

```bash
engines/mjx-adapter/.venv/bin/python engines/visual-ppo/adapter.py
```

经本地 worker 注册（`RDK_SIM2REAL_TRAIN_ENGINES_JSON`）：

```json
{"visual-ppo": {"executable": "<mjx venv python>",
                "args": ["<repo>/engines/visual-ppo/adapter.py"]}}
```

环境变量旋钮：`RDK_VISUAL_ENGINE_ENVS / _ITERATIONS / _STEPS`。

## 契约

| 项 | 值 |
| --- | --- |
| observation | 2308 = 48×48 灰度 + 4 本体感受 |
| action | 2（线速/角速归一化指令） |
| contract.observationLayout | `camera-ceiling-48x48-gray-v1` + `originbot-proprio-v1` |
| 输出 | policy.onnx（Conv→ReLU→Conv→ReLU→Gemm→Tanh→Gemm→Clip, opset 13） |

## 测试

```bash
engines/mjx-adapter/.venv/bin/python -m unittest discover -s engines/visual-ppo -p 'test_visual_ppo.py' -v
```

覆盖：共享场景源断言（墙/伺服/mocap 数量、标定无漂移）、像素真实性
（非黑帧、随世界变化、目标标记可见）、ONNX 数值等价与 Conv 存在、
worker 协议（维度不匹配拒绝、smoke 全链路 result.json + SHA256SUMS）。
