#!/usr/bin/env bash
# 一键部署学习平台到生产服务器（47.110.142.255）。
#
# 背景：2026-09-22 前的手工部署曾漏掉 release 根级的 mock-local-worker.mjs
# 且未重启 worker 服务——问题潜伏到下一次重启才爆发。本脚本把部署固化为
# 不可跳过的机器步骤：构建 → 组包 → 上传 → 服务端解压（继承 Linux engines
# 依赖环境，再覆盖本次干净引擎源码）→ **按 systemd ExecStart 逐一校验新
# release 的入口文件** → 切软链 → 重启服务 → 健康检查，失败自动回滚。
# 已安装的真实 CPU worker 自动纳入同一预检、重启与回滚事务。
#
# 用法：
#   scripts/deploy-sim2real-production.sh                # 完整部署
#   scripts/deploy-sim2real-production.sh --skip-build   # 复用已有 dist-server
#   DEPLOY_HOST=user@other-host scripts/...              # 覆盖目标主机
#   DEPLOY_NODE_BIN=/opt/node-v24/bin/node scripts/...   # 服务端 Node 运行时
#   DEPLOY_NPM_CLI=/opt/node-v24/lib/node_modules/npm/bin/npm-cli.js scripts/...
set -euo pipefail

HOST="${DEPLOY_HOST:-root@47.110.142.255}"
BASE=/opt/sim2real-web
NODE_BIN="${DEPLOY_NODE_BIN:-/opt/node-v22.16.0-linux-x64/bin/node}"
NPM_CLI="${DEPLOY_NPM_CLI:-}"
WEB_UNIT=sim2real-web.service
WORKER_UNIT=sim2real-mock-worker.service
CPU_WORKER_UNIT=sim2real-cpu-worker.service
remote_bash() {
  # ssh 会把 argv 拼成远端 shell 命令；显式转义每个参数才能保持边界。
  local remote_command='bash -s' argument escaped
  for argument in "$@"; do
    printf -v escaped '%q' "$argument"
    remote_command+=" $escaped"
  done
  ssh -o BatchMode=yes "$HOST" "$remote_command"
}
SKIP_BUILD=0
[[ "${1:-}" == "--skip-build" ]] && SKIP_BUILD=1

# 同一 SHA 的并发部署会互撞：tarball 用固定名 /tmp/release-$SHA.tar.gz，
# release 目录也是固定名，两跑会互相删对方的解压产物（真实发生过：engines
# venv 拷贝被打断，current 切换后血脉缺失）。按目标主机串行化整个部署。
# flock（coreutils）进程退出自动释放；macOS 无 flock 时退化为 mkdir 原子锁
# + PID 存活探测，避免崩溃残留死锁。
LOCK_KEY=$(printf '%s' "$HOST" | tr -c 'A-Za-z0-9' '_')
LOCK_DIR="/tmp/sim2real-deploy.$LOCK_KEY.lock"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_DIR.flock"
  if ! flock -n 9; then
    echo "!! 已有同目标主机（$HOST）的部署在运行；并发部署会互撞同一 release 名与 tarball。" >&2
    exit 1
  fi
else
  release_lock() {
    # 只删除本进程持有的 PID 文件；否则 rmdir 会因目录非空留下死锁。
    if [ "$(cat "$LOCK_DIR/pid" 2>/dev/null || true)" = "$$" ]; then
      rm -f "$LOCK_DIR/pid"
      rmdir "$LOCK_DIR" 2>/dev/null || true
    fi
  }
  take_lock() {
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      echo $$ >"$LOCK_DIR/pid"
      trap release_lock EXIT
      return 0
    fi
    return 1
  }
  if take_lock; then
    : # 持锁成功
  else
    lock_pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
    # ps -p 对其他用户的活进程也能看到；kill -0 会因 EPERM 把活锁误判为死锁。
    if [ -n "$lock_pid" ] && ! ps -p "$lock_pid" >/dev/null 2>&1; then
      echo "清理残留部署锁（持锁 pid $lock_pid 已不存在）" >&2
      # 原子改名接管：两个等待者同时到达时 rename 只有一方成功，另一方
      # 回到 mkdir 竞争，任何时刻都不可能出现双持锁（rm -rf+mkdir 会删掉
      # 对方刚建好的新锁，正是要避免的 TOCTOU 双跑）。
      STALE="$LOCK_DIR.stale.$$.$RANDOM"
      if mv "$LOCK_DIR" "$STALE" 2>/dev/null && take_lock; then
        echo "已接管残留锁（旧锁留存于 $STALE），继续部署。" >&2
      else
        echo "!! 残留锁接管竞争失败：其他进程已先行持锁（$LOCK_DIR）。" >&2
        exit 1
      fi
    else
      echo "!! 已有同目标主机（$HOST）的部署在运行（锁：$LOCK_DIR）；确认无在途部署后清理该目录重试。" >&2
      exit 1
    fi
  fi
