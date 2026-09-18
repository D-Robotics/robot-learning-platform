# 缺口补齐与验收边界

本仓库现在提供四个可独立验收的基础实现：

- `proto/sim2real_telemetry.proto`：设备遥测公共外壳、控制/IMU/关节/相机事件 payload 和分片元数据。
- `services/sim2real-web/board_capture.py`：固定槽位 SPSC RingBuffer、前后窗口触发采集、fsync + 原子 rename 的滚动分片和幂等 chunk id。
- `scripts/package-artifact.mjs`：按文件 SHA-256 生成不可变 artifact manifest，并用服务端 HMAC 签名；不把 secret 放进制品。
- `services/sim2real-web/board-ota-agent.py`：板型、契约、不可变性和签名校验；未注入真实执行器时明确阻断。

仍必须由部署环境完成的验收：

1. 在真实 X5 上测量 50Hz 控制线程的写入耗时、overrun、eMMC 寿命指标和断网补传 ACK。
2. 使用真实 protobuf runtime 生成 Python/C++ bindings，并接入 `board-telemetry-uploader.py` 的二进制 chunk 上传。
3. 接入 RoboGo 的真实 endpoint、认证、队列、取消和状态 webhook；未配置时必须保持 blocked。
4. 注入受控 BoardAgent 执行器，完成签名 manifest 下载、A/B 或双槽回滚、急停联锁和审计。
5. 完成一条真实证据链：`run → artifact → deployment → telemetry → evaluation`。

这些条件没有证据前，UI/API 应继续显示 `mock`、`degraded` 或 `blocked`，不能标记为生产 OTA 或真实端云闭环。
