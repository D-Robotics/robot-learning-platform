# 声明式任务规格（task spec）

**目的**：新增一个评测任务 = 写一个 JSON，不改 Python。阈值、信封、命令都写在文件里，
阈值随报告一起输出（`dynamicsFacts.taskDefinition`），报告里记 `taskSpec` 路径，可追溯。

## 1. 用法

```bash
cd engines/microduck-eval
../../.eval-venv/bin/python -m microduck_eval.report \
  --task-spec task-specs/duck-stand.json \
  --policy /path/policy.onnx --model-root /path/to/microduck_rl \
  --episodes 50 --trusted-policy \
  --out eval-report.json
```

`--task-spec` 会覆盖 `--task` 与它自带的信封；`--envelopes` 不写时默认读取 spec 里声明的全部信封。

## 2. 结构

```json
{
  "schemaVersion": 1,
  "id": "duck-stand",
  "kind": "hold",
  "displayName": "站立保持",
  "parameters": { "maxDriftM": 0.05, "fallHeightM": 0.06, "fallTiltRad": 1.05 },
  "envelopes": {
    "nominal": { "seed": 20260916, "episodes": 50, "episodeSeconds": 4.0 },
    "hard":    { "seed": 20260917, "episodes": 50, "commandDropout": 0.02, "payloadFraction": 0.05 }
  }
}
```

### 2.1 任务种类与必填阈值

| `kind` | 必填参数（单位） | 成功判据 |
| --- | --- | --- |
| `ball-kick` | `minBallTravelM`、`minPeakBallSpeedMps`、`fallHeightM`、`fallTiltRad` | 球位移 ≥ 阈值 **且** 峰值球速 ≥ 阈值 **且** 未摔倒 |
| `velocity` | `speedToleranceMps`、`minForwardM`、`fallHeightM`、`fallTiltRad`、`steadyWindowStartS` | 稳态窗口内速度误差 ≤ 阈值 **且** 前进 ≥ 阈值 **且** 未摔倒 |
| `hold` | `maxDriftM`、`fallHeightM`、`fallTiltRad` | 未摔倒 **且** 全程漂移 ≤ 阈值 |

摔倒在三种任务里都是同一个定义：`minBaseHeightM < fallHeightM` **或** `maxTiltRad > fallTiltRad`。

### 2.2 信封可覆盖字段

`seed`、`episodes`、`episodeSeconds`、`basePosJitter`(3 数)、`baseYawJitter`、
`ballDistance`、`ballDistanceJitter`、`ballLateralJitter`、`commandDropout`、`gyroNoiseStd`、
`payloadFraction`、`twist`(3 数)、`headPose`(4 数)、`bodyPose`(6 数)、`notes`。

信封名必须是引擎已发布的两封之一（`nominal` / `hard`）——它们分别承载"工厂标定"与
"扰动"两种语义，凭空造一个名字会让报告失去可比性。

## 3. 失败即报错（fail-closed）

下列情况**直接报错**，绝不静默取默认值：

| 情况 | 报错 |
| --- | --- |
| `schemaVersion` 不匹配 | `schemaVersion 99 is not supported` |
| `id` 含非法字符（如 `../escape`） | `id '../escape' must be alphanumeric...` |
| 未知 `kind` | `unknown task kind 'basketball'` |
| `parameters` 多键 / 少键 | `got unknown key(s) [...]` / `missing required 'fallTiltRad'` |
| 阈值越界 | `... is outside [low, high]` |
| 未知信封名 | `unknown envelope 'impossible'` |
| 信封里的未知字段 | `unknown field(s) ['nopeField']` |
| 向量长度不对 | `twist must be 3 numbers` |
| 向量分量越界 | `twist entry 99.0 exceeds ±5.0` |
| 文件不存在 / JSON 语法错 | `task spec not found` / `invalid JSON: ...` |

## 4. 已发布规格

| 文件 | kind | 说明 |
| --- | --- | --- |
| `task-specs/ball-kick.json` | `ball-kick` | 与内置 `BallKickTask` 逐阈值一致（回归测试守护） |
| `task-specs/walking-velocity.json` | `velocity` | 与内置 `VelocityTask` 一致，命令钉在额定 0.4 m/s |
| `task-specs/duck-stand.json` | `hold` | **新任务族，纯声明式**，用来证明"加任务不改代码" |

`tests/test_task_spec.py` 会断言前两者与内置类**逐阈值相同**：规格与代码一旦分歧，
报告里的阈值就不再是真正用于判定的那个，这是必须失败的。

## 5. 尚未支持（诚实边界）

* 需要**新物理**的任务（篮筐、滚球面、多球、多机）不能只靠 spec：那要动仿真场景，
  目前已落地的扩展是任务语义与信封，不是资产。
* spec 不支持自定义度量口径（例如"球穿过球门"这种需要球门几何的判据）；
  现在只有三种内建口径，加口径要改代码。
* spec 不做 episodes 下限校验——`episodes` 太小会被**发布门禁**按"证据不足"拒绝，
  而不是在这里拦下；这条边界是刻意的：门禁才是发布权威。
