# 工作台 UI 组件开发

工作台以原生 DOM 和 classic JavaScript 运行。`SimUI` 为独立部署、Studio 集成和
本地静态预览提供共用的状态面板、异步按钮和通知组件；业务页面通过参数对象配置
组件。这里的 Props 是普通 JavaScript 对象，无需 React、构建工具或组件运行时。

## 架构与所有权

| 层 | 文件 | 职责 |
| --- | --- | --- |
| DOM 组件 | [`public/ui-components.js`](../services/sim2real-web/public/ui-components.js) | 纯 UI 创建、按钮等待状态、通知生命周期；导出只读的 `globalThis.SimUI` |
| 页面与业务 | [`public/app.js`](../services/sim2real-web/public/app.js) | 选择状态、请求接口、权限判断、数据刷新、重试与焦点恢复 |
| 组件样式 | [`public/app.css`](../services/sim2real-web/public/app.css) | `.ui-state`、`.is-pending`、`.ui-toast` 及其响应式、焦点、主题表现 |
| 设计令牌 | [`public/tokens.css`](../services/sim2real-web/public/tokens.css) | 颜色、字号、层级等唯一来源；浅色与暗色主题 |
| 页面接线 | [`public/index.html`](../services/sim2real-web/public/index.html) | 脚本加载顺序、语义容器与静态首屏 |
| 验证 | [`ui-components.test.ts`](../services/sim2real-web/ui-components.test.ts)、[`ui-behavior.test.ts`](../services/sim2real-web/ui-behavior.test.ts) | 通用契约与页面行为反例 |

`ui-components.js` 不发起请求、不读取平台账本、不判断设备是否可操作。训练、部署、
电机控制、认证和业务幂等必须由 `app.js` 与服务端校验。UI 中禁用按钮只提供交互反馈，
不能代替服务端权限或安全门禁。

脚本必须在首次使用 `SimUI` 前加载，沿用相对路径的 classic script，以支持静态预览：

```html
<link rel="stylesheet" href="./tokens.css" />
<link rel="stylesheet" href="./app.css" />
<script src="./ui-components.js"></script>
<!-- 其余页面依赖按既有顺序加载，再加载 app.js。 -->
```

静态预览可展示组件与页面结构。实际数据和受控动作通过运行中的平台服务获取。

## 工作台信息层级

工作区使用中性表面、细边框和统一字阶，强调色用于主操作与选中状态。每页保留一个
可见的页面标题及一行说明，模型、任务等对象名称放在面板工具栏中。仿真页让场景占据
主体，标题、连接状态和独立打开入口共用一行；操作步骤不再重复占用一组静态进度卡。

侧栏保留流程与子模块入口，辅助说明对读屏可见；项目设置、训练指南和高级详情按需
展开。折叠使用原生 `details` / `summary`，保留键盘操作。训练指南的阅读状态与任务
完成状态独立，不用静态样式暗示已经执行训练或录制。

通知只显示需要处理的新信息：当前版本不重复占据每页，版本变化仍提供刷新入口，
服务故障与降级仍显示原因和恢复操作。资源未配置的空状态提供对应安装入口，不引导
用户先连接无关设备。所有颜色和字号沿用 `tokens.css` 的主题令牌。

参考的是这些平台的信息组织方式，并按平台现有业务调整：

