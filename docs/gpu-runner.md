# GPU 训练机接入指南

一台 GPU 机器（如 RTX 5090 开发机）接入本平台只需部署两个文件：`local-training-worker.mjs`（受控训练 worker）和 `engines/starter-ppo/runner.py`（真实 PPO 引擎）。平台 Web 服务器通过内网/SSH 隧道调用 worker，不要求 GPU 机器暴露公网。

## 一键部署

```bash
node scripts/gpu-deploy.mjs --host <gpu-ip> --port <ssh-port> --user <ssh-user> --service
```

脚本会依次完成（全部通过 SSH，本机不跑任何训练）：

1. 探测 SSH 可达性（失败时打印排查步骤）；
2. 同步 worker + 引擎 + manifest（rsync `--relative` 保留仓库子路径，缺则回退 scp）；
3. 在 `~/rdk-sim2real/.venv` 安装 `numpy / torch / onnx`（检测到 NVIDIA 驱动时 torch 改用 `--index-url https://download.pytorch.org/whl/cu128`，否则 PyPI CPU 轮子会让 `torch.cuda.is_available()` 永远为 false）；
4. 探测 CUDA 并打印引擎将产生的诚实设备报告；
5. 生成 `~/rdk-sim2real/worker.env`（含随机 runner token，`chmod 600`；`--dir ~/...` 会解析为绝对路径，worker 要求可执行文件路径必须绝对）；
6. `--service` 时安装并启动 `systemd --user` 服务 `rdk-sim2real-worker`。

结束时打印 URL 和 token 的安全取值说明。脚本不会把 bearer 写入终端日志；从远端
`worker.env` 通过组织的 secret 管理或受控 SSH 通道取值，再写入本机 web 服务器 `.env`：

```
RDK_SIM2REAL_LOCAL_RUNNER_URL=http://<gpu-ip>:19091/train
RDK_SIM2REAL_LOCAL_RUNNER_TOKEN=<从远端 worker.env 安全复制>
```

重启 web 服务器后，工作台「强化学习训练」选 **local** backend 提交任务即可。

## 在平台页面管理自己的 GPU

完成 worker 部署后，也可以直接在工作台完成接入，不必把 token 写进浏览器：

1. 打开「训练」→「我的 GPU 训练资源」，填写资源名称、`/train` 地址、Runner token 和并发任务数；
2. 点击「添加 GPU」，再点「测试连接」确认 Worker 的 CUDA / GPU 信息；
3. 在「训练参数与续训」的「训练资源」下拉框选择这台 GPU，点击「发起本地训练」；
4. 资源支持编辑、删除，训练记录会保留所选资源 id，后续状态查询继续访问对应 Worker。

凭据只保存在服务端台账，列表和运行记录不会返回 token。对应接口为 `GET/POST/PATCH/DELETE /api/sim2real/compute-resources`，连通性检查使用 `POST /api/sim2real/compute-resources/:id/test`。

共享部署会拒绝字面量私网地址上的 HTTPS Runner（例如
`https://127.0.0.1/...`、RFC1918 或云元数据地址），避免账号持有者把平台进程
当作 SSRF 探针。内网 GPU 优先使用上面的 loopback SSH 隧道；确需直连私网 HTTPS
时，由运维在服务环境中设置 `RDK_SIM2REAL_COMPUTE_ALLOW_PRIVATE_HTTPS_HOSTS`
为逗号分隔的精确主机名/IP 白名单。HTTP 私网 Runner 的现有本地模式规则不变。

连通性检查不是永久授权：默认 600 秒后健康租约过期（可用
`RDK_SIM2REAL_COMPUTE_HEALTH_TTL_SECONDS` 调整到 30–86400 秒）。过期资源会在训练启动、运行状态对账和制品下发时 fail-closed，页面会显示“未测试”，重新点击“测试连接”后才恢复可用。

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

另外两个实战踩坑记录（RTX 5090 + CUDA 12.8 机器上验证过）：

- **torch 轮子**：PyPI 默认 `torch` 是 CPU-only 轮。GPU 机必须装 `onnxscript` 之外的 `torch==cu128` 版本，否则 `torch.cuda.is_available()` 一直是 `false`，引擎会如实回退 CPU 并上报 `cuda=false`。部署脚本已自动处理。
- **ONNX 导出依赖**：`torch>=2.5` 的 `torch.onnx.export`（dynamo 路径）需要 `onnxscript` 包；缺它时引擎打印告警、`metrics.onnxExported=false` 但训练本身成功。想要完整 ONNX 制品就 `pip install onnxscript` 后重跑一次。

## 网络与安全

