# D-005 · 常驻服务以 nohup 脱离会话运行 + cron 看门狗自愈

- **Status**: Accepted
- **Date**: 2026-09-21
- **背景与约束**: 开发环境的 AI 会话（Qoder 等）会回收自己派生的后台任务——实测用会话
  后台任务起的常驻服务约 3 小时后被 SIGTERM，工作台静默下线。训练依赖 web(18102) +
  mock/local worker(19090) 双进程，任一挂掉都有真实用户可见故障（曾发生 worker 挂死导致
  训练 run 全部卡 queued 而 web 健康探针依旧全绿的静默故障）。

## 决策

- 常驻服务一律以 `nohup ... & disown` 脱离会话进程树运行（父进程归 init），
  日志落 `/tmp/rdk-sim2real-web-18102.log` 与 `/tmp/rdk-mock-worker-19090.log`。
- AI 会话 cron 自动化任务「工作台服务看门狗」（每 30 分钟）执行两级巡检并自愈：
  web 查 `/healthz`；worker 查 `POST /train`（400 = 正常校验拒绝 = 活着，000 = 挂死需重启）。
- 健康判定口径：worker 的探活信号是 **400**（空请求体被正常拒绝），不是 200。

## 被否决方案

- 会话后台任务（run_in_background）跑常驻服务：会被 harness 回收（本次事故根因）。
- systemd：macOS 开发机不可用；生产 Linux 部署仍用 `standalone-sim2real.service`
  （见 docs/production-operations.md），与本条不冲突。

## 后果与边界

- 看门狗运行在自己的会话上下文里，**只做巡检与恢复**，不做其他事——巡检提示词里已写死。
- 看门狗是 Qoder 侧状态，不在仓库里；换环境/换机器需要重建任务（提示词见会话记忆
  或重新配置）。
- `lsof -ti :PORT | xargs kill` 误伤面：仅限本机开发实例端口，不涉及生产。

## 失效/重审条件

平台部署到生产主机（systemd 接管自愈）或会话环境变更后，本条降级为开发机注记。

## 守卫

（仓外守卫）Qoder cron 任务 `eb6e45bd-5ec3-4f00-ae39-7bbf4ffa8f78`；仓内
`/healthz` `/readyz` 探针 + `docs/production-operations.md` 运维路径。
