# Third-party integration notes

本项目当前不把下列项目的源码或运行时作为核心依赖；它们是可选适配方向和产品设计参考。接入时应固定版本或 commit，并随分发包保留对应许可证与版权声明。

| 项目 | 用途 | 许可证边界 |
| --- | --- | --- |
| [Hugging Face LeRobot](https://github.com/huggingface/lerobot) | 机器人数据集、策略和真实/仿真评测的导入导出 | 代码按上游仓库声明；数据集和模型许可证必须单独记录 |
| [Gymnasium](https://github.com/Farama-Foundation/Gymnasium) | 环境 `reset/step`、spaces、终止语义和确定性检查 | MIT；适配器仍需保留环境自身的资产许可 |
| [RSL-RL](https://github.com/leggedrobotics/rsl_rl) | 可选 GPU PPO / 蒸馏训练后端 | BSD-3-Clause；依赖许可证随固定版本核对 |
| [MLflow](https://github.com/mlflow/mlflow) | 可选实验追踪、制品和模型版本注册 | Apache-2.0；服务端部署依赖按实际版本核对 |
| [Rerun](https://github.com/rerun-io/rerun) | 可选多模态时间线和相机/关节/遥测回放 | 以当前上游仓库许可证为准 |
| [DVC](https://github.com/iterative/dvc) | 可选数据与实验 manifest 版本化 | Apache-2.0；远端存储及数据内容许可独立 |
| [Isaac Lab](https://github.com/isaac-sim/IsaacLab) | 可选仿真/RL 适配器 | 代码与 Isaac Sim/Omniverse 的运行时许可分开，不能把后者视作平台默认依赖 |

平台的核心接口和本地 ledger 保持可独立运行。插件通过 [Sim2Real 事件扩展层](docs/sim2real-plugins.md) 接入；不要把第三方 UI、云端账号或对象存储强制放进首屏启动路径。