- worker 监听 `0.0.0.0:19091`，runner token 是唯一防线，生产环境务必配合防火墙白名单；
- 更稳妥的方案是 **SSH 隧道**（worker 只监听 `127.0.0.1`）。很多托管 GPU 机默认只在公网开放 SSH 端口（例如仅 2222），直连 `19091` 会超时——这不是部署失败，走隧道即可：

  ```bash
  ssh -p <ssh-port> -N -L 19091:127.0.0.1:19091 <ssh-user>@<gpu-ip>
  # 本机 .env 用 http://127.0.0.1:19091/train
  ```

  建议加 `-o ServerAliveInterval=15 -o ExitOnForwardFailure=yes`，隧道断了立刻能发现。

- worker 的安全边界与本地部署完全一致：`shell:false`、引擎必须绝对路径、凭据不出现在子进程环境、结果必须带回合法 `artifact://` 引用，否则任务不会被标记完成。

## 手动部署（不用脚本）

```bash
# GPU 机上
mkdir -p ~/rdk-sim2real && cd ~/rdk-sim2real
# 从仓库复制 services/sim2real-web/local-training-worker.mjs、engines/starter-ppo/runner.py、engines/mjx-adapter/adapter.py
python3 -m venv .venv && .venv/bin/python -m pip install numpy torch onnx jax mujoco mujoco-mjx optax
cat > worker.env <<'EOF'
RDK_SIM2REAL_LOCAL_WORKER_HOST=127.0.0.1
RDK_SIM2REAL_LOCAL_WORKER_PORT=19091
RDK_SIM2REAL_LOCAL_WORKER_DATA_DIR=$HOME/rdk-sim2real/worker-data
RDK_SIM2REAL_TRAIN_EXECUTABLE=$HOME/rdk-sim2real/.venv/bin/python
RDK_SIM2REAL_TRAIN_ARGS_JSON='["$HOME/rdk-sim2real/engines/starter-ppo/runner.py"]'
RDK_SIM2REAL_TRAIN_ENGINES_JSON='{"mjx-ppo":{"executable":"$HOME/rdk-sim2real/.venv/bin/python","args":["$HOME/rdk-sim2real/engines/mjx-adapter/adapter.py"]}}'
RDK_SIM2REAL_MAX_CONCURRENT_JOBS=1
RDK_SIM2REAL_LOCAL_RUNNER_TOKEN=<随机长字符串>
RDK_STARTER_ENGINE_DEVICE=auto
EOF
chmod 600 worker.env
set -a && . ./worker.env && set +a
node services/sim2real-web/local-training-worker.mjs
```

要把平台足球能力注册到同一个 GPU worker，把引擎表扩展为：

```bash
RDK_SIM2REAL_TRAIN_ENGINES_JSON='{"mjx-ppo":{"executable":"/home/<user>/rdk-sim2real/.venv/bin/python","args":["/home/<user>/rdk-sim2real/engines/mjx-adapter/adapter.py"]},"microduck-football":{"executable":"/home/<user>/microduck-football/.venv/bin/python","args":["/home/<user>/rdk-sim2real/engines/microduck-football/platform_adapter.py"]}}'
```

训练页选择 `microduck-football` 后，任务下拉框中的
`足球：单鸭射门`、`足球：2v2`、`足球：3v3` 会随请求一起路由；worker 返回
`result.json`、`SHA256SUMS` 和 `policy.pt`，训练记录可在平台中继续查看。该首版
足球策略是 4D 高层踢球控制器，结果会同时标出真实 MicroDuck 的 61D→14D actor
契约，不能把这个 checkpoint 直接当成 14 舵机板端制品；真实 14 舵机评测仍走
`engines/microduck-eval` 的 ONNX 链路。

注意 `worker.env` 里 `$HOME` 不会被 systemd/手动 `source` 二次展开时统一替换——
为稳妥可直接写绝对路径（`/home/<user>/rdk-sim2real/...`）。`engines` 注册后
`healthz` 回报 `["default","mjx-ppo"]`，训练页引擎选择器才放行 MJX 选项；
提交带 `training.engine="mjx-ppo"`（或选择物理密集任务包 `originbot-physics-navigation`
未显式改引擎）即路由到 MJX。

本机 `.env`（web 服务器）：

```
RDK_SIM2REAL_LOCAL_RUNNER_URL=http://127.0.0.1:19091/train   # 走 SSH 隧道时
RDK_SIM2REAL_LOCAL_RUNNER_TOKEN=<同上 token>
```

## GPU 机器还在创建时

`scripts/gpu-deploy.mjs` 的第 1 步会失败并给出排查清单——这是预期行为。机器就绪后重跑同一条命令即可；本机其他功能（`npm run demo:starter` CPU 真实训练、可视化、评测、只读板端预检）完全不依赖 GPU 机器。

大规模训练（万级并行、域随机化）请继续参考 `engines/mjlab-rsl-rl-adapter/README.md`，在同一 worker 协议下替换引擎可执行文件即可。
