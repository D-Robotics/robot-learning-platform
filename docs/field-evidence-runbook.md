# 满分现场验收 Runbook

仓库内的自动门禁已经覆盖协议和安全边界；以下三步必须在真实环境执行，结果保存到 `docs/evidence/`（不提交密钥、Cookie 或原始内网地址）。

## 1. X5 安全运动

在安全围栏内，用已通过 release gate 的真实 CPU ONNX 制品：

```bash
npm run verify:live-board
```

随后按 `docs/actuator-drive.md` 依次记录：预检、加载、低速 canary、急停、watchdog 超时和回滚。证据至少包含 `deviceId`、`bootId`、`artifactId`、SHA-256、开始/结束时间、急停结果和原始遥测摘要。任一闸门失败都应保留 blocked/failed 状态。

## 2. 第二种实体机器人

使用与 X5 不同的实体机型，复用同一个 task-pack，独立生成训练/评测报告：

```bash
npm run verify:hardware-profiles
npm run verify:originbot-env
npm run verify:originbot-telemetry
```

现场报告必须绑定该机型的 adapter/profile、契约版本、随机种子、成功率和置信区间；不能用 generic 仿真结果代替实体机记录。

## 3. 生产制品签名与回滚

先运行软件 rehearsal：

```bash
npm run verify:artifact-registry
```

再在真实 registry 中发布 `v1`、`v2`，验证下载摘要和签名，切换到 `v2` 后执行回滚到 `v1`，保存 registry 审计事件和设备端启动版本。生产对象必须不可变，部署引用具体 artifact 版本，禁止使用 `latest`。
