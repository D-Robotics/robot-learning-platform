# microduck policy → RDK X5（编译与上板准备）

把平台上训练出来的 `policy.onnx` 做成能上 X5 的量化模型（`.bin`），并让它通过平台的编译门禁。
**这一步不需要 X5 在网**：编译、校准、门禁校验都在开发机完成，板子只用于最后的只读预检与实机跑。

## 实测结果（2026-09-16）

| 项目 | 结果 |
| --- | --- |
| 量化编译 | ✅ `hb_mapper makertbin` 成功，产出 `microduck_walk.bin` **460 879 B** |
| 量化质量 | ✅ 4 个 `Gemm` 全部落到 BPU 跑 int8，cosine similarity **0.9960 ~ 0.9981** |
| 厂商工具自检 | ✅ `hb_model_info` 确认输入 `obs`、`BPU march: bayes-e`、hbdk 3.49.15 / horizon_nn 1.1.0 |
| 平台编译门禁 | ✅ `scripts/compile-policy.mjs --target x5` → `ok: true`、`deployable: true`、`artifact://compiled/x5/policy-x5.bin`、sha256 `57ac460c…`、460 879 B |

也就是说：**"造出可部署制品"这一段已经打通**。剩下没做的只有真正的板端动作（把 `.bin` 拷到 X5 的
`policies/` 并用平台的只读预检确认板卡与运行时），那需要 X5 在线。

## 三步流水线

### 1. 导出 opset 11 的 ONNX（必须）

浏览器仿真吃得下 opset 18，X5 前端**只认到 opset 11**：

```
ERROR *** ERROR-OCCUR-DURING {horizon_nn.build_onnx} ***,
      The opset version of the model is 18, the maximum supported version is 11.
```

`onnx.version_converter` 也降不下来（`Sub` 没有 v14 适配器），只能在导出时用 `opset_version=11`：

```bash
cd ~/microduck_rl
uv run python <repo>/engines/microduck-rl-adapter/x5/export_opset11.py \
  Mjlab-Velocity-Flat-MicroDuck \
  --checkpoint-file logs/rsl_rl/velocity/<run>/model_1500.pt \
  --onnx-file /work/model_opset11.onnx
```

### 2. 校准数据（裸 float32 `.bin`，不是 `.npy`）

工具链用 `numpy.fromfile` 读校准样本：每份是一个 `float32` 裸二进制，元素个数等于 `input_shape`
（本模型 `1x61`，即每份 244 B）。放 `.npy` 会被当裸数据读，报
`cannot reshape array of size 93 into shape (1, 61)`。

```bash
python3 <repo>/engines/microduck-rl-adapter/x5/make-calib-raw.py   # 256 份 × 244 B
```

正式发布请换成**真实观测**：上游 `scripts/infer_policy.py --walking <onnx> --new-cmd-obs --record out.pkl`
会把策略在 CPU MuJoCo 里跑出的 61D 观测写进 pkl（无显示器时 `xvfb-run -a` 可用），转成裸 `.bin` 即可。
`make-calib-raw.py` 是按物理量程生成的占位样本，用来打通往返，**不建议直接用于发布**。

### 3. 安装工具链并编译

官方 X5 工具链只有 Docker 镜像（`hbdk`/`horizon_nn` 都不在 PyPI）。两条路都验证过：

```bash
# 路线 A：能跑 Docker（推荐）
curl -L -o oe_x5_cpu_docker.tar.gz \
  https://d-robotics-aitoolchain.oss-cn-beijing.aliyuncs.com/oe_x5/1.2.8/docker_openexplorer_ubuntu_20_x5_cpu_v1.2.8.tar.gz
docker load -i oe_x5_cpu_docker.tar.gz
docker run --rm -v "$PWD:/work" openexplorer/ai_toolchain_ubuntu_20_x5_cpu:v1.2.8-py310 \
  bash -lc "cd /work && hb_mapper makertbin --config convert.yaml --model-type onnx"

# 路线 B：Docker 起不来（嵌套容器无 overlay/fuse 权限）时，直接用镜像 rootfs
docker load -i oe_x5_cpu_docker.tar.gz          # 或用 tar 直接解开镜像层
ROOTFS=/var/lib/docker/vfs/dir/<image-rootfs-layer>
mkdir -p $ROOTFS/dev
[ -e $ROOTFS/dev/null ] || mknod $ROOTFS/dev/null c 1 3
[ -e $ROOTFS/dev/urandom ] || mknod $ROOTFS/dev/urandom c 1 9
chmod 666 $ROOTFS/dev/null $ROOTFS/dev/urandom
cp -r model_opset11.onnx calib_raw convert.yaml $ROOTFS/work/
sed -i "s#/root/bpu-compile#/work#g" $ROOTFS/work/convert.yaml
chroot $ROOTFS /bin/bash -lc "cd /work && hb_mapper makertbin --config convert.yaml --model-type onnx"
```

