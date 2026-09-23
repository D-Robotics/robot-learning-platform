#!/usr/bin/env bash
set -euo pipefail

# Read-only preflight for a profile-driven RDK board (X5 reference family or
# the S100 contract profile).  Probes architecture, OS, TROS setup paths,
# onnxruntime, cameras and ROS topic presence over the operator's existing SSH
# path.  It never writes to the board and never commands motion.
#
# Evidence rule: a missing required topic (for example the S100 chassis
# imu/cmd_vel before a diff-drive chassis is attached) fails the preflight and
# the profile provenance stays mock:true.  A full pass produces the transcript
# that licenses flipping provenance to mock:false; record it next to the
# profile change.

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
target=${RDK_X5_SSH_TARGET:?set RDK_X5_SSH_TARGET to an SSH target such as root@board-host}
profile_name=${RDK_X5_PROFILE_NAME:-rdk-x5-originbot-real.json}
case "$profile_name" in
  rdk-x5-originbot-real.json|rdk-x5-microduck-leg.json|rdk-s100-generic-drive.json) ;;
  *)
    echo 'RDK_X5_PROFILE_NAME must be rdk-x5-originbot-real.json, rdk-x5-microduck-leg.json, or rdk-s100-generic-drive.json.' >&2
    exit 2
    ;;
esac
profile="$repo_root/profiles/$profile_name"
test -s "$profile" || { echo "missing profile: $profile" >&2; exit 2; }

case "$target" in
  ''|*[!A-Za-z0-9_.@:-]*|*@*@*)
    echo 'RDK_X5_SSH_TARGET must be a simple user@host SSH target.' >&2
    exit 2
    ;;
esac
case "$target" in
  *@*) ;;
  *)
    echo 'RDK_X5_SSH_TARGET must include user@host.' >&2
    exit 2
    ;;
esac