fi

cd "$(dirname "$0")/.."
SHA=$(git rev-parse --short HEAD)
RELEASE="robot-learning-$(date +%Y%m%d)-$SHA"
STAGING=$(mktemp -d)/$RELEASE

echo "== [1/7] 构建 ($SHA) =="
if [ "$SKIP_BUILD" -eq 0 ]; then npm run build; fi

echo "== [2/7] 组包 =="
mkdir -p "$STAGING"
cp -R dist-server "$STAGING/dist-server"
pack_engine_sources() {
  local source_dir=$1 archive=$2
  [ -d "$source_dir" ] || { echo "FATAL: built engines source directory is missing" >&2; return 1; }
  # 构建源码单独组包，显式剔除本机环境、缓存及训练产物。根级公共模块
  # （例如 imitation_input.py）与各引擎脚本/配置都在此包内。
  COPYFILE_DISABLE=1 tar czf "$archive" -C "$source_dir" \
    --exclude='.venv' --exclude='venv' --exclude='site-packages' \
    --exclude='__pycache__' --exclude='.pytest_cache' --exclude='.git' \
    --exclude='node_modules' --exclude='._*' --exclude='.DS_Store' \
    --exclude='.env' --exclude='.env.*' \
    --exclude='artifacts' --exclude='checkpoints' --exclude='outputs' \
    --exclude='runs' --exclude='logs' --exclude='tensorboard' --exclude='evidence' \
    --exclude='calib_raw' --exclude='workspace' \
    --exclude='*.pyc' --exclude='*.pyo' --exclude='*.onnx' --exclude='*.pt' \
    --exclude='*.pth' --exclude='*.ckpt' --exclude='*.pkl' --exclude='*.bin' \
    --exclude='*.safetensors' --exclude='*.gguf' \
    --exclude='*.hbm' --exclude='*.npy' --exclude='*.npz' --exclude='*.jsonl' \
    --exclude='*.log' --exclude='training-summary.json' --exclude='eval-report.json' \
    --exclude='evaluation.json' --exclude='export-manifest.json' \
    --exclude='policy.ts' --exclude='policy-cpu.ts' .
}
pack_engine_sources "$STAGING/dist-server/engines" "$STAGING/engine-source.tar.gz"
# 本地 engines 不作为依赖环境上传（含历史中断构建的 engines.*.tmp 残留）。
rm -rf "$STAGING/dist-server/engines" "$STAGING"/dist-server/engines.*.tmp
cp package.json package-lock.json "$STAGING/"
# node_modules 必须在目标 Linux 主机安装；Mac npm ci 会只安装 Darwin
# optional 原生依赖，Agent 首次持久化会话时才触发缺 Linux flock 的故障。
# 服务单元的入口文件（如 worker 的根级 mock-local-worker.mjs）来自构建
# 产物的 services/sim2real-web/，必须提升到 release 根目录。
for entry in "$STAGING"/dist-server/services/sim2real-web/*.mjs; do
  cp "$entry" "$STAGING/$(basename "$entry")"
done

echo "== [3/7] 打包上传 =="
# 固定名 + 预删除：macOS mktemp 对「尾部含 .tar.gz 后缀」的模板会按字面
# 文件名创建，第二次运行必然 File exists。
TARBALL="/tmp/release-$SHA.tar.gz"
rm -f "$TARBALL"
COPYFILE_DISABLE=1 tar czf "$TARBALL" --exclude='node_modules' -C "$(dirname "$STAGING")" "$RELEASE"
scp -o BatchMode=yes "$TARBALL" "$HOST:/tmp/$(basename "$TARBALL")"

echo "== [4/7] 服务端解压 + Linux 依赖安装/继承 + 新源码覆盖 + 原生模块自检 =="
remote_bash "$BASE" "$RELEASE" "$(basename "$TARBALL")" "$NODE_BIN" "$NPM_CLI" <<'REMOTE'
set -euo pipefail
BASE=$1; RELEASE=$2; TARBALL=$3; NODE_BIN=$4
NPM_CLI=${5:-"$(dirname "$NODE_BIN")/../lib/node_modules/npm/bin/npm-cli.js"}
REL=$BASE/releases/$RELEASE
if [ -d "$REL" ] && [ "$(readlink -f "$BASE/current" 2>/dev/null || true)" = "$(readlink -f "$REL" 2>/dev/null || true)" ]; then
  echo "FATAL: release is already current; refusing to replace the rollback target" >&2
  exit 1
fi
rm -rf "$REL" && mkdir -p "$REL"
# 包内含顶层 release 目录，strip 掉再解到目标路径。
tar xzf "/tmp/$TARBALL" -C "$REL" --strip-components=1 2>/dev/null
# Linux venv 只能由服务端历代继承；本次源码包不含这些环境目录。
# current 未必含 engines（历史断链/被剔 Release），因此从「最新含
# dist-server/engines 的 release」拷贝，而不是只盯 current。
SRC_ENGINES=""
if [ -d "$BASE/current/dist-server/engines" ]; then
  SRC_ENGINES="$BASE/current/dist-server/engines"
else
  SRC_ENGINES=$(ls -td "$BASE"/releases/*/dist-server/engines 2>/dev/null | sed -n '1p' || true)
