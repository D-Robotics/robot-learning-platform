# lerobot-converter（平台轨迹 ↔ LeRobot v3.0 数据集双向转换）

`engines/lerobot-converter` 是平台的**生态入场券**：一个 CLI 数据转换工具（不是训练
引擎，不注册进 worker 的引擎列表），把平台与世界最大的机器人学习数据生态
LeRobot 连成双向通道——

- **import（进场）**：Hub 上 4168 个 LeRobot 社区数据集（aloha、pusht、xarm、
  L2D 驾驶……）转成平台可训练的轨迹 JSONL，直接喂
  `engines/act/train_act.py`（ACT）或 `engines/offline-bc` 做 BC 训练——本平台
  的模仿学习从此不必从零采示教；
- **export（回馈）**：浏览器录制器 / 服务端遥测的轨迹 JSONL 转成 LeRobot
  v3.0 数据集目录，可 push 回 Hub 或交给任何 LeRobot 工具链。

```bash
# 安装（pyarrow 是两个方向的硬依赖；视频另需系统 ffmpeg）
python3 -m pip install --user pyarrow        # 或按 requirements.txt 锁定版本
brew install ffmpeg                          # macOS；Debian/Ubuntu: apt-get install ffmpeg

# 导出：轨迹 JSONL -> LeRobot v3.0 数据集目录（可多文件按序拼接）
python3 engines/lerobot-converter/lerobot_convert.py export \
  recordings/run-07.jsonl recordings/run-08.jsonl \
  --out dataset/ --fps 50 --task "stack the rings"

# 导入：LeRobot 数据集目录 -> 平台轨迹 JSONL（tabular 模式）
python3 engines/lerobot-converter/lerobot_convert.py import \
  ~/datasets/lerobot/aloha_sim --out train.jsonl
python3 engines/act/train_act.py train.jsonl --out model.json   # 直接可训练

# 导入带视频的数据集（解码 mp4 为 cameraFrame 原始像素）
python3 engines/lerobot-converter/lerobot_convert.py import \
  ~/datasets/lerobot/pusht --out train.jsonl --with-video
```

两个方向结束时 stdout 各打印一行 JSON 摘要（episodes/frames/obsDim/actDim/
videos/fps/output），失败一律 `[lerobot-converter] FAIL — <原因>` 到 stderr 并
exit 2，不留半成品输出。

## 输入格式（export 侧，三种形态全收）

| 形态 | 行样例 |
| --- | --- |
| 裸 step 行 | `{"t":0.02,"observation":[...],"action":[...],"done":false}` |
| 浏览器录制器 | 首行 `{"type":"header","format":"microduck-trajectory-v1",...}` + `{"type":"step",...}` 行 |
| 服务端遥测分片 | 一行信封 `{"runId":"...","samples":[step,step,...]}` |

- 时间字段容忍 `t` / `time` / `timestamp`；`observation` 别名 `state`；
- `type:"event"` 行剔除（生命周期标记，不是帧）；
- episode 边界 = `done:true` + 每个输入文件 EOF 隐式收尾（文件是完整 episode
  的源，不是半个 episode 的源）；
- 观测/动作必须是数值列表、有限值、维度跨**所有**输入文件一致；可选字段
  （`reward`、`cameraFrame`）要么每步都有要么全无；违规一律 fail-closed
  `ValueError` 带 `line %d`（信封内再加 `sample %d`）。

## 格式映射表

| 平台轨迹字段 | LeRobot v3.0 feature | 说明 |
| --- | --- | --- |
| `observation` / `state` | `observation.state` | float32，shape `[obs_dim]`（Hub 惯例；官方 DEFAULT_FEATURES 同为 float32） |
| `action` | `action` | float32，shape `[act_dim]` |
| `reward`（可选） | `reward` | float32，shape `[1]`（标量列） |
| `cameraFrame`（可选） | `observation.images.camera_frame` | dtype `video`，shape `[C,H,W]`（官方通道在前），mono8/rgb8/bgr8（bgr8 导出前翻成 RGB） |
| `t` / `time` / `timestamp` | `timestamp` | **均匀化**为 `frame_index / fps`（见已知限制） |
| header `sampleHz` | `info.json` `fps` | `--fps` 覆盖优先；多个 header 冲突时必须 `--fps` 裁决 |
| `--task` 参数 | `meta/tasks.jsonl` + 每 episode 的 `tasks` | 单任务数据集 |
| `done:true` / EOF | `meta/episodes.jsonl` 的 `length` | episode 边界由元数据记录 |
| 导入方向 | `observation.state`/`action` 列 → `observation`/`action`；`timestamp` → `t`；episode 末行补 `done:true` | 导出「能被 act 直接训练」的录制器格式 |

