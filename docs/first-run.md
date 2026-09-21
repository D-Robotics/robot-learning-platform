# 首次启动与部署向导

> 这是给平台运营者/部署服务器使用的文档。最终用户访问网页版时只需要浏览器，不需要安装 Node、Python、CUDA 或 PostgreSQL。

## 1. 运营端本机立即启动（不需要真机或 CUDA）

```bash
nvm install && nvm use
npm ci
npm run setup
npm start
```

打开 `http://127.0.0.1:18102`。默认启动的是隔离的 Mock worker、只读 reference BoardAgent 和临时 JSON ledger；它可以完整演练仿真、训练请求、台账、遥测和预检，但不会驱动电机。`npm run setup -- --install` 可自动安装 Node 依赖；`npm run setup -- --install-python` 可创建 `.venv` 并安装 starter-ppo CPU 依赖。

## 2. CPU 真训练与 CUDA

没有 CUDA 也可以运行 `npm run demo:starter`，只是训练速度较慢。缺少 Python 依赖时按 setup 输出创建 `.venv`。GPU 主机不要在本机猜装驱动，按部署环境选择 CUDA/ROCm 驱动后运行 `node scripts/gpu-deploy.mjs --help`，并用 `npm run doctor` 确认 `torch.cuda.is_available()`。

## 3. 接入 X5 / OriginBot

真实硬件不是仓库内置依赖，必须由部署方提供设备地址、SSH 凭据、隧道和板端策略目录。先在板上安装只读 agent：

```bash
RDK_X5_SSH_TARGET=root@<板端地址> ./scripts/install-x5-board-agent.sh --enable
RDK_X5_SSH_TARGET=root@<板端地址> ./scripts/deploy-x5-board-agent.sh
```

然后设置 `RDK_SIM2REAL_BOARD_AGENT_URL=http://<板端地址>:19100`，执行 `npm run demo:preflight -- --strict` 和 `npm run verify:live-board`。预检中的“隧道未连接”和“策略目录为空”必须在现场恢复隧道并上传经过审核的策略后才会通过；平台默认 fail-closed，不会把 Mock 误报为真机。

## 4. Linux systemd

macOS 没有 `systemd-analyze` 是正常的。本地会做 unit 静态检查和 Bash 语法检查；Ubuntu CI 已执行 `VERIFY_SYSTEMD=1 npm run verify:deployment`。在目标 Linux 主机再执行一次同命令，并按发布清单启用 service。

## 5. 存储边界

单写 JSON ledger 是当前可用的默认存储，适合本机、单实例和演示。PostgreSQL/对象存储适配尚未接入运行时，不能仅靠安装数据库就宣称多写生产可用；生产部署应继续使用单写约束，或在接入并验收适配器后再切换。相关边界见 `docs/scalability.md`。

## 6. 并发构建

`npm run build:assets` 使用跨进程锁和原子目录替换；CI 仍建议每个 job 使用独立工作树。多个 build 在同一工作区串行等待，不再复制资源竞态，锁文件会在正常结束后自动清理。
