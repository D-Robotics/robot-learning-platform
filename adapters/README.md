# RDK Robot Adapter SDK

每个设备通过一个声明式 manifest 接入平台，业务页面、训练 Run、评测、台账和发布闸门不按机型分叉。

最小接入步骤：

1. 创建 `adapters/<device>.json`，符合 `shared/robot-adapter.ts` 的 manifest。
2. 关联一个 `profiles/*.json` 硬件 profile。
3. 实现仿真 backend（先可用 `kinematic`，再替换为 Gazebo/Isaac/MuJoCo）。
4. 实现 observation/action/telemetry adapter，并接入 BoardAgent。
5. 运行 `npm run verify:hardware-adapters` 和设备专属 smoke test。

也可以直接运行 `npm run create:adapter -- <id> <family> <displayName>` 生成模板；完成
`CHANGE_ME` 字段后运行 `npm run verify:adapters`。模板默认 `provenance.mock=true`，
只有替换为真实板卡话题并通过 `npm run verify:live-board` 后，才应进入运动 Canary。

OriginBot 的 `originbot-differential-drive.json` 是参考实现；RDK Duck 只需新增自己的 manifest 和适配器。
