# 可视化能力对标与优化记录（2026-09）

这份调研只比较“数据如何被看懂、定位和复核”，不比较物理引擎覆盖范围。结论基于官方文档：

- [Foxglove Plot panel](https://docs.foxglove.dev/docs/visualization/panels/plot) 支持时间序列、XY 和数组索引绘图，悬浮查看多条序列的最近值、时间范围控制、播放头联动和 CSV 导出。
- [Foxglove Panels](https://docs.foxglove.dev/docs/visualization/panels) 把可视化拆成可编排面板，支持从 topic/表达式拖入 Plot、Image、Raw Messages 和 Table。
- [Foxglove Playback](https://docs.foxglove.dev/docs/visualization/playback) 对全时间范围做 range loading，让 Plot、Map 等面板能发现异常和趋势，而不是只看最新消息。
- [Rerun Blueprints](https://docs.rerun.io/dev/concepts/visualization/blueprints/) 把数据记录和视图布局分离，布局可以交互调整、保存、共享，并按诊断场景动态生成。
- [LeRobot Dataset Visualizer](https://huggingface.co/spaces/lerobot/visualize_dataset/blob/main/README.md) 将 episode 视频、状态、动作和交互式曲线放在同一浏览器页面；[LeRobotDataset v3](https://huggingface.co/docs/lerobot/lerobot-dataset-v3) 进一步把多模态时序、Parquet/MP4 和流式读取统一起来。
- [Weights & Biases 运行筛选](https://docs.wandb.ai/models/runs/filter-runs) 支持按时间、标签、状态和配置用表达式组合筛选，适合从大量 Run 中快速缩小问题范围。
- [Isaac Lab visualization](https://isaac-sim.github.io/IsaacLab/develop/source/concepts/visualization.html) 同时提供浏览器 Viser、Rerun、录制回放和 live scalar/array plots，说明“实时训练 + 回放 + 可替换 viewer”已经成为工程工具的常见组合。

## 差距判断

| 维度 | 当前平台 | 同类产品常见做法 | 判断 |
| --- | --- | --- | --- |
| 任务引导 | 四步学习闭环、项目/模型/设备上下文、部署安全门 | 多数工具只负责数据或训练观察 | 我们占优 |
| 时序联动 | 已有统一 scrub：奖励、观测/动作热力图、相机帧和回放同步 | Foxglove/Rerun/LeRobot 都把播放头作为一级交互 | 基础能力已对齐 |
| 单点取值 | Canvas 图形已有，但原先不能悬停查值 | Plot hover tooltip 展示多序列最近值 | 本轮已补 |
| 数据导出 | 原始遥测可导入，但缺图表侧一键导出 | Foxglove 支持 CSV，LeRobot 依赖标准数据集 | 本轮已补 CSV |
| Run 分析 | 多 Run 曲线、平行坐标、参数差异表 | W&B 还提供表达式筛选、颜色和大量 Run 管理 | 仍差筛选与趋势查询 |
| 布局编排 | 固定工作台布局 | Rerun/Foxglove 可保存和重排 Blueprint/Layout | 仍差可保存布局 |
| 诊断日志 | 有运行日志和任务证据，但未与时间轴逐条联动 | Foxglove Log 可从日志跳时间、反向随播放定位 | 仍差日志时间联动 |
| 数据规模 | 浏览器本地聚合，服务端保存评测摘要 | LeRobot v3/ Foxglove range loading 面向多模态和长时序 | 仍差长期时序层 |
| 生产告警 | 有状态、质量门和安全阻断 | W&B/Foxglove/Rerun 更强调筛选、标记、告警或诊断视图 | 仍差阈值告警与异常导航 |

## 本轮实现

`services/sim2real-web/public/visualization-enhancements.js` 在不改变现有 Canvas 渲染和证据语义的前提下增加：

1. 奖励曲线、观测热力图和动作热力图的悬浮取值；
2. 奖励曲线聚焦后的左右方向键逐帧查看，并复用统一时间轴；
3. 当前遥测原始样本 CSV 导出；
4. 当前 Run 对比表 CSV 导出；
5. 触屏/窄屏下仍可用的紧凑操作条和可见键盘焦点。

这些交互只读取已有本地样本或当前 Run，不把浏览器内的原始文件静默上传，也不会将聚合摘要重新绘成不存在的曲线。

## 下一阶段建议

要从当前约 8 分提升到 9 分，优先级应是：

1. 把 Canvas 交互抽成可共享的 Plot 组件：时间范围、缩放、框选、最近值锁存、系列开关和导出；
2. 为日志、事件、相机和指标建立统一时间索引，点击任意事件都能跳到同一播放头；
3. 引入长期时序查询和 Run 筛选，支持按设备、任务、版本、来源和质量门筛选；
4. 保存“诊断布局”模板，例如训练诊断、板端延迟、相机/策略对齐和部署回滚；
5. 在边缘侧保留告警和关键窗口，云端恢复后补传，形成实时观测与审计回放两条链路。
