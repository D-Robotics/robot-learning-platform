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
node_path="$root/mcp/runtime/node"
runtime="$root/mcp/runtime/provenance.json"
expected="$(/usr/bin/plutil -extract binarySha256 raw -o - "$runtime")"
[[ "$expected" =~ ^[a-f0-9]{64}$ ]] && [ -f "$node_path" ] && [ ! -L "$node_path" ]
actual="$(/usr/bin/shasum -a 256 "$node_path" | /usr/bin/awk '{print $1}')"
if [ "$actual" != "$expected" ]; then printf 'Node 文件校验失败。请重新解压官方安装包。\n' >&2; exit 1; fi
"$node_path" "$root/setup-studio.mjs" "$@"
