---
name: simulation-replay
description: 在 RDK 学习平台打开浏览器仿真、录制轨迹、检查遥测和板端会话、回放运行并生成有证据的回放视频。
---

# 仿真、轨迹与回放

交付实际仿真入口、可检查的轨迹或 Run 回放。参数见 [工具目录](../../references/tool-catalog.md)，连接边界见 [连接契约](../../references/connection-contract.md)。

- `rdk_simulator_open` 返回 `entryUrl`，不操作画布。相对路径应在已配置平台地址/挂载前缀下解析；通过可用浏览器工具打开。用真实 UI 选择任务和动作、开始/停止录制、保存/导出 JSONL。MCP 没有键盘驱动、录制开关或通用仿真控制工具。
- WebGL 不可用时报告真实错误，可继续使用轨迹页；不得用静态截图证明仿真运行。浏览器参考策略是仿真证据，不是当前模型已训练或真机成功。
- 已有 Run 用 `rdk_runs_list` 找 ID，再用 `rdk_runs_replay`、`rdk_telemetry_list`、`rdk_board_sessions`。检查样本数、来源、时间轴、会话停止原因及关联契约；需要回放视觉检查时用工作台的轨迹页。
- `rdk_replay_video` 会请求服务生成视频，只对满足平台证据条件的运行调用。记录返回的视频引用；无相机/无合格真机证据时保留拒绝，不把仿真素材改称真机视频。

遥测 JSONL 导入/上传绑定 Run 通过工作台，或者读取真实版本化 API 后调用；这些没有专用 MCP 上传工具。LeRobot 双向转换见 [仓库能力](../../references/cli-capabilities.md)。

空录制不登记成有数据的 dataset；无样本的 Run 报告暂无可回放证据。用户取消录制时停止并清楚报告已保存/未保存的轨迹；取消 MCP 请求不保证服务已提交的工作撤销，按返回实体检查状态。

## 两种录制入口

画面内“动作录制”导出 `microduck-trajectory-v1`，用于分析或模仿学习。新录制须核对 `pairing: policy-inference-v1`：每组输入与输出来自同一次实际推理。没有该标记的旧数据不能默认视为已对齐训练样本；保存文件也不代表已经建成 dataset 或获得评测证据。

工作台外层“录制状态 → 停止录制 → 保存录制 → 查看录制”使用 `microduck-state-snapshots-v1`，用于完整状态诊断。其 previousAction 不是对齐的训练标签；不要与动作轨迹混用。检查读取帧数、播放推进及末帧停止，明确说明验证的是状态向量播放器还是三维重演，不从一个推断另一个。当前没有专用 MCP 录制或文件上传工具时，如实引导受支持页面操作，不声称对话已经执行了按钮动作。

详细 UI 操作从 `$RDK_ROBOT_LEARNING_PLATFORM_ROOT/docs/hello-world.md`、`docs/product-guide.md` 读取，录制契约入口为 `services/mujoco-web/microduck-community-overlay.test.mjs`。
