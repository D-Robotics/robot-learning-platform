# MLOps 平台基础层

这份增量基础层把训练、评测、制品和推理服务需要的公共边界固定下来。它解决的是“每个
runner 自己定义一套状态和参数”的问题，不把本地 worker 冒充成 K8s、Volcano 或 Temporal。

## 已落地

- `shared/mlops-workflow.ts`：统一的五步工作流契约：数据预检 → 训练 → 评测 → 打包 → 发布。
- 参数快照：训练参数、评测参数、运行时参数和源码/镜像来源一起进入可比较的结构。
- 资源请求：队列、CPU、内存、GPU、优先级和超时都有有界校验，可直接映射到 Volcano queue 或本地 worker。
- 状态转换：依赖、重试次数、取消、失败恢复和可运行步骤由同一份纯函数规则判断。
- `db/postgres/002_mlops_platform_foundation.sql`：参数版本、工作流、步骤事件、推理 endpoint 和 revision 的生产数据库增量表，全部启用租户 RLS。
- `scripts/verify-mlops-foundation.mjs`：检查迁移是否保持幂等、非破坏、租户隔离和关键状态约束。

## 运行时接入顺序

1. 把现有 `Sim2RealStore` 的 workflow adapter 接到 `workflow_runs` / `workflow_steps`，保留现有 API 的幂等键。
2. 用 Temporal worker 或其他编排器消费同一份 workflow plan；K8s/Volcano adapter 只负责执行资源请求，不重新定义业务状态。
3. 将模型文件、遥测和日志放进对象存储，数据库只保留不可变 URI、SHA-256 和血缘元数据。
4. 将 `serving_endpoints` / `serving_revisions` 接到板端策略运行时或集中推理服务，发布时只切换固定 revision，禁止使用 `latest`。
5. 再接入 OpenTelemetry、队列延迟、GPU 利用率、推理错误率、漂移和成本指标。

本轮没有伪造集群或真实 OTA 能力。真实 K8s、Volcano、Temporal、X5 执行器和多设备发布仍需要部署环境完成适配与现场验收。
