---
name: experience-preparation
description: 用户说“带我开始 Workshop”“继续”“看看效果”时，调用课程入口后立即给可点击按钮，学员点一下进入工作台；不播报加载技能或打开页面。支持接续及自定义实验。
---

## 一句话进入，按钮推进

初次开始用 `rdk_learning_guide`。重新开始传 `intent:"new"`，携带用户已经选定的任务；任务不明确时只展示工具返回的问题。舞蹈多段配置用 `dance`，按工具返回的下一步选算力和确认配方。明确要求本机训练时先用 `rdk_development_targets({action:"list-compute",local:true})`，舞蹈额外传 `engine:"originman-dance-ppo"`。

“继续”或“看看效果”用 `rdk_learning_guide({intent:"results",runId})` 读原 Run，展示本轮链接；同一会话内也可沿用已绑定的舞蹈 Run。明确提出改参重训时传 `intent:"retry"`、原 `runId` 和用户指定的 `changes`，展示改动，等确认再传 `confirmed:true`，按工具返回的 `nextArguments` 提交。已有 Run 的查进度与新一轮提交是两个步骤。


明确选择恢复课程后，使用 `rdk_workshop({intent:"start"})`，继续、结果和新实验分别用 `continue`、`results`、`new`。算力和预算在恢复课程页面选择。

本课程的完整教学边界与步骤见[Workshop课程说明](../../references/workshop-course.md)。

用户问 OriginMan 舞蹈训练或要自定义舞段时，按[舞蹈插件状态与证据](../../references/originman-dance-status.md)区分已接入代码与已验收运行环境；幅度、限幅和证据边界见[舞蹈幅度与有效限幅](../../references/originman-dance-envelope.md)，准确参数结构见[训练技能的舞蹈分支](../training-runs/SKILL.md)。只设计舞蹈时调用`rdk_originman_dance_draft`；明确要训练并确认配方后，用引导返回的 `nextArguments` 调用 `rdk_originman_dance_train`。提交使用[独立的OriginMan 78→18舞蹈模型契约](../../references/originman-dance-manifest.json)，不可替换成受扰恢复的14→2模型。资源或Worker未通过检查时停止，不切到恢复任务。提交后立即打开本轮Run的只读详情页，训练期间等待和每次状态查询继续指向同一Run；终态再读取qualityGate、制品与回放。舞蹈“继续/看看效果”直接读取已知舞蹈Run，不重新提交。详情页逐项展示本次配置、曲线与质量门；只有平台返回同源本次Run视频链接且策略、轨迹摘要匹配时才播放。训练completed不代表风格质量通过；当前流程不允许真机部署。

以下按钮工作台规则仅用于明确选择的受扰恢复课程：只展示返回的studentReply，有 links.workshop 才打开工作台。未授权或未选算力时等待用户明确连接或选择。预算、参考观察、训练、等待、评测、回放和保存都在页面，不再先问预算、不调用旧experience_guide或替学员提交训练。Qoder普通开始入口：只调用rdk_workshop后立即展示studentReply里的可点击链接，不调用浏览器工具；学员点击链接进入课程。只有明确要求“替我打开页面”才按qoderNavigation导航：navigate_page({url})→list_pages({})→按完整URL匹配真实编号→select_page({pageId:真实编号,bringToFront:true})。navigate_page成功文字不含编号，不能直接无pageId调用select_page。不要调用外部Browser Connector，也不用截图工具反复证明面板打开。Studio用右侧工作台。无法自动打开时只给该链接和一次点击提示。

学员在页面看完参考或明确跳过，然后点“开始快速体验·8192步”；正式或自定义预算先显示配方确认。此按钮授权训练与同源评测，后续无需继续发提示词。页面刷新、切换宿主和重复点击都恢复原任务，不重交。只有实际播放完才称回放完成；已录制不等于已播放。

## 自由探索始终可用

上述入口仅是默认教学路径，不限制用户明确的训练、参数、引擎、设备、解释或资料请求。用户问“为什么”“换个种子”“只评测”“不要开训”时按真实意图处理，不能强制跳回课程。修改参数须新实验保留旧结果。自由参数、暂停后续步骤、新实验、切换历史均有页面入口；其他机器人按 [通用场景准备](../../references/experience-preparation-general.md)，连接按 [平台连接技能](../setup/SKILL.md)，高级训练按 [训练技能](../training-runs/SKILL.md)。

默认直接给一句中文加一个入口，不等待浏览器导航。执行前及工具之间不输出“我来加载”“我在打开”等过程说明；模型参数、UUID、摘要按需展开，不复读页面图表。
