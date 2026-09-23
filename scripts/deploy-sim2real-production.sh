#!/usr/bin/env bash
# 一键部署学习平台到生产服务器（47.110.142.255）。
#
# 背景：2026-09-22 前的手工部署曾漏掉 release 根级的 mock-local-worker.mjs
# 且未重启 worker 服务——问题潜伏到下一次重启才爆发。本脚本把部署固化为
# 不可跳过的机器步骤：构建 → 组包 → 上传 → 服务端解压（engines 由服务端
# 历代拷贝，绝不用 Mac 构建覆盖）→ **按 systemd ExecStart 逐一校验新
# release 的入口文件** → 切软链 → 重启双服务 → 健康检查，失败自动回滚。
#
# 用法：
#   scripts/deploy-sim2real-production.sh                # 完整部署
#   scripts/deploy-sim2real-production.sh --skip-build   # 复用已有 dist-server
#   DEPLOY_HOST=user@other-host scripts/...              # 覆盖目标主机
set -euo pipefail

HOST="${DEPLOY_HOST:-root@47.110.142.255}"
BASE=/opt/sim2real-web
NODE_BIN=/opt/node-v22.16.0-linux-x64/bin/node
WEB_UNIT=sim2real-web.service
WORKER_UNIT=sim2real-mock-worker.service
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
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ >"$LOCK_DIR/pid"
    trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT
  else
    lock_pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
    if [ -n "$lock_pid" ] && ! kill -0 "$lock_pid" 2>/dev/null; then
      echo "清理残留部署锁（持锁 pid $lock_pid 已不存在）" >&2
      rm -rf "$LOCK_DIR"
      if mkdir "$LOCK_DIR" 2>/dev/null; then
        echo $$ >"$LOCK_DIR/pid"
        trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT
      else
        echo "!! 部署锁 $LOCK_DIR 清理失败，请人工确认后删除重试。" >&2
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
# engines 的 Linux venv 只存在于服务器历代 release：本地构建一律剔除
# （含历史中断构建留下的 engines.*.tmp 残留）。
rm -rf "$STAGING/dist-server/engines" "$STAGING"/dist-server/engines.*.tmp
cp package.json package-lock.json "$STAGING/"
npm ci --omit=dev --no-audit --no-fund --prefix "$STAGING" >/dev/null 2>&1
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
tar czf "$TARBALL" -C "$(dirname "$STAGING")" "$RELEASE"
scp -o BatchMode=yes "$TARBALL" "$HOST:/tmp/$(basename "$TARBALL")"

echo "== [4/7] 服务端解压 + engines 拷贝 + 语法自检 =="
ssh -o BatchMode=yes "$HOST" bash -s "$BASE" "$RELEASE" "$(basename "$TARBALL")" "$NODE_BIN" <<'REMOTE'
set -euo pipefail
BASE=$1; RELEASE=$2; TARBALL=$3; NODE_BIN=$4
REL=$BASE/releases/$RELEASE
rm -rf "$REL" && mkdir -p "$REL"
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
ssh -o BatchMode=yes "$HOST" bash -s "$BASE" "$RELEASE" "$WEB_UNIT $WORKER_UNIT" <<'REMOTE'
set -euo pipefail
BASE=$1; RELEASE=$2; UNITS=$3
MISSING=0
for unit in $UNITS; do
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
  ssh -o BatchMode=yes "$HOST" bash -s "$BASE" "$PREV_RELEASE" "$WEB_UNIT $WORKER_UNIT" <<'REMOTE'
set -euo pipefail
BASE=$1; PREV=$2; UNITS=$3
ln -sfn "releases/$PREV" "$BASE/current"
for unit in $UNITS; do systemctl restart "$unit"; done
sleep 5
for unit in $UNITS; do systemctl is-active "$unit"; done
REMOTE
}

PREV_RELEASE=$(ssh -o BatchMode=yes "$HOST" "basename \$(readlink -f $BASE/current)")

echo "== [6/7] 切换软链 + 重启服务 =="
ssh -o BatchMode=yes "$HOST" bash -s "$BASE" "$RELEASE" "$WEB_UNIT $WORKER_UNIT" <<'REMOTE'
set -euo pipefail
BASE=$1; RELEASE=$2; UNITS=$3
ln -sfn "releases/$RELEASE" "$BASE/current"
for unit in $UNITS; do systemctl restart "$unit"; done
sleep 6
for unit in $UNITS; do systemctl is-active "$unit"; done
REMOTE

echo "== [7/7] 健康检查（失败自动回滚）=="
if ! ssh -o BatchMode=yes "$HOST" bash -s <<'REMOTE'
set -euo pipefail
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:18102/healthz)
[ "$code" = "200" ] || { echo "healthz=$code" >&2; exit 1; }
worker=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -X POST \
  http://127.0.0.1:19090/train -H 'content-type: application/json' -d '{}')
[ "$worker" != "000" ] || { echo "worker 不可达" >&2; exit 1; }
echo "healthz=$code worker=$worker(400=正常拒绝=活着)"
REMOTE
then
  rollback
  exit 1
fi

rm -f "$TARBALL"
echo "✅ 部署完成：$HOST $BASE/current -> releases/$RELEASE（上一版本 $PREV_RELEASE 保留，可随时切回）"
