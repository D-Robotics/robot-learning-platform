# OriginMan 策略训练设备

OriginMan 受扰恢复任务的新训练默认使用 CUDA，显式选择 CPU 的方式保留。MicroDuck 等其他引擎的设备配置不变。

## 配置和操作

先读取 `rdk_workshop_catalog`，核对模型契约及支持 OriginMan 的执行资源，再用 `rdk_training_submit` 提交。`originmanWorkshop.device` 可取 `cuda` 或 `cpu`；省略时平台解析为 `cuda`。GPU 不可用会失败，不能自动改用 CPU。

```json
{"phase":"train","timesteps":12032,"seed":7,"pushMaxForce":8.1,"device":"cuda"}
```

平台表单中“策略训练设备”默认 GPU（CUDA），可切换 CPU。命令行同样支持：

```bash
python engines/originman-straight/workshop.py prepare --workspace "$SESSION_DIR" --scene "$ORIGINMAN_SCENE" --steps 12032 --device cuda
python engines/originman-straight/workshop.py train --workspace "$SESSION_DIR"
```

CPU 训练将 `--device` 改为 `cpu`，并使用新的工作区。旧的、没有设备字段的本地 session 按原 CPU 设置复现；新 session 默认 CUDA。只读预检默认检查 CUDA；部署专用 CPU Worker 时设置 `ORIGINMAN_TRAIN_DEVICE=cpu`。

## 如何判断真的使用 GPU

`rdk_training_status` 的 `metrics.originmanWorkshop` 包含 `trainingDevice` 和 `gradientUpdates`。检查 `requestedDevice=cuda`、`resolvedDevice=cuda`、`parameterDevices=["cuda:0"]`，并确认梯度更新次数大于零。4096 步低于本任务 5000 步学习预热，仅跑通流程不能证明策略已被优化。

训练摘要还保留初始及最终策略参数 SHA-256、PyTorch/CUDA 版本和 ONNX 数值误差。导出使用策略的 CPU 副本，不把正在训练的模型移出 GPU。

MuJoCo 物理采样、部分数据处理、ONNX CPU 数值校验及评测仍使用 CPU。这不是 GPU 物理仿真或整条流水线都在 GPU 上运行，也不据此承诺更快。

## 本次验收（2026-10-30）

在隔离的平台候选实例，通过真实 MCP 提交到远端 RTX 4090 Worker：

| 路径 | 实际控制步 | 梯度更新 | 策略参数设备 | ONNX 最大绝对误差 |
| --- | ---: | ---: | --- | ---: |
| 省略设备，使用默认 GPU | 12032 | 1792 | cuda:0 | 1.79e-7 |
| 显式 CPU | 8192 | 832 | cpu | 1.19e-7 |

两条路径均完成真实训练，参数摘要发生变化，策略制品已被平台保留；不是 Mock。运行时为 PyTorch 2.9.1+cu128、MuJoCo 3.3.7、SB3 2.7.1，实际依赖版本另有预检记录。屏蔽 GPU 的负例及拒绝静默降级单测单独验收。

验收范围是训练执行、来源记录和制品数值一致性；短训练不代表策略已学好。生产发布、Studio 新插件导入、整班并发和真实机器人仍需各自的证据，不能由上述短训练放行。
