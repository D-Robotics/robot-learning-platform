# RDK Robot Learning 插件（Qoder / Studio） 0.5.1

Qoder 用户请先读 references/qoder-first-run.md，运行 setup-qoder-macos.command 或 setup-qoder-windows.cmd，仅配置本插件，不改 Studio，并生成Qoder本机导入包.zip。桌面请上传这个本机包，不要上传未配置的原ZIP。新机器人说：先离线，请逐题引导我输入。

Studio 用户：解压到最终目录后，Windows 双击 setup-windows.cmd，macOS 双击 setup-macos.command。
安装器自动准备兼容 Node、校验下载摘要、生成配置，并接入已初始化的 Studio。
不需要平台源码、npm install、手写密码或 Cookie。其他宿主导入生成的 .mcp.json。
完整说明见 references/workshop-first-run.md。

支持登录继承的 Studio 自动复用当前任务账号；配套接线适配 Windows/macOS 安装路径，
只修改文件摘要匹配的宿主，并保留备份。不停止正在进行的任务；版本不兼容不强行覆盖。
其他宿主仅访问平台数据时使用 rdk_auth_login 打开浏览器确认，再调用 rdk_auth_status；本地课堂知识与证据字段检查无需平台登录。

已有统一账号，无须提前访问学习平台。首次训练不依赖成功历史；资源就绪后按需登记课程模型。
教师须先分配学员可见的计算资源；插件不会借用其他账号资源或自动开通计费算力。

学员可以说：帮我做一次 OriginMan 受扰恢复短训练，评测后播放本次回放。
固定短训仅仿真，8192 步 SAC+GPU；参数调整走平台工作台或公开提交工具。

网络异常保留登录；断线、超时与重复点击不重交。重启后按同一实验引用恢复原 Run。
评测核对父 Run 与策略摘要；completed 不等于学会，链接也不等于视频已经播放。

底层便携核心来源见 upstream-provenance.json，扩展摘要见 provenance.json，文件摘要见 FILES.sha256。
原始分享包不含凭据；配置后含本机路径，不要把配置后的私人副本再分发。

支持实验会话API的平台可在同一账号下跨 Studio、Qoder 和浏览器恢复本次实验，并打开共用实验页查看真实曲线、同源对比与回放。旧平台明确保留本机接续范围，不声称跨机器同步。