fi
if [ -z "$SRC_ENGINES" ]; then
  echo "FATAL: no release carries dist-server/engines (venv lineage broken)" >&2
  exit 1
fi
cp -a "$SRC_ENGINES" "$REL/dist-server/engines"
[ -f "$REL/engine-source.tar.gz" ] || { echo "FATAL: engine source package is missing" >&2; exit 1; }
tar xzf "$REL/engine-source.tar.gz" -C "$REL/dist-server/engines" --no-same-owner
rm -f "$REL/engine-source.tar.gz"
[ -x "$NODE_BIN" ] && [ -f "$NPM_CLI" ] || { echo "FATAL: release Node/npm runtime is missing" >&2; exit 1; }
# 只重建待发布 release 的依赖，保留 current 的可回滚环境与原 lockfile。
# 使用该 Node 发行版的 npm CLI，child lifecycle scripts 也使用同一 Node。
rm -rf "$REL/node_modules"
INSTALL_LOG="$REL/.release-install.log"
(umask 077; : >"$INSTALL_LOG")
if ! PATH="$(dirname "$NODE_BIN"):$PATH" "$NODE_BIN" "$NPM_CLI" ci --omit=dev --include=optional --no-audit --no-fund --prefix "$REL" >"$INSTALL_LOG" 2>&1; then
  echo "FATAL: Linux production dependency installation failed (private release log retained)" >&2
  exit 1
