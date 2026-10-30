# OriginMan 版本构建与发布边界

当前 OriginMan 迁移同时维护源码平台和已发布平台的兼容构建。源码中的课程、训练、
评测和插件使用标准测试链验证；线上保留版本有额外的桌面计算和独立物理评测能力，
不能用工具较少的源码构建直接覆盖。

## 保留版本的构建

`services/sim2real-web/retained-release/originman-retained-runtime.json` 固定输入文件与
输出摘要，补丁只允许用于登记的不可变保留版本。输入不同则在创建输出目录前拒绝。

```bash
node scripts/build-originman-retained-release.mjs \
  --base <原保留版本目录> \
  --output <不存在的新版本目录>
```

构建器不会修改输入版本、账号台账、部署配置或凭据。它保留原有控制平面与引擎资源，
应用经过摘要核对的 OriginMan 补丁，加入课程引擎和页面，输出逐文件构建收据。
收据包含源码提交和工作区是否有未提交改动；发布应使用干净工作区重新构建。
原保留版本的完整源码尚未全部恢复，不能把此构建描述成上游完整源码重建。

构建通过不是发布验收。还须从输出目录验证实际 MCP 工具清单保留、原有工具参数兼容、
账号隔离、OriginMan 预检与真实训练评测，以及当前浏览器和 Studio 安装后的行为。
禁止用源码门禁的通过代替保留版本组合的验收。失败和修复前记录保留。

## OriginMan 执行资源

模型由调用方提供，通过受信 Worker 环境的 `ORIGINMAN_SCENE` 指定；页面和 Agent
不能传入任意服务器模型路径。厂家资产不放入公开插件或公共仓库。
在已有 Worker 的引擎配置中合并下列条目，不能覆盖其他引擎：

```json
{
  "originman-recovery": {
    "executable": "<Python解释器绝对路径>",
    "args": ["<平台目录>/engines/originman-straight/workshop_adapter.py"],
    "preflightArgs": ["<平台目录>/engines/originman-straight/preflight.py"]
  }
}
```

目录按部署产物调整，例如构建产物中的 `dist-server/engines/`。OriginMan 源快照复用
`microduck-football/train_football.py`，必须保留该依赖；缺失时预检应阻断。新训练默认使用 CUDA，预检会检查 GPU 实际可计算。显式 CPU 模式仍保留，
专用 CPU Worker 的预检需配置 `ORIGINMAN_TRAIN_DEVICE=cpu`。详见 [GPU 与 CPU 训练](originman-gpu-training.md)。视频另需可用的离屏渲染与 ffmpeg。

预检检查 Python、仿真与训练依赖、任务、实际模型重置和一步物理仿真、内存 ONNX
推理与源快照输入。`readyForSmokeTraining` 只允许开始软件验证，不代表策略质量、
整班并发、真机部署或 Sim2Real 通过。仅仿真制品始终没有硬件部署资格。
