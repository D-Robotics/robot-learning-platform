# 模型注册表（部署方受审白名单）

本目录是 mujoco-web 服务的**部署方模型扩展机制**。这里没有上传接口：每个
`<key>.json` 都是部署方通过自己的配置管理流程（git / scp / ansible）放入并**人工审阅过**
的 MJCF 模型。服务启动时加载全部注册表条目，并做两层校验：

1. **元数据形状校验** —— 必填字段齐全、类型与长度受控（见下表）；
2. **真实编译校验** —— 用 `mujoco.MjModel.from_xml_string` 实际编译，并核对
   `actuator_names` 数量 == 编译产物 `nu`（执行器数）、`initial_qpos` 长度 <= `nq`。

任何一个条目无效都会让服务**拒绝启动**（fail-closed）——注册表里的坏模型不会以
「下拉框里点不开的条目」形式上线，而是在发布时就被挡下来。CI 通过
`npm run verify:mujoco-models` 覆盖同样的校验（无 mujoco 的机器上诚实 SKIP）。

## 安全边界

- 不开放任意 MJCF 上传。这个目录本身就是「受审白名单」：条目像代码一样走审阅。
- `key` 只允许 `[a-z0-9][a-z0-9-]*`（≤32 字符），且不得与内置模型
  （`cartpole` / `double-pendulum` / `originbot`）或其他注册表条目冲突——冲突会在启动时报错，
  部署方不能悄悄顶替一个已审阅的平台模型。
- 加载后模型出现在 `/api/models` 与前端下拉框中，`source: "registry"` 标注来源；
  内置模型为 `source: "builtin"`。
- 只有严格以 `.json` 结尾的文件会被加载。`README.md` 与
  `example-model.json.example`（样例，不会加载）永远被忽略。

## 条目格式

文件名任意（建议用 key 命名），内容为一个 JSON 对象，字段与 `ModelDefinition`
一一对应：

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `key` | string | ✅ | `[a-z0-9][a-z0-9-]*`，≤32 字符，全局唯一 |
| `name` | string | ✅ | ≤64 字符，下拉框显示名 |
| `description` | string | ✅ | ≤400 字符 |
| `xml` | string | ✅ | 完整 MJCF 文档，≤200000 字符，必须能被 mujoco 编译 |
| `actuator_names` | string[] | ✅ | 1..32 个名字，数量必须等于 MJCF 执行器数 |
| `initial_qpos` | number[] | — | ≤64 个有限数，长度 ≤ MJCF 的 `nq` |
| `wheel_radius` | number | — | 差速底盘元数据组的开关；> 0 |
| `track_width` | number | — | 差速底盘轮距；> 0 |
| `max_wheel_speed` | number | — | 轮速上限（rad/s）；> 0 |
| `lidar_angles` | number[] | — | 激光束角度表；需要 `wheel_radius` |
| `lidar_range_max` | number | — | 激光量程；需要 `wheel_radius` |

填写了 `wheel_radius` 的模型会被识别为差速底盘：`/cmd_vel`、里程计、
`controlPeriod`（20 Hz）等路径随之可用；`lidar_angles`/`lidar_range_max` 与
`wheel_radius` 是一组元数据，单独出现会被拒绝。

## 相机约定

浏览器的渲染画面使用名为 `overview` 的固定相机。内置模型都定义了它；
注册表模型**不是必须**提供：没有 `overview` 相机时，服务自动用 MuJoCo
默认自由相机渲染（视角不可控但画面可用）。想要可控的教学视角，就在
MJCF 的 `worldbody` 里加 `<camera name="overview" pos="..." xyaxes="..."/>`。
深度端点（`depth.jpg` / `depth.png`）对非 originbot 模型同样先找 `overview`
相机，找不到时也回退默认相机。

## 放样例

`example-model.json.example` 是一个最小可编译条目。启用方式：

```bash
cp example-model.json.example my-robot.json
# 编辑 my-robot.json，本地先验证：
python3 -c "import sys; sys.path.insert(0, 'services/mujoco-web'); import models"
# 无报错即通过启动校验（需要 pip install mujoco）
```

重启 `mujoco-web.service` 后，模型会出现在 `/api/models` 与前端下拉框。
