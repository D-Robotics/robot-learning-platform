# Security

请不要在 issue、日志或 pull request 中公开 RoboGo token、SSO cookie、SSH 密码、设备公网地址或遥测中的个人信息。

报告安全问题请通过 D-Robotics 内部安全渠道，不要先公开利用细节。部署时将 RoboGo token、OIDC client secret 和存储凭据放在 secret manager 或 root-only 环境文件中，禁止写入前端、URL、manifest 或 ledger。