输出目录结构（v3.0，episode-per-file 布局）：

```
dataset/
  meta/info.json          # codebase_version "v3.0"、robot_type、totals、
                          # chunks_size 1000、data_path/video_path 模板、
                          # fps、splits {"train":"0:N"}、features 表
  meta/tasks.jsonl        # {"task_index":0,"task":"..."}
  meta/episodes.jsonl     # {"episode_index":N,"tasks":[...],"length":L}
  data/chunk-000/episode_000000.parquet   # 列：observation.state、action、
                                          # (reward)、timestamp、frame_index、
                                          # episode_index、index、task_index
  videos/chunk-000/observation.images.camera_frame/episode_000000.mp4
```

无 `cameraFrame` 的输入是合法的纯 tabular 数据集：`info.json` 不含 video
features、`total_videos=0`、`video_path=null`（对齐官方 `use_videos=False`
路径）。

## 视频导出契约

`cameraFrame` 的 `data` 是**标准 base64 的原始像素字节**（不是 JPEG）：
`width × height × channels` 字节。导出把原始帧 pipe 给 ffmpeg
（`-f rawvideo`）：

- **mono8 → 单色 H.264（`-pix_fmt gray -qp 0`）：数学上无损**。这是往返契约
  的来源：`import --with-video` 解码回的 cameraFrame 与原始字节**逐字节相同**
  （有测试断言）；
- rgb8/bgr8 → `yuv420p`（`crf 18`，视觉无损）：RGB→YUV 色度下采样本身有损，
  这是格式固有代价，文档如实声明；bgr8 先用 numpy 翻转通道；
- 混用不同分辨率/编码 → fail-closed；ffmpeg 不在 PATH → fail-closed 给精确
  安装提示；**奇数宽高的彩色帧同样 fail-closed**（yuv420p 只支持偶数尺寸），
  mono8 奇数尺寸不受影响。

导入方向 `--with-video`：ffmpeg 逐帧解码为 rawvideo 再 base64，**帧数必须与
parquet 行数一致**（每 episode 对齐 + 总数对齐，不一致 fail-closed）。默认关
闭；数据集声明了 video feature 而未带 `--with-video` → 拒绝并提示。

## import 支持的数据集版本与布局

| codebase_version | 布局 | 支持情况 |
| --- | --- | --- |
| v3.0（本工具导出 / 早期 v3 发布） | `episode_XXXXXX` per-file 分片 + `episodes.jsonl`/`tasks.jsonl` | 完全支持 |
| v2.1（Hub 存量主力） | 同上，`tasks.jsonl` 可能是纯字符串行 | 完全支持 |
| v3.0（lerobot 当前 main） | `file-XXX` 多 episode 分片 + `meta/episodes/`、`meta/tasks.parquet` | 完全支持（按 `index` 列排序、按 `episode_index` 列切分） |
| v1.0 | `meta/meta.json`，无 chunk 目录结构 | **fail-closed 拒绝**并给迁移命令（`python -m lerobot.scripts.convert_dataset_v1_to_v2`） |

数值统一转 python float；parquet 里的 NaN/Inf/null 一律 fail-closed。

## 平台工程保证（与其他引擎同一标准）

- **fail-closed 全家**：维度不一致、非数值（布尔不是数）、NaN/Inf、空数据集、
  未知行类型、非布尔 done、可选字段半缺、cameraFrame 畸形/混用、输出目录
  非空、v1.0 数据集、视频数据集无 `--with-video`、视频帧数与 parquet 行数
  不一致——全部 `ValueError`，消息带 `line %d` 定位；
