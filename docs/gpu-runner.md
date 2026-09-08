# GPU 训练机接入指南

一台 GPU 机器（如 RTX 5090 开发机）接入本平台只需部署两个文件：`local-training-worker.mjs`（受控训练 worker）和 `engines/starter-ppo/runner.py`（真实 PPO 引擎）。平台 Web 服务器通过内网/SSH 隧道调用 worker，不要求 GPU 机器暴露公网。

## 一键部署

```bash
node scripts/gpu-deploy.mjs --host <gpu-ip> --port <ssh-port> --user <ssh-user> --service
```

脚本会依次完成（全部通过 SSH，本机不跑任何训练）：

1. 探测 SSH 可达性（失败时打印排查步骤）；
2. 同步 worker + 引擎 + manifest（rsync，缺则回退 scp）；
3. 在 `~/rdk-sim2real/.venv` 安装 `numpy / torch / onnx`；
4. 探测 CUDA 并打印引擎将产生的诚实设备报告；
5. 生成 `~/rdk-sim2real/worker.env`（含随机 runner token，`chmod 600`）；
6. `--service` 时安装并启动 `systemd --user` 服务 `rdk-sim2real-worker`。

结束时打印需要粘贴到本机 web 服务器 `.env` 的两行：

```
RDK_SIM2REAL_LOCAL_RUNNER_URL=http://<gpu-ip>:19091/train
RDK_SIM2REAL_LOCAL_RUNNER_TOKEN=<随机 token>
```

重启 web 服务器后，工作台「训练与模型」选 **local** backend 提交任务即可。

## 设备自动检测（诚实上报）

`starter-ppo` 引擎现在会自动选择设备：

- `RDK_STARTER_ENGINE_DEVICE=auto`（默认）：CUDA 可用即在 GPU 上训练，否则 CPU；
- `RDK_STARTER_ENGINE_DEVICE=cuda`：强制 GPU，不可用时**回退 CPU 并打印告警**，不会伪造结果；
- `RDK_STARTER_ENGINE_DEVICE=cpu`：强制 CPU。

结果契约如实反映（见 `result.json` / `training-summary.json`）：

| 字段 | 含义 |
| --- | --- |
| `result.cuda` | `true` 仅当训练**确实**在 GPU 上跑；请求了 cuda 但回退则保持 `false` |
| `training-summary.device` / `deviceName` | 实际设备类型 / 显卡名 |
| `training-summary.cudaRequested` | 请求了 cuda 但不可用时为 `true`（审计用） |

注意：`controlLatencyMs` 始终在 CPU 单线程上测量（它描述的是上板推理预算，不是 GPU 训练速度）；ONNX 导出也始终在 CPU 上完成（导出的是 CPU runtime 制品）。

## 网络与安全

- worker 监听 `0.0.0.0:19091`，runner token 是唯一防线，生产环境务必配合防火墙白名单；
- 更稳妥的方案是 **SSH 隧道**（worker 只监听 `127.0.0.1`）：

  ```bash
  ssh -p <ssh-port> -N -L 19091:127.0.0.1:19091 <ssh-user>@<gpu-ip>
  # 本机 .env 用 http://127.0.0.1:19091/train
  ```

- worker 的安全边界与本地部署完全一致：`shell:false`、引擎必须绝对路径、凭据不出现在子进程环境、结果必须带回合法 `artifact://` 引用，否则任务不会被标记完成。

## 手动部署（不用脚本）

```bash
# GPU 机上
mkdir -p ~/rdk-sim2real && cd ~/rdk-sim2real
# 从仓库复制 services/sim2real-web/local-training-worker.mjs、engines/starter-ppo/runner.py
python3 -m venv .venv && .venv/bin/python -m pip install numpy torch onnx
cat > worker.env <<'EOF'
RDK_SIM2REAL_LOCAL_WORKER_HOST=127.0.0.1
RDK_SIM2REAL_LOCAL_WORKER_PORT=19091
RDK_SIM2REAL_LOCAL_WORKER_DATA_DIR=$HOME/rdk-sim2real/worker-data
RDK_SIM2REAL_TRAIN_EXECUTABLE=$HOME/rdk-sim2real/.venv/bin/python
RDK_SIM2REAL_TRAIN_ARGS_JSON='["$HOME/rdk-sim2real/engines/starter-ppo/runner.py"]'
RDK_SIM2REAL_MAX_CONCURRENT_JOBS=1
RDK_SIM2REAL_LOCAL_RUNNER_TOKEN=<随机长字符串>
RDK_STARTER_ENGINE_DEVICE=auto
EOF
chmod 600 worker.env
set -a && . ./worker.env && set +a
node services/sim2real-web/local-training-worker.mjs
```

本机 `.env`（web 服务器）：

```
RDK_SIM2REAL_LOCAL_RUNNER_URL=http://127.0.0.1:19091/train   # 走 SSH 隧道时
RDK_SIM2REAL_LOCAL_RUNNER_TOKEN=<同上 token>
```

## GPU 机器还在创建时

`scripts/gpu-deploy.mjs` 的第 1 步会失败并给出排查清单——这是预期行为。机器就绪后重跑同一条命令即可；本机其他功能（`npm run demo:starter` CPU 真实训练、可视化、评测、只读板端预检）完全不依赖 GPU 机器。

大规模训练（万级并行、域随机化）请继续参考 `engines/mjlab-rsl-rl-adapter/README.md`，在同一 worker 协议下替换引擎可执行文件即可。
