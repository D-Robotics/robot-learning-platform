# 文档索引

这个仓库的文档按"读者要做什么"分组。新读者请从根目录 [`README.md`](../README.md) 开始。

## 上手与演示

| 文档 | 用途 |
| --- | --- |
| [`user-guide.md`](user-guide.md) | 使用手册与最佳实践（核心、流程、数据与工具） |
| [`demo-runbook.md`](demo-runbook.md) | 演示前的检查与操作顺序 |
| [`demo-guide.md`](demo-guide.md) | 演示脚本与讲解要点 |
| [`demo-originbot-runbook.md`](demo-originbot-runbook.md) | OriginBot 真机演示流程 |
| [`new-originbot-server-runbook.md`](new-originbot-server-runbook.md) | 新服务器 + 新 OriginBot 全链路部署手册 |

## 安全与硬件

| 文档 | 用途 |
| --- | --- |
| [`actuator-drive.md`](actuator-drive.md) | 受限驱动（运动金丝雀）：双开关、钳制、时间盒、急停 |
| [`hardware-adapters.md`](hardware-adapters.md) | 机型适配包 schema 与新增机型步骤 |
| [`host-station.md`](host-station.md) | 上位机视图：心跳、板载相机流、白名单只读命令 |
| [`standalone-adapters.md`](standalone-adapters.md) | 独立部署的认证与 adapter 边界 |
| [`operations.md`](operations.md) | 生产环境变量、限流、CSP、日志与指标 |
| [`production-operations.md`](production-operations.md) | 发布配置门禁、部署后探针、备份恢复与迁移 runbook |

## 训练与引擎

| 文档 | 用途 |
| --- | --- |
| [`engines/starter-ppo.md`](engines/starter-ppo.md) | CPU 真实 PPO/SAC 训练与 ONNX 导出 |
| [`engines/mjx-adapter.md`](engines/mjx-adapter.md) | MJX 引擎：纯 JAX PPO + 真 MuJoCo 接触动力学 |
| [`engines/offline-bc.md`](engines/offline-bc.md) | 模仿学习路径：示教数据 → MLP 行为克隆 → ONNX（数值等价证明） |
| [`task-pack-training.md`](task-pack-training.md) | 声明式 task-pack 训练与质量门 |
| [`gpu-runner.md`](gpu-runner.md) | 独立 GPU 机器上的训练 runner 部署 |
| [`sim2real-plugins.md`](sim2real-plugins.md) | 事件扩展层：实验追踪、对象存储、通知、硬件适配 |

| [`lineage.md`](lineage.md) | **按 task id 的纵向迭代血缘**（含失败路径与放弃原因） |

## 架构、边界与验收

| 文档 | 用途 |
| --- | --- |
| [`design/sim2real-platform.md`](design/sim2real-platform.md) | 平台总体设计 |
| [`design/rdk-duck-product-design.md`](design/rdk-duck-product-design.md) | 产品设计 |
| [`design/sim2real-90-acceptance.md`](design/sim2real-90-acceptance.md) | 90 分验收标准 |
| [`design/sim2real-mvp-guide.md`](design/sim2real-mvp-guide.md) | MVP 流程指南 |
| [`design/app-js-modularization.md`](design/app-js-modularization.md) | 前端模块化方案：模块模式、加载顺序、迁移顺序与验收标准 |
| [`roadmap.md`](roadmap.md) | 已落地能力与差距计划 |
| [`quality-scorecard.md`](quality-scorecard.md) | 9+ 质量门槛的自动门禁与待补现场证据 |
| [`dataset-lineage.md`](dataset-lineage.md) | 数据集版本、摘要与训练血缘 |
| [`scalability.md`](scalability.md) | 存储容量边界与扩容路径 |
| [`release-checklist.md`](release-checklist.md) | 公开发布阻塞项清单 |
| [`field-evidence-runbook.md`](field-evidence-runbook.md) | X5、第二种实体机器人与生产制品回滚验收 |
| [`api/openapi.yaml`](api/openapi.yaml) | 版本化 HTTP API 契约（`/api/v1/duck`） |

## 证据归档

`research/` 与 `real-loop-*` 是带日期的评测/真机验证证据，属于**历史记录**，不要当作当前能力声明；当前能力以 `roadmap.md` 与代码为准。

本轮真实 X5 + OriginBot 现场证据：[`evidence/x5-originbot-preflight-2026-09-11.json`](evidence/x5-originbot-preflight-2026-09-11.json)（只读预检）和 [`evidence/x5-originbot-canary-2026-09-11.json`](evidence/x5-originbot-canary-2026-09-11.json)（0.02 m/s、1 秒低速 canary、watchdog 与急停）。
真实 X5 上现有 BPU 制品的摘要校验与版本回滚 rehearsal：[`evidence/artifact-registry-rehearsal-2026-09-11.json`](evidence/artifact-registry-rehearsal-2026-09-11.json)；该文件明确标记为非生产 registry。

## 已知重复

- ~~`design/sim2real-mvp-guide.html` 与 `design/sim2real-mvp-guide.md` 双载体~~：`.html` 已删除（2026-09-14），[`design/sim2real-mvp-guide.md`](design/sim2real-mvp-guide.md) 是唯一载体。
- `design/sim2real-90-acceptance.md`、`quality-scorecard.md`、`release-checklist.md` 三者视角不同（验收标准 / 自动门禁 / 发布阻塞项），但都涉及"什么算完成"；改动其中一份时请交叉检查另外两份。
