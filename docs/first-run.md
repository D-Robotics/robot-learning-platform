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

S100 板卡使用同一套脚本，只需把机型 profile 换成 `RDK_X5_PROFILE_NAME=rdk-s100-generic-drive.json`（初始化与部署都接受该变量）；接入底盘前后各跑一次只读预检 `RDK_X5_PROFILE_NAME=rdk-s100-generic-drive.json RDK_X5_SSH_TARGET=root@<板端地址> ./scripts/preflight-board.sh`——required 话题未全部出现时 profile 的 `provenance.mock` 必须保持 `true`。

然后设置 `RDK_SIM2REAL_BOARD_AGENT_URL=http://<板端地址>:19100`，执行 `npm run demo:preflight -- --strict` 和 `npm run verify:live-board`。预检中的“隧道未连接”和“策略目录为空”必须在现场恢复隧道并上传经过审核的策略后才会通过；平台默认 fail-closed，不会把 Mock 误报为真机。

## 4. Linux systemd

macOS 没有 `systemd-analyze` 是正常的。本地会做 unit 静态检查和 Bash 语法检查；Ubuntu CI 已执行 `VERIFY_SYSTEMD=1 npm run verify:deployment`。在目标 Linux 主机再执行一次同命令，并按发布清单启用 service。

## 5. 存储边界

单写 JSON ledger 是当前可用的默认存储，适合本机、单实例和演示。PostgreSQL/对象存储适配尚未接入运行时，不能仅靠安装数据库就宣称多写生产可用；生产部署应继续使用单写约束，或在接入并验收适配器后再切换。相关边界见 `docs/scalability.md`。

## 6. 并发构建

`npm run build:assets` 使用跨进程锁和原子目录替换；CI 仍建议每个 job 使用独立工作树。多个 build 在同一工作区串行等待，不再复制资源竞态，锁文件会在正常结束后自动清理。


## 7. 在浏览器里试用能力与诊断轨迹

打开 Agent 的“原子能力”目录，可搜索能力、筛选只读或受控操作、查看依赖和编辑示例。支持直接试用的只读查询会显示本次真实结果、数据数量和原始 JSON；写操作先准备计划，沿用平台审批链。未绑定、登录失败或后端不可用会显示具体原因。

“评测与证据 → 发起评测”可直接导入 JSONL，不需要先运行训练。相机、奖励、所选观测/动作维度和事件按记录时间同步；缺图像、单位或奖励分项会明确说明。记录详情的“可视化回放”可恢复对应 Run 的原始数据。“结果对比”可选两条 Run，按各自起点对齐经过时间，短轨迹结束后不延长、不补帧。导入相机可本地预览，受信板端上传才可用于相机证据与视频导出。

向量示教在评测页保存为独立 Run，然后在训练参数中选择 ACT 或 Diffusion Policy 以及示教 Run。当前动作分块输入要求同项目、同契约，至少 8 个完整回合、每回合至少 4 帧，并记录 `observation`、`action` 和结束事件；最大 512 KiB / 20000 帧。平台锁定数据摘要，不会把不足的回合改成合成数据。只有显式选择“仅合成冒烟”并使用冒烟档位时才运行合成输入。当前工作台向量示教需要服务端 worker；本机浏览器 relay 和图像示教会明确阻断并给出原因。

仿真与真机对照要求模型、任务和策略 SHA-256 一致，并有受信板端来源。当前遥测没有独立的真机成功率测量字段，因此该值留空并说明缺失；普通导入或训练指标不会被标成真机成功率。