fi
# import 不能验证按需加载的 native binding；实际持锁才会触发缺平台包/ABI
# 错误。探针只创建独立临时文件，不创建 Agent 会话或访问平台业务数据。
if ! (
  cd "$REL"
  "$NODE_BIN" --input-type=module <<'NATIVE'
import { mkdtempSync, openSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(join(process.cwd(), 'package.json'));
const { tryLockExclusive } = await import(pathToFileURL(require.resolve('@deepseek-ai/node-addon-system/flock')).href);
const probeDir = mkdtempSync(join(tmpdir(), 'sim2real-dsh-lock-'));
let fd;
try {
  fd = openSync(join(probeDir, 'probe.lock'), 'wx', 0o600);
  await tryLockExclusive(fd);
} finally {
  try { if (fd !== undefined) closeSync(fd); }
  finally { rmSync(probeDir, { recursive: true, force: true }); }
}
NATIVE
) >>"$INSTALL_LOG" 2>&1; then
  echo "FATAL: DSH native lock validation failed (private release log retained)" >&2
  exit 1
fi
rm -f "$INSTALL_LOG"
"$NODE_BIN" --check "$REL/dist-server/services/sim2real-web/server.js"
rm -f "/tmp/$TARBALL"
REMOTE

select_deploy_units() {
  local cpu_state
  if ! cpu_state=$(ssh -o BatchMode=yes "$HOST" systemctl show "$CPU_WORKER_UNIT" --property=LoadState --value); then
    echo "FATAL: optional CPU worker installation could not be checked" >&2
    return 1
  fi
  case "$cpu_state" in
    loaded) printf '%s %s %s\n' "$WEB_UNIT" "$WORKER_UNIT" "$CPU_WORKER_UNIT" ;;
    not-found) printf '%s %s\n' "$WEB_UNIT" "$WORKER_UNIT" ;;
    *) echo "FATAL: optional CPU worker unit has an invalid load state" >&2; return 1 ;;
  esac
}
deploy_unit_names=$(select_deploy_units)
read -r -a DEPLOY_UNITS <<< "$deploy_unit_names"
read_cpu_activation_state() {
  local cpu_state
  if ! cpu_state=$(ssh -o BatchMode=yes "$HOST" systemctl show "$CPU_WORKER_UNIT" --property=ActiveState --value); then
    echo "FATAL: CPU worker activation state could not be checked" >&2
    return 1
  fi
  case "$cpu_state" in
    active) printf '1\n' ;;
    inactive|failed) printf '0\n' ;;
    *) echo "FATAL: CPU worker activation state is not stable" >&2; return 1 ;;
  esac
}
CPU_WAS_ACTIVE=0
for unit in "${DEPLOY_UNITS[@]}"; do
  if [ "$unit" = "$CPU_WORKER_UNIT" ]; then
    CPU_WAS_ACTIVE=$(read_cpu_activation_state)
  fi
done

echo "== [5/7] 入口文件预检（按 systemd ExecStart 逐一核对）=="
remote_bash "$BASE" "$RELEASE" "${DEPLOY_UNITS[@]}" <<'REMOTE'
set -euo pipefail
BASE=$1; RELEASE=$2; shift 2; UNITS=("$@")
MISSING=0
for unit in "${UNITS[@]}"; do
  exec_start=$(systemctl cat "$unit" | sed -n 's/^ExecStart=//p' | head -1)
  # ExecStart 形如 "/opt/node.../node /opt/sim2real-web/current/<script> [args]"。
  # 在所有 token 中找经 current 软链的脚本路径（第一个 token 是 node 二进制，
  # 不能只取首 token，否则预检空转）。
  script=""
  for token in $exec_start; do
    case "$token" in
      "$BASE/current/"*) script=$token; break;;
    esac
  done
  [ -z "$script" ] && continue
  rel=${script#"$BASE/current/"}
  if [ ! -f "$BASE/releases/$RELEASE/$rel" ]; then
    echo "预检失败：$unit 的入口文件在新 release 中缺失：$rel" >&2
    MISSING=1
  fi
done
exit $MISSING
REMOTE
echo "入口文件预检通过。"

rollback() {
  echo "!! 部署验证失败，自动回滚到上一 release 并重启服务" >&2
  if ! remote_bash "$BASE" "$PREV_RELEASE" "$CPU_WAS_ACTIVE" "${DEPLOY_UNITS[@]}" <<'REMOTE'
set -euo pipefail
BASE=$1; PREV=$2; CPU_WAS_ACTIVE=$3; shift 3; UNITS=("$@")
ln -sfn "releases/$PREV" "$BASE/current"
for unit in "${UNITS[@]}"; do
  if [ "$unit" = sim2real-cpu-worker.service ] && [ "$CPU_WAS_ACTIVE" != 1 ]; then
    # 首次安装的 CPU worker 在旧 release 未必能启动，恢复其原先停用状态。
    systemctl stop "$unit"
  else
    systemctl restart "$unit"
  fi
done
sleep 5
for unit in "${UNITS[@]}"; do
  if [ "$unit" = sim2real-cpu-worker.service ] && [ "$CPU_WAS_ACTIVE" != 1 ]; then
    case "$(systemctl show "$unit" --property=ActiveState --value)" in
      inactive|failed) ;;
      *) echo "FATAL: CPU worker did not return to its stopped state" >&2; exit 1 ;;
    esac
  else
    systemctl is-active "$unit"
  fi
