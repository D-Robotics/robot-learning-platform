---
name: experience-preparation
description: 用户说“带我开始 Workshop”“继续”“看看效果”时，静默调用课程入口并打开内置按钮工作台，最后只给一句提示；不播报加载技能或打开页面。支持接续及自定义实验。
---

## 一句话进入，按钮推进

“带我开始 Workshop”“开始课程”只调用 `rdk_workshop({intent:"start"})`；“继续”“继续刚才的实验”用 `intent:"continue"`；“看看效果”用 `intent:"results"`；用户明确说“新实验”用 `intent:"new"`，不取消原任务。已有明确实验时可传contextId，否则工具使用当前账号已选实验；多个候选由工作台卡片选择，不能让学员抄UUID，也不猜全局最新Run。

只展示返回的studentReply并打开links.workshop，随后结束回答。预算、参考观察、训练、等待、评测、回放和保存都在页面，不再先问预算、不调用旧experience_guide或替学员提交训练。Qoder按工具返回的qoderNavigation静默导航：内置navigate_page({url})→list_pages({})→按完整URL匹配真实编号→select_page({pageId:真实编号,bringToFront:true})。navigate_page成功文字不含编号，不能直接无pageId调用select_page。不要调用外部Browser Connector，也不用截图工具反复证明面板打开。Studio用右侧工作台。无法自动打开时只给该链接和一次点击提示。

学员在页面看完参考或明确跳过，然后点“开始快速体验·8192步”；正式或自定义预算先显示配方确认。此按钮授权训练与同源评测，后续无需继续发提示词。页面刷新、切换宿主和重复点击都恢复原任务，不重交。只有实际播放完才称回放完成；已录制不等于已播放。

## 自由探索始终可用

上述入口仅是默认教学路径，不限制用户明确的训练、参数、引擎、设备、解释或资料请求。用户问“为什么”“换个种子”“只评测”“不要开训”时按真实意图处理，不能强制跳回课程。修改参数须新实验保留旧结果。自由参数、暂停后续步骤、新实验、切换历史均有页面入口；其他机器人按 [通用场景准备](../../references/experience-preparation-general.md)，连接按 [平台连接技能](../setup/SKILL.md)，高级训练按 [训练技能](../training-runs/SKILL.md)。

默认只在导航后给一句中文加一个入口。执行前及工具之间不输出“我来加载”“我在打开”等过程说明；模型参数、UUID、摘要按需展开，不复读页面图表。
