# app.js 模块化方案（视图层拆分）

`services/sim2real-web/public/app.js` 是手写 classic script，约 **7,000 行**，承担了应用外壳、状态、路由（视图切换）、四个流程页与两个数据工具页的渲染、遥测可视化与安全开关面板。本方案给出边界、加载模型、迁移顺序与验收标准，并已用两个试点验证模式可行。

## 为什么保留 classic script（先说不做什么）

- `index.html` 直接以 `<script src>` 加载，**没有打包器**；改成 ES module 需要引入构建步骤，并会踩 `file://` 源下的 CORS 限制（仓库注释里已记录过这个坑）。
- 因此模块化采用**已验证的仓库模式**：classic script + `globalThis` 命名空间 + `app.js` 内保留**同名同签名瘦委托**。调用点一行不改，回滚成本低。

## 现状分区（实测行数）

| 区块 | 起始行 | 行数 | 性质 |
| --- | --- | --- | --- |
| 应用外壳（状态、视图切换、请求封装、渲染管线、记录/训练页） | 1 | ~2059 | 核心，暂不动 |
| Telemetry visuals | 2060 | 731 | 纯绘制 + 视图逻辑混合 |
| 真机实时对照（评估页） | 2791 | 1294 | 视图 + 轮询 |
| station 可视化辅助 | 4085 | 369 | 视图渲染 |
| motion canary | 4454 | 105 | **安全相关** |
| policy runtime | 4559 | 407 | **安全相关** |
| 设备管理 | 4966 | 131 | 独立视图 |
| 运动开关 | 5097 | 550 | **安全相关** |

已抽出的 `telemetry-core.js`（465 行，DOM-free 纯逻辑）是第一个模块；`telemetry-canvas.js` 与 `device-manager-view.js` 是本次试点。

## 两种模块模式

**模式 A — 纯模块（无依赖）**：适用于 DOM-free 计算与"只吃参数"的绘制。
```js
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SimTelemetryCanvas = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () { /* ... */ });
```
- 判据：不引用 `state`、不调用 `$`/`setText`/`request`/`showToast`，只通过参数拿数据与 canvas/ctx。
- 收益：可以用**假 ctx** 做确定性单测（断言绘制调用序列），不需要真实渲染。

**模式 B — IoC 工厂（有状态视图）**：适用于需要读状态切片、操作 DOM、发请求的视图。
```js
SimDeviceManagerView.create({ $, request, escapeHtml, showToast, state, document, window })
// → { stationDeviceRow, stationDeviceManagerLoad, wireDeviceManagerEvents }
```
- 视图**只**通过注入的依赖访问 app.js 能力，不直接引用 app.js 的其它全局函数。
- 依赖对象在 `state` 初始化**之后**创建（`const state` 有 TDZ，函数声明会提升但 `const` 不会）；必要时惰性创建。
- 收益：视图可以在 vitest 里用假依赖驱动，不必启动整个 app。

## 加载顺序与依赖规则

```
telemetry-core.js   ← 纯逻辑，无依赖
telemetry-canvas.js ← 纯绘制，无依赖
device-manager-view.js ← 工厂，加载时不取依赖
telemetry-core … 其它视图模块
app.js              ← 创建实例、保留委托、启动
onboarding.js / agent-chat.js
```
- 规则 1：模块**加载时**不得读取 app.js 的 `const`/`let`（TDZ），只能读顶层 `function` 声明或在自己的 `create()` 里取依赖。
- 规则 2：模块不得依赖彼此；共享逻辑一律下沉到 `telemetry-core.js`。
- 规则 3：`ui-ia.spec.mjs` 断言"telemetry-core.js 必须早于 app.js"，新增模块沿用同一断言模式。

## 迁移顺序（按风险从低到高）

1. ✅ **telemetry-canvas.js**（纯绘制）— 无依赖，假 ctx 单测。
2. ✅ **device-manager-view.js**（IoC 工厂）— 131 行，独立 DOM。
3. **station 可视化辅助**（369 行）→ `station-view.js`，注入 `{ $, setText, state, escapeHtml }`；`state.station` 切片只读。
4. **真机实时对照 / 评估页**（1294 行）→ 拆成 `evaluate-view.js`（渲染）+ 轮询控制器；这是最大的一块，必须单独一轮。
5. **安全相关区块**（motion canary / policy runtime / 运动开关，合计 ~1060 行）→ `safety-controls-view.js`。**最后做**，且必须遵循下面的安全约束。
6. 记录页与训练页从"应用外壳"中分离（需要先把 `state` 的写入集中化）。

## 安全相关区块的额外约束

这些面板决定"能不能让机器人动"，拆分时必须满足：

- 拆分**不得**改变任何开关默认值、确认弹窗文案、请求 URL 与方法、钳制参数；
- 拆分后必须保留 `verify:board-drive`、`verify:policy-runtime`、`board-agent-drive.test.py` 覆盖的服务端闸门不变（前端只是发请求的一方）；
- 任何"乐观置位"（点击后先改 UI）都不允许——UI 必须等板端确认；
- 拆完必须补：断言"未确认时零请求""板端拒绝时 UI 不显示成功"的行为测试。

## 测试策略

| 层 | 手段 | 覆盖对象 |
| --- | --- | --- |
| 纯逻辑 | `telemetry-core.test.ts` 动态 import 真实文件 | 谓词、格式化、解析 |
| 纯绘制 | 假 ctx 断言调用序列 | 时间线、热力图、占位分支 |
| 视图 | 假依赖 + 最小 DOM | 渲染、降级、请求方法与 URL、XSS |
| 整体 | `ui-behavior.test.ts`（真实 bundle + jsdom）、`ui-ia.spec.mjs`（信息架构与加载顺序） | 端到端行为与 IA |

新增模块**自动**进入 `verify:escape-audit`（该脚本已改为自动发现 `public/*.js`），所以不存在"新模块漏审计"的缝隙。

## 验收标准（每一步都要满足）

- `node --check` 全部模块通过；`ui-ia.spec.mjs`、`ui-behavior.test.ts`、`retraining-advice-ui.test.ts` 未改一字仍全绿（除断言锚点需随实现迁移，且必须在提交信息里说明）；
- `escape-audit` 全绿（不得新增无理由豁免）；
- `npm run lint` 与 `npx tsc --noEmit` 全绿；
- `app.js` 行数下降，且**调用点零改动**（只有委托与被搬走的定义变化）。

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| TDZ：模块在加载期读 app.js 的 `const` | 只在 `create()` 或调用期取依赖；加载期只用 `function` 声明 |
| 跨文件全局函数被重命名导致运行时才发现 | 委托保留原名；`ui-ia.spec.mjs` 断言关键函数名仍存在于 app.js 或已迁往的模块 |
| 拆分把安全语义改掉 | 安全区块最后做，且逐项对照上面"额外约束"清单 |
| 行数下降但耦合没降（假拆分） | 判据是"模块能否用假依赖单测"；不能则说明边界没找对 |
| 回滚困难 | 每步一个提交，委托层保证 `git revert` 即可回到单体 |