# Flatten the profile into charset-validated spec tokens.  Everything the
# remote body receives is limited to [A-Za-z0-9_./:-] so a tampered profile
# cannot become a shell fragment on the board.
spec_output=$(node -e '
const fs = require("fs");
const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const board = (p.board && typeof p.board === "object") ? p.board : {};
const ros = (p.ros && typeof p.ros === "object") ? p.ros : {};
const caps = Array.isArray(p.capabilities) ? p.capabilities : [];
console.log("PLATFORM\t" + String(board.platform || "unknown"));
for (const path of (Array.isArray(ros.setupPaths) ? ros.setupPaths : [])) {
  console.log("SETUP\t" + String(path));
}
for (const key of Object.keys(ros.topics || {})) {
  const t = ros.topics[key] || {};
  console.log("TOPIC\t" + String(t.name || "") + "\t" + (t.required ? "1" : "0"));
}
console.log("ONNX\t" + (caps.includes("cpu-onnx") ? "1" : "0"));
' "$profile")

platform=unknown
needs_onnx=0
setup_specs=""
topic_specs=""
while IFS=$'\t' read -r kind rest; do
  [ -n "$kind" ] || continue
  case "$kind" in
    PLATFORM)
      platform=$rest
      case "$platform" in
        *[!A-Za-z0-9_.-]*) echo "profile platform contains unsupported characters: $platform" >&2; exit 2 ;;
      esac
      ;;
    ONNX) needs_onnx=$rest ;;
    SETUP)
      path=$rest
      case "$path" in
        /*) ;;
        *) echo "profile setupPath must be absolute: $path" >&2; exit 2 ;;
      esac
      case "$path" in
        *[!A-Za-z0-9_./-]*) echo "profile setupPath contains unsupported characters: $path" >&2; exit 2 ;;
      esac
      setup_specs="$setup_specs,SETUP:$path"
      ;;
    TOPIC)
      name=${rest%%$'\t'*}
      req=${rest#*$'\t'}
      case "$name" in
        /*) ;;
        *) echo "profile topic name must be absolute: $name" >&2; exit 2 ;;
      esac
      case "$name" in
        *[!A-Za-z0-9_/.]*) echo "profile topic name contains unsupported characters: $name" >&2; exit 2 ;;
      esac
      topic_specs="$topic_specs,TOPIC:$name:$req"
      ;;
  esac
done <<<"$spec_output"

# Spec tokens are joined with commas, never spaces: ssh concatenates its
# command arguments with spaces and the remote shell re-splits them, so a
# space-joined list would arrive fragmented.  Token charsets above exclude
# commas, so the join is unambiguous.
echo "== RDK board preflight: $profile_name (platform $platform) =="

preflight_status=0
if ssh -o ConnectTimeout=10 "$target" /bin/bash -s -- "$platform" "$needs_onnx" "${setup_specs#,}" "${topic_specs#,}" <<'REMOTE'
set -u
platform=$1
needs_onnx=$2
setup_specs=${3//,/ }
topic_specs=${4//,/ }

fail=0
pass() { printf 'PASS    %s\n' "$*"; }
fail_item() { printf 'FAIL    %s\n' "$*"; fail=1; }
pending() { printf 'PENDING %s\n' "$*"; }

arch=$(uname -m)
if [ "$arch" = "aarch64" ]; then
  pass "arch is aarch64"
else
  fail_item "arch is $arch (expected aarch64)"
fi

pretty=$(. /etc/os-release 2>/dev/null; printf '%s' "${PRETTY_NAME:-unknown}")
if [ "$pretty" != "unknown" ]; then
  pass "os is $pretty"
else
  fail_item "os-release PRETTY_NAME unreadable"
fi

for arg in $setup_specs; do
  path=${arg#SETUP:}
  if [ -f "$path" ]; then
    pass "ros setup path $path"
  else
    fail_item "ros setup path missing: $path"
  fi
done

if [ "$needs_onnx" = "1" ]; then
  if ort=$(python3 -c 'import onnxruntime; print(onnxruntime.__version__)' 2>/dev/null); then
    pass "onnxruntime $ort"
  else
    fail_item "onnxruntime not importable by system python3 (policy runtime needs it)"
  fi
fi

camera_count=$(ls -1 /dev/video* 2>/dev/null | wc -l | tr -d ' ' || true)
if [ "$camera_count" -gt 0 ] 2>/dev/null; then
  pass "cameras detected: $(ls -1 /dev/video* 2>/dev/null | tr '\n' ' ')"
else
  pending "no /dev/video* device (camera tasks need a UVC camera)"
fi

if [ -n "$topic_specs" ]; then
  listing=$(
    set +u
    for arg in $setup_specs; do
      path=${arg#SETUP:}
      if [ -f "$path" ]; then . "$path" >/dev/null 2>&1 || true; fi
    done
    if command -v ros2 >/dev/null 2>&1; then
      timeout 20 ros2 topic list 2>/dev/null || true
    fi
  )
  if [ -z "$listing" ]; then
    fail_item "ros2 topic list empty or unavailable (ros daemon/nodes not up)"
  fi
  for arg in $topic_specs; do
    spec=${arg#TOPIC:}
    name=${spec%:*}
    req=${spec##*:}
    if printf '%s\n' "$listing" | grep -Fxq "$name"; then
      pass "topic $name present"
    elif [ "$req" = "1" ]; then
      fail_item "required topic $name not present"
    else
      pending "optional topic $name not present"
    fi
  done
fi

if [ "$fail" -ne 0 ]; then
  echo "PREFLIGHT=FAIL"
  exit 1
fi
echo "PREFLIGHT=PASS"
REMOTE
then
  echo "Preflight PASSED for $profile_name. Record this transcript with the profile; it is the evidence that licenses provenance mock:false."
else
  preflight_status=$?
  echo "Preflight FAILED for $profile_name. Required probes did not pass; keep provenance mock:true and attach this transcript to the gap."
fi
exit "$preflight_status"
