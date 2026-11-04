#!/bin/bash
set -euo pipefail
umask 077
export LC_ALL=C
root="$(cd "$(dirname "$0")" && pwd)"
temp=""
finish() {
  result=$?
  if [ -n "$temp" ] && [ -d "$temp" ]; then rm -rf "$temp"; fi
  if [ "$result" -ne 0 ]; then printf '\nSetup failed. Read the message above; your sign-in was not changed.\n'; fi
  if [ -t 0 ]; then printf '\nPress Enter to close. '; IFS= read -r answer || true; fi
}
trap finish EXIT
compatible() {
  "$1" -e 'const v=process.versions.node.match(/\d+/g).map(Number);process.exit((v[0]===22&&(v[1]>22||(v[1]===22&&v[2]>=2)))||(v[0]===24&&v[1]>=15)||v[0]>=26?0:1)' >/dev/null 2>&1
}
node_path="$(command -v node || true)"
if [ -z "$node_path" ] || ! compatible "$node_path"; then
  case "$(uname -m)" in arm64) target="darwin-arm64";; x86_64) target="darwin-x64";; *) printf 'Unsupported Mac architecture.\n' >&2; exit 1;; esac
  manifest="$root/runtime-downloads.json"
  version="$(/usr/bin/plutil -extract version raw -o - "$manifest")"
  url="$(/usr/bin/plutil -extract "targets.$target.url" raw -o - "$manifest")"
  expected="$(/usr/bin/plutil -extract "targets.$target.sha256" raw -o - "$manifest")"
  folder="$(/usr/bin/plutil -extract "targets.$target.folder" raw -o - "$manifest")"
  case "$url" in https://nodejs.org/dist/*) ;; *) printf 'Invalid runtime download source.\n' >&2; exit 1;; esac
  [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || { printf 'Invalid runtime checksum.\n' >&2; exit 1; }
  cache="${RDK_PLUGIN_RUNTIME_CACHE:-$HOME/.config/rdk-robot-learning-platform/runtimes}/v$version/$target"
  node_path="$cache/$folder/bin/node"
  if [ ! -x "$node_path" ] || ! compatible "$node_path"; then
    mkdir -p "$cache"
    temp="$(mktemp -d "$cache/.download.XXXXXX")"
    printf 'Preparing verified Node.js %s for this Mac...\n' "$version"
    /usr/bin/curl --fail --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 "$url" -o "$temp/node.tar.gz"
    actual="$(/usr/bin/shasum -a 256 "$temp/node.tar.gz" | /usr/bin/awk '{print $1}')"
    [ "$actual" = "$expected" ] || { printf 'Runtime checksum mismatch; installation stopped.\n' >&2; exit 1; }
    /usr/bin/tar -xzf "$temp/node.tar.gz" -C "$temp"
    [ ! -e "$cache/$folder" ] || { printf 'Existing runtime is invalid; check the private cache before retrying.\n' >&2; exit 1; }
    mv "$temp/$folder" "$cache/$folder"
  fi
fi
"$node_path" "$root/setup.mjs"
