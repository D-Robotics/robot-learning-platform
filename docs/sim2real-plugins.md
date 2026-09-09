# Sim2Real 插件与事件

平台核心通过一个小型、进程内事件总线向实验跟踪器、对象存储同步、通知和硬件适配插件发布领域事件。插件不需要 import 路由或修改台账，因而可以在未来替换为消息队列而不改变产品 API。

## 注册插件

在服务组合根（通常是 `services/sim2real-web/server.ts`）启动时注册：

```ts
import { registerSim2RealPlugin } from '../../server/sim2real/sim2real-events.js';

registerSim2RealPlugin({
  id: 'experiment-tracker',
  events: ['run.created', 'run.updated', 'telemetry.appended'],
  async onEvent(event) {
    await tracker.append({
      eventId: event.id,
      type: event.type,
      owner: event.owner,
      entityId: event.entityId,
      data: event.data,
    });
  },
});
```

插件 id 只能使用字母、数字、`.`、`_` 和 `:`，最多注册 32 个。重复 id 会替换旧插件，返回的 disposer 可用于测试或热重载。事件处理器失败会被隔离并写入服务日志，不会让创建 Run、写入遥测或部署预检失败。

## 事件契约

事件包含 `id`、ISO 时间 `at`、`type`、`entityId`、可选 `owner` 和公共 `data`。当前事件：

`project.created`、`project.updated`、`dataset.created`、`model.created`、`run.created`、`run.updated`、`telemetry.appended`、`deployment.created`、`deployment.updated`。

台账中的 owner、幂等键和请求指纹不会进入 `data`；遥测事件只携带 chunk id、sequence 和 sampleCount。插件应自行实现幂等（以 `event.id` 为事件键），并把较大的样本或模型制品写入对象存储后只传引用。

目前总线是单进程最佳努力投递，适合个人部署和本地扩展。需要跨进程可靠投递时，保留同一 `Sim2RealDomainEvent` 契约，将注册器替换为 outbox/消息队列 adapter 即可。