- **失败零残留**：export 全量校验通过才开始写盘，中途失败删除半成品目录；
  import 在每个 episode 校验通过后才写文件；CLI 失败 exit 2 + stderr 一行
  `FAIL`，绝无 Traceback 泄漏（测试断言）；
- **确定性**：同输入两次 export，`info.json`/`episodes.jsonl`/`tasks.jsonl`
  逐字节相同（测试断言）；pyarrow 按 requirements.txt 锁定版本后 parquet
  产物同样可复现；
- **往返闭环**：export → import → export 保 episode 结构与 obs/act 数值
  （rtol 1e-6，测试断言）；import 产物满足 ACT 引擎 `load_dataset` 的全部
  契约（测试内复制最小校验语义断言，不 import act 模块本身）。

## 已知限制（诚实清单）

- **时间戳均匀化**：LeRobot 官方 writer 的 `timestamp` 列就是
  `frame_index / fps`（源码如此），export 照做——录制器行里的原始 `t` 只用于
  校验/顺序，不进 parquet；掉帧/变速录制导出后时间轴被重采样到均匀网格。
  视频帧在 mp4 编码下本来也只能均匀化，这是格式级取舍；
- **RGB 视频有损**：yuv420p 色度下采样，往返不逐字节相等（mono8 无损往返）；
- **v1.0 不支持**：必须先用官方脚本迁移到 v2.1；
- **tabular-only 契约**：不带 `--with-video` 的 import 是纯表格转换；数据集
  有 video feature 而未开启该旗标时**拒绝**而非静默丢帧；image feature
  （帧文件存储在 parquet 外）同样拒绝并说明原因；
- **单相机**：平台轨迹格式每步一个 `cameraFrame`，多 video feature 的数据集
  fail-closed 说明；导出侧 cameraFrame 固定映射为
  `observation.images.camera_frame`；
- **fps 整数化**：LeRobot `fps` 字段是整数，分数 sampleHz 的 header 需
  `--fps` 显式裁定。

## 与官方实现的对齐情况（标注「待核对」的字段）

本工具的 v3.0 字段名与取值按 huggingface/lerobot 官方源码核对
（`CODEBASE_VERSION = "v3.0"`、`DatasetInfo` 字段表、`DEFAULT_FEATURES` 的
dtypes/shapes、`DEFAULT_CHUNK_SIZE = 1000`、path 模板、`splits` 的
`"0:N"` 格式、shape-(1,) feature 序列化为标量列的规则）。以下为**经核对后
的有意偏离**，供 Hub 互操作时复查（官方 main 分支仍在演进）：

- `total_videos`/`total_chunks`：v2.1 时代字段，官方当前 main 的
  `DatasetInfo` 已不声明，但官方 reader 把未知键当可选——保留它们让老工具链
  与 Hub 数据查看器满意；
- episode-per-file 分片（`episode_XXXXXX.parquet`）：已发布 v3.0 规范与全部
  v2.1 存量数据的布局；官方 main 已改为多 episode 聚合的 `file-XXX` 分片 +
  parquet 元数据——**import 两种都读**，export 按前者（任务契约）；
- video feature 未写官方 `info` 子块（`video.fps`/`video.codec` 等逐视频编码
  统计，官方由 encoder 回填）：读侧不依赖它，待需要与官方 stats 工具链对接
  时补。

## 跑契约测试

```bash
# 47 个用例：行解析三形态、fail-closed 家族、meta 结构、往返（rtol 1e-6）、
# 确定性逐字节、mono8 视频逐字节往返、v2.1/current-main 布局导入、CLI 端到端；
# pyarrow/ffmpeg 缺失时相关用例 SKIP（退出码仍为 0），纯逻辑用例照跑
python3 engines/lerobot-converter/test_lerobot_convert.py
```

依赖：pyarrow（两个方向，parquet 是物理格式）+ numpy（bgr8 通道翻转）；视频
导出/导入另需系统 ffmpeg（运行时探测，fail-closed 给安装提示，刻意不做 pip
pin）。锁定流程与其他引擎一致：改 `requirements.in` 后
`npm run lock:engines` 重新生成带哈希的 `requirements.txt`。
