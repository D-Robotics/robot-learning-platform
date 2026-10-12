#!/usr/bin/env bash
# 一键部署学习平台到生产服务器（47.110.142.255）。
#
# 背景：2026-09-22 前的手工部署曾漏掉 release 根级的 mock-local-worker.mjs
# 且未重启 worker 服务——问题潜伏到下一次重启才爆发。本脚本把部署固化为
# 不可跳过的机器步骤：构建 → 组包（含补齐 linux/x64 原生可选依赖）→ 上传
# → 服务端解压（engines 由服务端历代拷贝，绝不用 Mac 构建覆盖）→ **按
# systemd ExecStart 逐一校验新 release 的入口文件** → 切软链 → 重启相关服务
# → 健康检查，失败自动回滚。
#
# 用法：
#   scripts/deploy-sim2real-production.sh                # 完整部署
#   scripts/deploy-sim2real-production.sh --skip-build   # 复用已有 dist-server
#   DEPLOY_HOST=user@other-host scripts/...              # 覆盖目标主机
#   DEPLOY_NODE_BIN=/absolute/path/to/node scripts/...   # 覆盖远端 Node
set -euo pipefail

HOST="${DEPLOY_HOST:-root@47.110.142.255}"
BASE=/opt/sim2real-web
WEB_UNIT=sim2real-web.service
WORKER_UNIT=sim2real-mock-worker.service
CPU_WORKER_UNIT=sim2real-cpu-worker.service
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
  take_lock() {
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      echo $$ >"$LOCK_DIR/pid"
      # The lock dir holds pid, so a bare rmdir would fail and a failing EXIT
      # trap overrides the script's exit status — a finished deploy would
      # report failure to whatever automation invoked it.
      trap 'rm -f "$LOCK_DIR/pid" 2>/dev/null; rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
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
if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  echo "!! 工作区含未提交或未跟踪文件；先提交已验收的发布候选，再部署。" >&2
  exit 1
fi
SHA=$(git rev-parse --short HEAD)
RELEASE="robot-learning-$(date +%Y%m%d)-$SHA"

# Release 不可覆盖。先检查目标，解压时再用 mkdir 原子拒绝竞争者。
# 只打印 Node 路径和 unit 名；不读取或输出 EnvironmentFile 的凭据。
DEPLOY_INFO=$(ssh -o BatchMode=yes "$HOST" bash -s "$BASE" "$RELEASE" "$WEB_UNIT" "$WORKER_UNIT" "$CPU_WORKER_UNIT" "${DEPLOY_NODE_BIN:-}" <<'REMOTE'
set -euo pipefail
BASE=$1; RELEASE=$2; WEB_UNIT=$3; WORKER_UNIT=$4; CPU_WORKER_UNIT=$5; NODE_BIN=${6:-}
REL=$BASE/releases/$RELEASE
if [ -e "$REL" ] || [ -L "$REL" ]; then
  echo "FATAL: release already exists; refusing to overwrite: $RELEASE" >&2
  exit 1
fi
if [ -z "$NODE_BIN" ]; then
  pid=$(systemctl show "$WEB_UNIT" -p MainPID --value)
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    NODE_BIN=$(readlink -f "/proc/$pid/exe")
  else
    NODE_BIN=$(systemctl show "$WEB_UNIT" -p ExecStart --value | sed -n 's/.*path=\([^ ;]*\).*/\1/p')
  fi
fi
if [[ "$NODE_BIN" != /* ]] || [[ "${NODE_BIN##*/}" != node && "${NODE_BIN##*/}" != nodejs ]]; then
  echo "FATAL: cannot resolve the web service Node executable; set DEPLOY_NODE_BIN" >&2
  exit 1
fi
[ -x "$NODE_BIN" ] || { echo "FATAL: remote Node executable is unavailable" >&2; exit 1; }
UNITS="$WEB_UNIT $WORKER_UNIT"
if [ "$(systemctl show "$CPU_WORKER_UNIT" -p LoadState --value)" != "not-found" ]; then
  UNITS="$UNITS $CPU_WORKER_UNIT"
fi
printf '%s\n%s\n' "$NODE_BIN" "$UNITS"
REMOTE
)
NODE_BIN=$(printf '%s\n' "$DEPLOY_INFO" | sed -n '1p')
UNITS=$(printf '%s\n' "$DEPLOY_INFO" | sed -n '2p')
[ -n "$NODE_BIN" ] && [ -n "$UNITS" ] || { echo "!! 发布目标预检结果不完整" >&2; exit 1; }
# Pass each controlled unit name separately: SSH serializes its command as
# shell text, so a quoted local string containing spaces is not one remote arg.
read -r -a DEPLOY_UNITS <<< "$UNITS"
STAGING=$(mktemp -d)/$RELEASE

echo "== [1/7] 构建 ($SHA) =="
if [ "$SKIP_BUILD" -eq 0 ]; then npm run build; fi

echo "== [2/7] 组包 =="
mkdir -p "$STAGING"
cp -R dist-server "$STAGING/dist-server"
# engines 的 Linux venv 只存在于服务器历代 release：本地构建一律剔除
# （含历史中断构建留下的 engines.*.tmp 残留）。
rm -rf "$STAGING/dist-server/engines" "$STAGING"/dist-server/engines.*.tmp
cp package.json package-lock.json "$STAGING/"
# macOS /var aliases /private/var: npm 11 treats a --prefix alias as a linked
# package absent from the lock. Install from the release's physical cwd instead;
# retain errors in deployment output when installation fails before publication.
(cd "$STAGING" && npm ci --omit=dev --no-audit --no-fund)
# mac 上的 npm ci 只装 darwin 平台变体；linux 运行时原生依赖（DSH flock、
# ripgrep、sharp）不补齐则生产端 require 直接失败（2026-10-10 事故）。
node scripts/reify-deployment-optional-deps.mjs --target "$STAGING"
# 服务单元的入口文件（如 worker 的根级 mock-local-worker.mjs）来自构建
# 产物的 services/sim2real-web/，必须提升到 release 根目录。
for entry in "$STAGING"/dist-server/services/sim2real-web/*.mjs; do
  cp "$entry" "$STAGING/$(basename "$entry")"
done

echo "== [3/7] 打包上传 =="
if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  echo "!! 构建期间工作区发生变化；停止发布，重新验收并提交候选。" >&2
  exit 1
fi
# 固定名 + 预删除：macOS mktemp 对「尾部含 .tar.gz 后缀」的模板会按字面
# 文件名创建，第二次运行必然 File exists。
TARBALL="/tmp/release-$SHA.tar.gz"
rm -f "$TARBALL"
tar czf "$TARBALL" -C "$(dirname "$STAGING")" "$RELEASE"
scp -o BatchMode=yes "$TARBALL" "$HOST:/tmp/$(basename "$TARBALL")"

echo "== [4/7] 服务端解压 + engines 拷贝 + 语法自检 =="
ssh -o BatchMode=yes "$HOST" bash -s "$BASE" "$RELEASE" "$(basename "$TARBALL")" "$NODE_BIN" <<'REMOTE'
set -euo pipefail
BASE=$1; RELEASE=$2; TARBALL=$3; NODE_BIN=$4
REL=$BASE/releases/$RELEASE
mkdir "$REL" || { echo "FATAL: release already exists; refusing to overwrite: $RELEASE" >&2; exit 1; }
# 包内含顶层 release 目录，strip 掉再解到目标路径。
tar xzf "/tmp/$TARBALL" -C "$REL" --strip-components=1 2>/dev/null
# engines 是 Linux venv，只能由服务端历代拷贝，绝不能被上传覆盖。
# current 未必含 engines（历史断链/被剔 Release），因此从「最新含
# dist-server/engines 的 release」拷贝，而不是只盯 current。
SRC_ENGINES=""
if [ -d "$BASE/current/dist-server/engines" ]; then
  SRC_ENGINES="$BASE/current/dist-server/engines"
else
  SRC_ENGINES=$(ls -td "$BASE"/releases/*/dist-server/engines 2>/dev/null | head -1)
fi
if [ -z "$SRC_ENGINES" ]; then
  echo "FATAL: no release carries dist-server/engines (venv lineage broken)" >&2
  exit 1
fi
cp -r "$SRC_ENGINES" "$REL/dist-server/engines"
"$NODE_BIN" --check "$REL/dist-server/services/sim2real-web/server.js"
rm -f "/tmp/$TARBALL"
REMOTE

echo "== [5/7] 入口文件预检（按 systemd ExecStart 逐一核对）=="
ssh -o BatchMode=yes "$HOST" bash -s "$BASE" "$RELEASE" "${DEPLOY_UNITS[@]}" <<'REMOTE'
set -euo pipefail
BASE=$1; RELEASE=$2; shift 2
MISSING=0
for unit in "$@"; do
  exec_start=$(systemctl show "$unit" -p ExecStart --value)
  # 使用已合并 drop-in 的 ExecStart，而非 systemctl cat 中可能已被覆盖的第一行。
  # 在所有 token 中找经 current 软链的脚本路径（第一个 token 是 node 二进制，
  # 不能只取首 token，否则预检空转）。
  script=""
  for token in $exec_start; do
    case "$token" in
      "$BASE/current/"*) script=$token; break;;
    esac
  done
  if [ -z "$script" ]; then
    echo "预检失败：$unit 的有效 ExecStart 没有 current 下的入口文件" >&2
    MISSING=1
    continue
  fi
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
  ssh -o BatchMode=yes "$HOST" bash -s "$BASE" "$PREV_RELEASE" "${DEPLOY_UNITS[@]}" <<'REMOTE'
set -euo pipefail
BASE=$1; PREV=$2; shift 2
ln -sfn "releases/$PREV" "$BASE/current"
for unit in "$@"; do systemctl restart "$unit"; done
sleep 5
for unit in "$@"; do systemctl is-active "$unit"; done
REMOTE
}

