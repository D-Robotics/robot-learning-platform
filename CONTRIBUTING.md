# Contributing

1. 不提交 `.env`、token、SSO cookie、SSH 凭据、设备地址或本机路径。
2. 保持 `Sim2RealAuthPort`、runner、存储、遥测和 BoardAgent 之间的边界；不要把 Studio 私有实现复制进来。
3. 修改契约时同步更新 producer、consumer、测试和 `docs/design`。
4. 提交前运行 `npm run verify` 与 `npx tsc --noEmit`，并检查 `git diff --check`。

真实硬件控制必须经过受控 agent 和人工审批；不要在 Web 路由里直接拼接或执行 shell/电机命令。