- [Foxglove 面板](https://docs.foxglove.dev/docs/visualization/panels)：可视化占主体，设置与面板操作集中在工具栏和侧栏。
- [Vercel 项目](https://vercel.com/docs/projects)：项目作为上下文，部署、设置与运行记录各有清晰入口。
- [Hugging Face Model Hub](https://huggingface.co/docs/hub/en/models-the-hub)：对象名称清晰，模型、数据与示例分别组织。

## Props 与返回值

### `SimUI.createStatePanel(props)`

返回尚未插入文档的 `HTMLElement`。只接受 `loading`、`empty`、`error` 三种状态；
正常内容由页面自行渲染。未知状态抛出 `RangeError`。

| Prop | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `state` | `'loading' \| 'empty' \| 'error'` | 必填 | 当前状态；调用者从请求结果推导 |
| `title` | `string` | 按状态生成 | 默认分别为“正在加载”“暂无内容”“加载失败” |
| `description` | `string` | `''` | 原因、影响或下一步；安全地作为文本渲染 |
| `actions` | `Action[]` | `[]` | 一个或多个明确操作，按数组顺序展示 |
| `className` | `string` | `''` | 额外 CSS 类，由受控页面代码提供 |
| `live` | `boolean` | `false` | 开启后，错误使用 `role="alert"`，其余使用 `role="status"`；均设置 `aria-atomic="true"` |

### `Action`

状态面板的 `actions` 与通知的 `action` 共用这个对象。按钮始终是
`type="button"`，不会隐式提交所在表单。

| Prop | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `label` | `string` | 调用者提供 | 可见操作名称，例如“重新连接”；避免使用无上下文的“确定” |
| `onClick` | `(event: MouseEvent) => void` | 无 | 以事件监听器绑定；异步错误与业务判断由调用者处理 |
| `variant` | `'primary' \| 'ghost'` | `'ghost'` | 状态面板可突出主要动作；通知动作使用 `ghost` |
| `disabled` | `boolean` | `false` | 原生按钮禁用状态 |
| `attributes` | `Record<string, string>` | `{}` | 只允许 `aria-*`、`data-*`、`id`、`title`、`name`、`value`；不允许内联事件、样式或改成提交按钮 |

### `SimUI.setButtonPending(button, pending, options?)`

返回传入的按钮；缺失节点安全返回，其他非按钮参数抛出 `TypeError`。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `button` | `HTMLButtonElement`，也可缺失 | 缺失节点没有副作用；真实按钮必须保持稳定，等待期间不要替换它 |
| `pending` | `boolean` | `true` 时禁用、设置 `aria-busy="true"` 并添加 `.is-pending`；`false` 恢复原状态 |
| `options.label` | `string`，可选 | 等待期间的文本，如“保存中…”；省略时保持按钮子节点原样 |

首次进入等待状态时保存原子节点、`disabled`、`aria-busy` 和 `.is-pending`。
重复设置 `true` 不重新保存或改写标签；退出等待恢复原 DOM 节点及其事件监听器。
没有对应等待状态的 `false` 调用没有副作用。

如果等待期间权限或资源可用性发生变化，页面需在恢复后重新计算业务禁用状态，
避免仅沿用请求开始前的条件。组件只管理按钮；表单字段、取消按钮与其他入口由页面锁定。

### `SimUI.withButtonPending(button, task, options?)`

包装一次异步操作，返回与 `task` 同结果的 `Promise`。`task` 为无参数函数，可返回
普通值或 Promise；不是函数时抛出 `TypeError`。`options` 与 `setButtonPending` 相同。

同一按钮处于等待时，重复调用返回同一个 Promise，任务只执行一次。任务成功、异步
失败或同步抛错，均恢复按钮；错误继续向调用者传播。不同按钮共享一个业务操作时，
页面仍须使用共同的提交锁；该包装器按按钮去重，不提供服务端幂等或取消能力。

### `SimUI.createToastController(region, options?)`

为一个 DOM 容器创建控制器，返回 `{ notify, destroy }`。容器参数必须是元素，
否则抛出 `TypeError`。每个区域保留一个控制器，避免重复创建独立队列。

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `region` | `HTMLElement` | 必填 | 通知容器；组件为其补充 `tabindex="-1"`，供删除聚焦通知后的焦点落点使用 |
| `options.limit` | `number` | `3` | 同时保留的通知上限；有限且至少为 1 的值向下取整，其余回退默认值 |

`controller.notify(props)` 返回幂等的 `dismiss()` 函数，调用即可关闭该通知。

| Prop | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `message` | `string` | `''` | 简短结论，例如“GPU 资源已添加” |
| `tone` | `'normal' \| 'error' \| 'success'` | `'normal'` | 错误使用 `role="alert"`，其余使用 `role="status"`；未知值回退普通通知 |
| `description` | `string` | 无 | 可选影响或错误细节，作为纯文本展示 |
| `action` | `Action` | 无 | 可选恢复动作；点击后不会自动关闭，由调用者调用 `dismiss()` |
| `duration` | `number`，毫秒 | 无动作时 `4800`，有动作时 `0` | `0` 表示无自动关闭计时器；有限值限制到 `0` 至 `2147483647`，其他值使用默认值 |

通知不抢焦点，带“关闭通知”可访问名称的原生关闭按钮。自动关闭计时器在指针悬停
或焦点进入时暂停，两者均离开才继续剩余时间。相同语气、消息、说明和动作名称在
短时间内重复调用会复用原通知；因此不同业务操作需要明确的消息文本。

队列超限时优先移除最早且未被键盘聚焦的通知，保护正在操作的按钮。手动关闭聚焦
通知后，焦点落到相邻通知的关闭按钮或容器。常驻只表示没有计时器，通知仍可能因
队列上限被移除；必须持续保留的失败应同时显示在相关页面或表单中。

`controller.destroy()` 清除通知、计时器和监听器；重复销毁安全。销毁后的
`notify()` 返回空操作，不再追加内容。

## 页面状态与可访问性约束

- 首次读取使用 `loading`；只有成功读取且列表确实为空才使用 `empty`。网络失败、
  权限不足与尚未请求不能伪装成没有数据。
- 刷新时可保留上次成功内容，并明确“暂时无法确认最新状态”。后台轮询未请求某个
  辅助数据源时，不覆盖该数据源原有值或错误状态。
- 轮询默认保持安静。`live` 只用于需要用户知道的状态转换，避免每次 DOM 重建重复
  播报；已在 live region 内的状态面板通常不再开启自己的 `live`。
- 通知条目自行提供 `status`/`alert` 语义，容器不叠加 `aria-live` 或
  `aria-atomic`，避免读屏重读整个队列。
- `createStatePanel` 不自动设置所在容器的 `aria-busy`。页面仅对正在等待的内容
  区域或表单设置该属性，结束时清除等待状态。
- 错误文案写清发生了什么、影响及下一步；把表单错误留在输入附近，必要时用
  `aria-describedby` 关联，不能只显示短暂通知。
- 列表更新保留稳定节点。必须重建时，以资源 ID 和动作标识恢复仍然存在的控件；
  删除当前项后，应移动到相邻项或有名称的列表标题。
- 使用原生按钮和语义容器。图标仅作装饰，按钮名称必须由文本或 `aria-label`
  提供；禁用状态之外仍需显示原因和可行的下一步。

## 响应式、主题与长文本

组件样式归 `app.css` 的既有样式层，沿用工作台的断点和触控目标。状态面板的文字列
随容器收缩，动作可换行；通知宽度受视口限制、使用安全区间距，队列过长时在容器内
滚动。粗指针设备的动作按钮使用至少 44px 的触控目标，等待动画遵循
`prefers-reduced-motion`。

长模型名、资源名、地址和错误说明必须可换行；布局使用 `min-width: 0`、
`overflow-wrap`，不能把恢复步骤藏在省略号后。核心结论和操作保持可见，技术细节
按需要放在说明区。所有外部文字由组件使用 `textContent` 渲染；不要把用户文本
插入 `innerHTML`，也不要将远端值用于 `className` 或任意 DOM 属性。

新颜色与字号只进入 `tokens.css`，主题相关令牌同时覆盖浅色与暗色。引用令牌前先
搜索其定义与已有引用；不得增加页面内联样式、私有断点或放宽棘轮预算。规则见
[`D-001`](./decisions/D-001-css-ratchet-token-single-source.md) 与
[`ui-layout-invariants.mjs`](../services/sim2real-web/ui-layout-invariants.mjs)。

## 使用示例

### 请求失败后保留恢复入口

GPU 资源、板卡列表、记录和遥测可共享状态面板，具体权限、数据及后续动作由页面
提供。组件只生成 DOM，不自动重试：

```js
function renderResourceError(list, retry, hasPreviousData) {
  const panel = SimUI.createStatePanel({
    state: 'error',
    title: '暂时无法读取资源',
    description: hasPreviousData
      ? '保留上次读取的资源，重新连接后再确认在线状态。'
      : '请检查工作区服务后重新连接；资源是否为空尚未确认。',
    actions: [{ label: '重新连接', onClick: retry }],
  });
  list.prepend(panel);
}
```

### 独立异步按钮

下面的 `refreshResources` 由业务层注入，负责请求、渲染和权限。若操作涉及一组
字段和多个入口，沿用 GPU 表单的页面提交锁，并在 `finally` 恢复字段状态。

```js
function wireRefresh(button, refreshResources, toasts) {
  button.addEventListener('click', async () => {
    try {
      await SimUI.withButtonPending(button, refreshResources, {
        label: '正在刷新…',
      });
    } catch (error) {
      toasts.notify({
        tone: 'error',
        message: '资源刷新失败',
        description: error instanceof Error ? error.message : '请稍后重试。',
      });
    }
  });
}
```

### 带恢复动作的通知

容器放在页面适当位置，由样式控制定位；不设置额外 live 属性。重试成功后显式
关闭错误通知，重试失败保持页面内错误与恢复动作可用。

```html
<div id="example-toasts" class="toast-region"></div>
```

```js
const toasts = SimUI.createToastController(
  document.getElementById('example-toasts'),
  { limit: 3 },
);

function showRetryNotice(retry) {
  const dismiss = toasts.notify({
    tone: 'error',
    message: '资源暂时不可用',
    description: '已保留当前配置，可重新检查连接。',
    action: {
      label: '重新检查',
      onClick: async (event) => {
        try {
          await SimUI.withButtonPending(event.currentTarget, retry, {
            label: '检查中…',
          });
          dismiss();
        } catch (error) {
          toasts.notify({
            tone: 'error',
            message: '连接检查未成功',
            description: error instanceof Error ? error.message : '请检查服务。',
          });
        }
      },
    },
  });
}
```

## 验证与扩展

变更前后先运行静态 UI 门禁；组件契约和页面接线分别运行对应行为测试：

```bash
npm run verify:ui
npx vitest run --configLoader runner services/sim2real-web/ui-components.test.ts services/sim2real-web/ui-behavior.test.ts
npm run verify:escape-audit
git diff --check
```

真实浏览器验收需先按 [`first-run.md`](./first-run.md) 启动服务。起第二个实例时
指定独立 `RDK_SIM2REAL_STORAGE_DIR`，浏览器写账本的 sweep 每次使用新存储。
将 `RDK_SIM2REAL_BASE_URL` 指向本次实例，再运行：

```bash
node services/sim2real-web/ui-responsive.spec.mjs
node services/sim2real-web/ui-components-browser.spec.mjs
npm run verify:ui-path
```

浏览器 sweep 的 `SKIP` 不代表通过。检查窄屏与桌面、两种主题、减少动画、长文本，
以及加载/空/错误后的恢复路径；键盘检查 Tab、Shift+Tab、关闭通知和按钮等待
期间重复提交。读屏体验另按
[`ui-screen-reader-checklist.md`](./ui-screen-reader-checklist.md) 人工核对。

添加新组件时保持 DOM 契约小且独立，先写失败反例，再实现并在实际视图接入。
改变导航或 IA 时同一变更更新 `ui-ia.spec.mjs`；发布前运行仓库完整 `npm run verify`。
验证报告记录本次命令、退出码、跳过项和残余风险，不将瞬时测试数量写进组件契约。
