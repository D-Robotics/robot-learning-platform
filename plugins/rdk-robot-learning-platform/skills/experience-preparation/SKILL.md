---
name: experience-preparation
description: 带用户完成 OriginMan Workshop：参考仿真、短训练、同源评测、曲线对比、回放与保存；也可按需准备其他机器人体验场景。
---

## 一句话短训练

用户说“带我完成 OriginMan Workshop”或要求短训练、评测、回放时，先用 `rdk_experience_guide` 取得本轮明确实验。先打开 `course.links.simulation`，实际启动并观察基础 PD 参考；然后用专用短训练工具提交固定8192步、等待原Run、做同源评测、等待原评测、恢复实验。专用工具内部核对课程manifest、模型和绑定资源，不为此反复搜仓库、读旧验收报告、手拼提交或调用通用准备工具。咨询不提交，失败保留原Run，不改参数或资源重交。

返回 `links.experiment` 时打开这个本次实验页；旧平台才打开工作台并按 `selection` 核对训练与评测。视频用页面播放器，不直接导航原始WebM。实际观察画面和播放进度后才确认播放；无观察能力明确待播放。

默认使用工具 `studentReply`：最多三句中文加一个实验页链接。曲线和比较已在页面显示时，不再抄整张技术表。正常校验在后台做，不逐项播报；只在训练、评测、结果阶段变化时简短更新。技术参数、账号、UUID、摘要和英文套件名按需展开。调参是可选后续，不列成本轮欠缺。


其他机器人、录制、通用参考配置或仿真恢复，按实际请求读取 [通用场景准备](../../references/experience-preparation-general.md)。OriginMan 完整 Workshop 不需要加载通用场景、硬件验收或历史项目报告。
