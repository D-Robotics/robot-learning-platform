# D-002 · 侧边栏流程子项是真实子界面状态

- **Status**: Accepted
- **Date**: 2026-09-21
- **背景与约束**: 工作台 8 个视图（`data-view-section`）+ 11 个侧边栏流程子项
  （`data-flow-child`），多个子项共享同一视图（训练 3 个、评测 2 个、部署 2 个、证据 2 个）。
  用户质疑「11 个入口对应 8 个页面，层级是假的」——若子项只是同页滚动定位，导航层级即为欺骗。

## 决策

每个流程子项必须是**可感知、可区分、可恢复的子界面状态**，五个联动面缺一不可：

1. 子流程横幅 `#flow-context`（编号/阶段/标题/描述/目标）；
2. 浏览器标签页标题 `document.title`（「视图 · 子项」）；
3. 顶栏 `context-live-stage` 面包屑同步；
4. 主面板真实切换（train/station 走模块 tab，records 走台账 tab，部署/评测聚焦面板）；
5. 地址锚点 `#视图/子项`，后退/前进可恢复；同级切换 replaceState 不产生垃圾历史。

核心实现：`public/app.js` 的 `FLOW_CHILD_CONTEXTS` / `setView` / `setFlowChild` /
`clearFlowChild`。

## 被否决方案

- 把 11 个子项拆成 11 个独立视图：视图爆炸，违反 ui-ia 门禁的 8 视图 IA。
- 只做滚动定位 + 短暂高亮：高亮消失后界面回到无差别状态，用户感知为假层级。

## 后果与边界

- `body[data-flow-child]` 是全局状态标记：控制类匹配必须跳过 body（曾因此 aria-current
  落到 body、父分组永不展开）。
- 任何让子项「看起来像独立界面」的新需求（标题/面包屑/锚点）都必须进入联动面清单。

## 失效/重审条件

IA 结构变化（视图增减、子项增减）时同步更新本条与 ui-ia 断言；不做「部分真实」的中间态。

## 守卫

`ui-ia.spec.mjs`（IA 锁）/ `ui-behavior.test.ts` / `ui-responsive.spec.mjs`。
