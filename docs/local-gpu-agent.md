# 用户本地 GPU Agent

## 网页一键安装

生产网页的「GPU 与算力」页面会生成一条只需执行一次的命令。命令从当前平台下载
Agent，写入 `~/.rdk-lab/` 并启动 loopback 服务；用户不需要克隆本仓库：

```bash
curl -fsSLo /tmp/rdk-gpu-agent-install.sh 'https://<平台域名>/agent/install.sh' \
  && sh /tmp/rdk-gpu-agent-install.sh
```

安装器要求 Node.js 22+，并把当前平台域名写入 Agent 的来源白名单。网页随后可以自动发现
`http://127.0.0.1:19190/healthz`。

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

页面的“连接远程 GPU 服务器（SSH）”会调用 Agent 的 `/connect`：Agent 使用用户电脑已有的
SSH key 建立 local forward，再把同一个 Worker 协议暴露给网页。远程 GPU 主机只需要运行
Worker，不必开放 19091 到公网。Worker 的 `/healthz` 会回报 CUDA、GPU 型号和可用引擎，训练
结果会如实记录实际使用的 GPU 或 CPU。