踩过的坑（都已固化在脚本里）：

- 发布包是 **xz 不是 gzip**（`tar -xJf`）；Docker 镜像 tar 是正常 gzip。
- 嵌套容器里 `overlay2` 和 `fuse-overlayfs` 都不可用（`/dev/fuse` 建了也 `Operation not permitted`），
  `dockerd --storage-driver=vfs` 能跑但会让 5.16 GB 镜像膨胀到 ~22 GB；空间紧时走路线 B。
- `chroot` 里必须有 `/dev/null` 与 `/dev/urandom`，否则 Python 起不来（`Unable to open /dev/urandom`）。
- 自己 pip 装 py310 wheel 会一路缺依赖（`horizon_nn` → `torch` → `multiprocess` → `tqdm` → `schema`
  → `paramiko`，且 `hb_mapper` 要 `onnx==1.15.0`），所以**优先用官方镜像**；镜像里的 `hb_mapper` 是现成的。

## 接平台编译门禁

`scripts/compile-policy.mjs` 调编译器的格式是 `<compiler> --input <onnx> --output <bin>`，而厂商工具用
YAML 配置、没有这两个命令行参数。仓库里有两个适配器把两者接起来：

| 脚本 | 用途 |
| --- | --- |
| `x5/rdk-bpu-compile.sh` | 在本机编译。`RDK_BPU_OE_ROOTFS` 指向镜像 rootfs 或本机装好的工具链 |
| `x5/rdk-bpu-compile-ssh.sh` | 平台在管理机、工具链在 GPU 机时用 SSH 代理，二进制回传后由平台自己校验摘要 |

两个都会：**检测 opset**（纯 stdlib protobuf 读取，不依赖 onnx 包）→ 超 11 就用
`export_opset11.py` 自动重导 → 分批喂校准样本 → 跑 `hb_mapper` → 把 `.bin` 写到平台要的位置。
任何一步失败都以退出码 2 结束，平台据此判 `bpu-compile-failed`，**绝不会**退回 CPU ONNX。

实测命令（本机 → GPU 机）：

```bash
export RDK_BPU_COMPILER="$(pwd)/engines/microduck-rl-adapter/x5/rdk-bpu-compile-ssh.sh"
export RDK_BPU_SSH_TARGET="ssh-authkey-…@<gpu-host>" RDK_BPU_SSH_PORT=2222
export RDK_BPU_OE_ROOTFS="/var/lib/docker/vfs/dir/<image-rootfs-layer>"
export RDK_BPU_CHECKPOINT="/root/microduck_rl/logs/rsl_rl/velocity/<run>/model_1500.pt"
export RDK_MICRODUCK_RL_DIR=/root/microduck_rl
node scripts/compile-policy.mjs --input policy.onnx --output policy-x5.bin --target x5
# → {"ok":true,"status":"completed","target":"x5","format":"bin","deployable":true,
#    "artifact":{"artifactRef":"artifact://compiled/x5/policy-x5.bin","sha256":"57ac460c…","sizeBytes":460879}}
```

注意 `policy.onnx` 可以**直接给 opset 18 的那份**：包装器会自动从 `RDK_BPU_CHECKPOINT` 重导出
opset 11（同一次训练、同一套权重），因此工作台里"导出 ONNX → 编译"是两步但只需选一次 checkpoint。

## 上板（需要 X5 在线）

1. 把 `policy-x5.bin` 放到板子的 `policies/` 目录（板端 runtime 读这个位置）；
2. 平台「部署」页对 X5 做只读预检：`services/sim2real-web/board-agent-x5.py` 会回报板卡型号/系统、
   `bpu_toolchain=present/missing`（`hbdk-sim` + `hbrtmlin`/`hbrt-tv` 的存在性）等信息；
3. 发布闸门要求运行的 `artifact.deployable === true` 且带 sha256 —— **现在这两条都能满足了**
   （见上面的门禁输出），所以这一步的阻塞点已经从"制品不可部署"变成"板子不在网"。

板端真机跑的验收（50 Hz 单线程控制延迟、摔倒/重启恢复）不在本适配器范围内，属于平台部署页与
`docs/actuator-drive.md` 的范畴。

## 复现与证据

`*.bin` / `*.hbm` 与校准样本已加进 `.gitignore`（构建产物，不进仓库）。本目录的
`evidence/compile-gate-result.json` 是平台门禁的原始输出，用于对照：

```json
{"ok": true, "status": "completed", "target": "x5", "format": "bin", "deployable": true,
 "artifact": {"artifactRef": "artifact://compiled/x5/policy-x5.bin",
              "sha256": "57ac460ca05a2c1dbbff0f2e424bfe131e54b09fbb09393f1883b621ef43e72c",
              "sizeBytes": 460879}}
```

复现命令就是上面的"接平台编译门禁"一节；同一 checkpoint + 同一校准集应得到同一 sha256。
