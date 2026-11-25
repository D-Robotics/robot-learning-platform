#!/bin/bash
set -euo pipefail
umask 077
export LC_ALL=C
finish() {
  result=$?
  if [ "$result" -ne 0 ]; then printf '\n安装未完成，请查看上方提示。\n'; fi
  if [ -t 0 ]; then printf '\n按回车关闭窗口。 '; IFS= read -r answer || true; fi
}
trap finish EXIT
root="$(cd "$(dirname "$0")" && pwd)"
runtime="$root/mcp/runtime"
if [ ! -f "$runtime/provenance.json" ]; then
  if [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
    runtime="$runtime/darwin-arm64"
  else
    case "$(/usr/bin/uname -m)" in
      arm64) runtime="$runtime/darwin-arm64" ;;
      x86_64) runtime="$runtime/darwin-x64" ;;
      *) printf '此安装包需要 64 位 macOS。\n' >&2; exit 1 ;;
    esac
  fi
fi
node_path="$runtime/node"
expected="$(/usr/bin/plutil -extract binarySha256 raw -o - "$runtime/provenance.json")"
if ! [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || [ ! -f "$node_path" ] || [ -L "$node_path" ] ||
  [ "$(/usr/bin/shasum -a 256 "$node_path" | /usr/bin/awk '{print $1}')" != "$expected" ]; then
  printf 'Node 文件校验失败。请重新解压官方安装包。\n' >&2
  exit 1
fi
"$node_path" "$root/setup-studio.mjs" "$@"
