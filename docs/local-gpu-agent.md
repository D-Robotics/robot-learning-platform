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

## 关页、重开与同步恢复

训练提交给 Worker 后，关闭浏览器标签页不会终止 Worker 上的训练；浏览器只承担
Local GPU Agent 与平台之间的状态和制品中继。关页期间平台不会自动同步用户电脑的
Worker，页面上的记录可能暂时保留最后一次已知状态。

使用同一平台账号重开工作区后，网页根据该账号的运行记录恢复中继：已认领的运行
继续查询原 Worker 运行编号；尚未认领的运行使用平台运行编号生成稳定的 Worker
幂等键，重试提交和认领。用户电脑上的 Agent、SSH 转发和对应 Worker 必须仍然可达。
同一页面重复刷新工作区只保留一条该运行的同步链。账号切换、登录失效或页面关闭
会停止该页面的中继请求，不会向 Worker 发送取消训练命令。

真实训练的 Worker 报告完成后，网页先下载制品，再上传平台并由平台校验 SHA-256；
上传成功后才将平台运行同步为 `completed`。上传或最终状态同步暂时失败时，页面
会继续尝试；此前已标记完成但漏传制品的旧中继记录，也会在重开后尝试补传。
`mock: true` 的协议演练沿用无真实制品的完成状态，不能作为部署发布证据。

网络错误、HTTP 408/429 和 5xx 每条同步链最多连续尝试 6 次，退避依次为
1、2、4、8、16 秒；成功同步后重新计数。401/403 等永久错误、缺少有效制品摘要
或耗尽重试预算，会在训练状态处提示中继已暂停，后台工作区刷新不会反复重启它。
确认账号、Agent 和 Worker 连接恢复后，点击工作区的“刷新”或“重新连接”可显式
恢复同步；重开页面也会重新尝试。平台的发布、评测签证和制品完整性门禁继续由
服务端执行，中继恢复不代表制品已获准部署。