PREV_RELEASE=$(ssh -o BatchMode=yes "$HOST" "basename \$(readlink -f $BASE/current)")

echo "== [6/7] 切换软链 + 重启服务 =="
if ! ssh -o BatchMode=yes "$HOST" bash -s "$BASE" "$RELEASE" "${DEPLOY_UNITS[@]}" <<'REMOTE'
set -euo pipefail
BASE=$1; RELEASE=$2; shift 2
ln -sfn "releases/$RELEASE" "$BASE/current"
for unit in "$@"; do systemctl restart "$unit"; done
sleep 6
for unit in "$@"; do systemctl is-active "$unit"; done
REMOTE
then
  rollback
  exit 1
fi

echo "== [7/7] 健康检查（失败自动回滚）=="
if ! ssh -o BatchMode=yes "$HOST" bash -s "${DEPLOY_UNITS[@]}" <<'REMOTE'
set -euo pipefail
for endpoint in healthz readyz; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:18102/$endpoint")
  [ "$code" = "200" ] || { echo "$endpoint=$code" >&2; exit 1; }
  echo "$endpoint=$code"
done
for unit in "$@"; do
  case "$unit" in
    sim2real-mock-worker.service) port=19090;;
    sim2real-cpu-worker.service) port=19091;;
    *) continue;;
  esac
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:$port/healthz")
  [ "$code" = "200" ] || { echo "$unit healthz=$code" >&2; exit 1; }
  echo "$unit healthz=$code"
done
REMOTE
then
  rollback
  exit 1
fi

rm -f "$TARBALL"
echo "✅ 部署完成：$HOST $BASE/current -> releases/$RELEASE（上一版本 $PREV_RELEASE 保留，可随时切回）"
