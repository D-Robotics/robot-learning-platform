#!/bin/bash
set -euo pipefail
umask 077
export LC_ALL=C
root="$(cd "$(dirname "$0")" && pwd)"
temp=""
finish() {
  result=$?
  if [ -n "$temp" ] && [ -d "$temp" ]; then rm -rf "$temp"; fi
  if [ "$result" -ne 0 ]; then printf '\n安装未完成，请查看上方原因；你的登录状态未改变。\n'; fi
  if [ -t 0 ]; then printf '\n按回车关闭窗口。 '; IFS= read -r answer || true; fi
}
trap finish EXIT
compatible() {
  "$1" -e 'const v=process.versions.node.match(/\d+/g).map(Number);process.exit((v[0]===22&&(v[1]>22||(v[1]===22&&v[2]>=2)))||(v[0]===24&&v[1]>=15)||v[0]>=26?0:1)' >/dev/null 2>&1
}
node_path="$(command -v node || true)"
if [ -z "$node_path" ] || ! compatible "$node_path"; then
  case "$(uname -m)" in arm64) target="darwin-arm64";; x86_64) target="darwin-x64";; *) printf '暂不支持这台 Mac 的处理器架构。\n' >&2; exit 1;; esac
  manifest="$root/runtime-downloads.json"
  version="$(/usr/bin/plutil -extract version raw -o - "$manifest")"
  url="$(/usr/bin/plutil -extract "targets.$target.url" raw -o - "$manifest")"
  expected="$(/usr/bin/plutil -extract "targets.$target.sha256" raw -o - "$manifest")"
  folder="$(/usr/bin/plutil -extract "targets.$target.folder" raw -o - "$manifest")"
  case "$url" in https://nodejs.org/dist/*) ;; *) printf '运行环境下载来源不符合要求，已停止。\n' >&2; exit 1;; esac
  [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || { printf '运行环境校验信息无效，已停止。\n' >&2; exit 1; }
  cache="${RDK_PLUGIN_RUNTIME_CACHE:-$HOME/.config/rdk-robot-learning-platform/runtimes}/v$version/$target"
  node_path="$cache/$folder/bin/node"
  if [ ! -x "$node_path" ] || ! compatible "$node_path"; then
    mkdir -p "$cache"
    available_kib="$(/bin/df -Pk "$cache" | /usr/bin/awk 'NR==2 {print $4}')"
    case "$available_kib" in ''|*[!0-9]*) printf '无法确认磁盘可用空间，未开始下载。\n' >&2; exit 1;; esac
    [ "$available_kib" -ge 262144 ] || { printf '磁盘空间不足：首次准备运行环境至少需要256MB可用空间。请释放空间后重试；未开始下载，登录状态未改变。\n' >&2; exit 1; }
    temp="$(mktemp -d "$cache/.download.XXXXXX")"
    printf '正在为此 Mac 准备经过校验的 Node.js %s…\n' "$version"
    downloaded=false
    for attempt in 1 2 3; do
      if /usr/bin/curl --fail --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 --continue-at - "$url" -o "$temp/node.tar.gz"; then
        downloaded=true
        break
      fi
      if [ "$attempt" -lt 3 ]; then printf '下载中断，保留已下载部分继续尝试（最多3次）。\n'; fi
    done
    [ "$downloaded" = true ] || { printf '运行环境下载未完成，请检查网络后重新运行安装器。\n' >&2; exit 1; }
    actual="$(/usr/bin/shasum -a 256 "$temp/node.tar.gz" | /usr/bin/awk '{print $1}')"
    [ "$actual" = "$expected" ] || { printf '运行环境下载校验不一致，已停止安装。\n' >&2; exit 1; }
    /usr/bin/tar -xzf "$temp/node.tar.gz" -C "$temp"
    [ ! -e "$cache/$folder" ] || { printf '已有运行环境无效，请检查个人缓存后重试。\n' >&2; exit 1; }
    mv "$temp/$folder" "$cache/$folder"
  fi
fi
"$node_path" "$root/setup.mjs" "$@"
