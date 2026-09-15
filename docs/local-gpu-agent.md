# 用户本地 GPU Agent

平台不需要连接用户的 GPU。用户在自己的电脑启动 Agent，网页只连接
`127.0.0.1` 的 Worker-compatible API；远端 GPU 通过 Agent 建立 SSH local
forward，私钥和 Worker token 永远留在用户电脑。

```bash
RDK_GPU_AGENT_PORT=19190 node scripts/local-gpu-agent.mjs
curl http://127.0.0.1:19190/healthz
curl -X POST http://127.0.0.1:19190/connect \
  -H 'content-type: application/json' \
  -d '{"id":"my-5090","name":"我的 RTX 5090","host":"gpu.example.com","user":"robot","sshPort":2222,"remotePort":19091,"localPort":19092}'
```

在平台“我的 GPU 训练资源”中添加 `http://127.0.0.1:19190/proxy`，并按
Agent/Worker 的认证方式填写 token。Agent 只监听 loopback；状态、队列和
训练产物均由用户本地 Worker 管理，平台服务器只接收用户主动同步的元数据。
