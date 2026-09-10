# Contributing

1. 不提交 `.env`、token、SSO cookie、SSH 凭据、设备地址或本机路径。
2. 保持 `Sim2RealAuthPort`、runner、存储、遥测和 BoardAgent 之间的边界；不要把 Studio 私有实现复制进来。
3. 修改契约时同步更新 producer、consumer、测试和 `docs/design`。
4. 提交前运行 `npm run verify` 与 `npx tsc --noEmit`，并检查 `git diff --check`。
5. **每个 `fix:` 提交必须带一个回归测试**，且该测试在父提交上会失败（能复现 bug 的行为级断言，不是字符串存在性检查）。浏览器侧纯逻辑放在 `services/sim2real-web/public/telemetry-core.js`（DOM-free，vitest 直接测），不要把新逻辑写回 `app.js` 再只靠 `ui-ia.spec.mjs` 的正则断言兜底。
6. 本仓库启用 `.githooks/pre-commit`（新克隆执行 `git config core.hooksPath .githooks`）：提交前自动跑语法检查、接线断言、类型检查和受影响的测试，约 5 秒。绕过钩子（`--no-verify`）后必须补跑 `npm run verify`。
7. 每次全量 `npm run verify` 通过后打 tag（`git tag verify-YYYYMMDD-N`），部署只从 tag 出；回滚即回退到上一个 tag。

真实硬件控制必须经过受控 agent 和人工审批；不要在 Web 路由里直接拼接或执行 shell/电机命令。