done
REMOTE
  then
    echo "!! 自动回滚未完成，请检查上一 release 和服务状态" >&2
    return 1
  fi
}

PREV_RELEASE=$(ssh -o BatchMode=yes "$HOST" "basename \$(readlink -f $BASE/current)")

echo "== [6/7] 切换软链 + 重启服务 =="
if ! remote_bash "$BASE" "$RELEASE" "${DEPLOY_UNITS[@]}" <<'REMOTE'
set -euo pipefail
BASE=$1; RELEASE=$2; shift 2; UNITS=("$@")
ln -sfn "releases/$RELEASE" "$BASE/current"
for unit in "${UNITS[@]}"; do systemctl restart "$unit"; done
sleep 6
for unit in "${UNITS[@]}"; do systemctl is-active "$unit"; done
REMOTE
then
  rollback || true
  exit 1
fi

echo "== [7/7] 健康检查（失败自动回滚）=="
if ! remote_bash "$NODE_BIN" "${DEPLOY_UNITS[@]}" <<'REMOTE'
set -euo pipefail
NODE_BIN=$1; shift; UNITS=("$@")
probe_cpu_worker() {
  local cpu_health_code cpu_health_body cpu_rejection
  cpu_health_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:19091/healthz)
  [ "$cpu_health_code" = "200" ] || { echo "CPU worker healthz=$cpu_health_code" >&2; return 1; }
  cpu_health_body=$(curl -fsS --max-time 8 http://127.0.0.1:19091/healthz)
  if ! printf '%s' "$cpu_health_body" | "$NODE_BIN" -e '
    try {
      const health = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      const ready = health.ok === true && health.configured === true &&
        health.mode === "external-engine" && Array.isArray(health.engines) && health.engines.length > 0;
      process.exit(ready ? 0 : 1);
    } catch { process.exit(1); }
  '; then
    echo "CPU worker is not a configured real engine" >&2
    return 1
  fi
  cpu_rejection=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -X POST \
    http://127.0.0.1:19091/train -H 'content-type: application/json' -d '{}')
  case "$cpu_rejection" in
    400|401|422) ;; # 无凭据请求可由认证层拒绝；不创建任何真实训练任务。
    *) echo "CPU worker 未按协议拒绝空请求：HTTP $cpu_rejection" >&2; return 1 ;;
  esac
  echo "CPU worker healthz=200 real-engine-ready rejected=$cpu_rejection"
}
for endpoint in healthz readyz metrics; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:18102/$endpoint")
  [ "$code" = "200" ] || { echo "$endpoint=$code" >&2; exit 1; }
done
worker_health=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:19090/healthz)
[ "$worker_health" = "200" ] || { echo "worker healthz=$worker_health" >&2; exit 1; }
worker=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -X POST \
  http://127.0.0.1:19090/train -H 'content-type: application/json' -d '{}')
case "$worker" in
  400|422) ;; # 空请求明确拒绝；不创建任何训练 Run。
  *) echo "worker 未按协议拒绝空请求：HTTP $worker" >&2; exit 1 ;;
esac
for unit in "${UNITS[@]}"; do
  case "$unit" in
    sim2real-cpu-worker.service) probe_cpu_worker ;;
  esac
done
echo "healthz=200 readyz=200 metrics=200 worker-healthz=$worker_health worker-rejected=$worker"
REMOTE
then
  rollback || true
  exit 1
fi

rm -f "$TARBALL"
echo "✅ 部署完成：$HOST $BASE/current -> releases/$RELEASE（上一版本 $PREV_RELEASE 保留，可随时切回）"
