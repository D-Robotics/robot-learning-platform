# 文档索引

这个仓库的文档按"读者要做什么"分组。新读者请从根目录 [`README.md`](../README.md) 开始。

## 上手与演示

| 文档 | 用途 |
| --- | --- |
| [`user-guide.md`](user-guide.md) | 使用手册与最佳实践（六模块工作流） |
| [`demo-runbook.md`](demo-runbook.md) | 演示前的检查与操作顺序 |
| [`demo-guide.md`](demo-guide.md) | 演示脚本与讲解要点 |
| [`demo-originbot-runbook.md`](demo-originbot-runbook.md) | OriginBot 真机演示流程 |

## 安全与硬件

| 文档 | 用途 |
| --- | --- |
| [`actuator-drive.md`](actuator-drive.md) | 受限驱动（运动金丝雀）：双开关、钳制、时间盒、急停 |
| [`hardware-adapters.md`](hardware-adapters.md) | 机型适配包 schema 与新增机型步骤 |
| [`host-station.md`](host-station.md) | 上位机视图：心跳、板载相机流、白名单只读命令 |
| [`standalone-adapters.md`](standalone-adapters.md) | 独立部署的认证与 adapter 边界 |
| [`operations.md`](operations.md) | 生产环境变量、限流、CSP、日志与指标 |

## 训练与引擎

| 文档 | 用途 |
| --- | --- |
| [`engines/starter-ppo.md`](engines/starter-ppo.md) | CPU 真实 PPO/SAC 训练与 ONNX 导出 |
| [`task-pack-training.md`](task-pack-training.md) | 声明式 task-pack 训练与质量门 |
| [`gpu-runner.md`](gpu-runner.md) | 独立 GPU 机器上的训练 runner 部署 |
| [`sim2real-plugins.md`](sim2real-plugins.md) | 事件扩展层：实验追踪、对象存储、通知、硬件适配 |

## 架构、边界与验收

| 文档 | 用途 |
| --- | --- |
| [`design/sim2real-platform.md`](design/sim2real-platform.md) | 平台总体设计 |
| [`design/rdk-duck-product-design.md`](design/rdk-duck-product-design.md) | 产品设计 |
| [`design/sim2real-90-acceptance.md`](design/sim2real-90-acceptance.md) | 90 分验收标准 |
| [`design/sim2real-mvp-guide.md`](design/sim2real-mvp-guide.md) | MVP 流程指南 |
| [`roadmap.md`](roadmap.md) | 已落地能力与差距计划 |
| [`quality-scorecard.md`](quality-scorecard.md) | 9+ 质量门槛的自动门禁与待补现场证据 |
| [`scalability.md`](scalability.md) | 存储容量边界与扩容路径 |
| [`release-checklist.md`](release-checklist.md) | 公开发布阻塞项清单 |
| [`api/openapi.yaml`](api/openapi.yaml) | 版本化 HTTP API 契约（`/api/v1/duck`） |

## 证据归档

`research/` 与 `real-loop-*` 是带日期的评测/真机验证证据，属于**历史记录**，不要当作当前能力声明；当前能力以 `roadmap.md` 与代码为准。

## 已知重复

- `design/sim2real-mvp-guide.html` 与 `design/sim2real-mvp-guide.md` 是同一份内容的两份载体；修改时请以 `.md` 为准并同步 `.html`，或直接删除 `.html`（尚无自动生成脚本）。
- `design/sim2real-90-acceptance.md`、`quality-scorecard.md`、`release-checklist.md` 三者视角不同（验收标准 / 自动门禁 / 发布阻塞项），但都涉及"什么算完成"；改动其中一份时请交叉检查另外两份。
