# 数据集版本与训练血缘

平台现在把数据集作为一等资源管理。每个数据集可以携带 `version`、`sha256`、`contractId` 和
`sourceRunId`，用于回答“这次训练用的是什么数据、对应哪份策略契约、是否被替换过”。

使用 `POST /api/v1/duck/datasets/upload` 托管原始文件。查询参数为 `name`、`version`、`filename`，
可选 `format`、`contractId`、`sourceRunId` 和 `sampleCount`。请求体为 `application/octet-stream`，
单文件上限为 50 MiB，反向代理需为该路由放行相应大小的请求。平台从文件字节计算 SHA-256，
按账号保存文件。同一名称和版本再次上传相同文件、文件名和元数据时返回原记录。换文件需使用新版本。

使用 `GET /api/v1/duck/datasets/:id/file` 下载当前账号的托管文件，响应头 `X-Dataset-Sha256`
提供文件摘要。已撤销的数据集停止提供下载。平台存储备份包含托管文件。

通过 `POST /api/v1/duck/datasets` 登记时：

- `version` 是由采集器或导出流程提供的不可变逻辑版本；
- `sha256` 是外部对象存储中数据内容的摘要，平台只接受 64 位小写十六进制值；
- `sourceRunId` 必须属于当前账号，避免把其他账号的运行伪装成数据来源；
- 如果同时提供 `contractId`，它必须与来源运行的模型契约一致。

数据库/对象存储接入后，建议用 `dataset.id + version + sha256` 作为不可变对象键，训练请求携带
数据集 ID，评测报告同时记录 `datasetId`。当前 JSON ledger 已保存这些元数据，适合本地和单机验证。

工作台总览中的“研发闭环评分”会检查契约、训练、评测、发布和项目血缘五个维度。它反映软件证据完整度，
不会把 Mock、只读预检或没有真实 X5 运动记录的结果标成真机成功。
