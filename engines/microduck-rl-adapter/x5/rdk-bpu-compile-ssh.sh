#!/bin/bash
# SSH proxy for the BPU compiler: lets `scripts/compile-policy.mjs` run on a
# management host while the OE toolchain lives on the GPU box, without exposing
# the toolchain over the network.
#
# `compile-policy.mjs` calls: <compiler> --input <onnx> --output <bin>
# This forwards the exact same pair to engines/microduck-rl-adapter/x5/rdk-bpu-compile.sh
# on the remote host and copies the produced .bin back.
#
# Environment:
#   RDK_BPU_SSH_TARGET   user@host (required)
#   RDK_BPU_SSH_PORT     ssh port (default 22)
#   RDK_BPU_REMOTE_DIR   remote working directory (default /root/bpu-compile)
#   RDK_BPU_OE_ROOTFS    remote OE toolchain rootfs (required by the remote wrapper)
#   RDK_BPU_CALIB_DIR    remote calibration sample directory
#   RDK_BPU_SAMPLES      calibration sample count
set -euo pipefail

INPUT=""
OUTPUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --input) INPUT="${2:-}"; shift 2 ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    *) echo "rdk-bpu-compile-ssh: unexpected argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$INPUT" ] && [ -n "$OUTPUT" ] || {
  echo "rdk-bpu-compile-ssh: --input and --output are required" >&2
  exit 2
}
[ -f "$INPUT" ] || {
  echo "rdk-bpu-compile-ssh: input not found: $INPUT" >&2
  exit 2
}

TARGET="${RDK_BPU_SSH_TARGET:-}"
[ -n "$TARGET" ] || {
  echo "rdk-bpu-compile-ssh: RDK_BPU_SSH_TARGET is not set (user@host)" >&2
  exit 2
}
PORT="${RDK_BPU_SSH_PORT:-22}"
REMOTE_DIR="${RDK_BPU_REMOTE_DIR:-/root/bpu-compile}"
SSH=(ssh -p "$PORT" -o BatchMode=yes -o ConnectTimeout=15 "$TARGET")

STAMP="$(date +%s)-$$"
REMOTE_IN="$REMOTE_DIR/proxy-$STAMP.onnx"
REMOTE_OUT="$REMOTE_DIR/proxy-$STAMP.bin"

"${SSH[@]}" "cat > '$REMOTE_IN'" < "$INPUT"

"${SSH[@]}" "cd '$REMOTE_DIR' && RDK_BPU_OE_ROOTFS='${RDK_BPU_OE_ROOTFS:-}' \
  RDK_BPU_CALIB_DIR='${RDK_BPU_CALIB_DIR:-$REMOTE_DIR/calib_raw}' \
  RDK_BPU_SAMPLES='${RDK_BPU_SAMPLES:-200}' \
  RDK_BPU_CHECKPOINT='${RDK_BPU_CHECKPOINT:-}' \
  RDK_MICRODUCK_RL_DIR='${RDK_MICRODUCK_RL_DIR:-/root/microduck_rl}' \
  ./rdk-bpu-compile.sh --input '$REMOTE_IN' --output '$REMOTE_OUT'" || {
  echo "rdk-bpu-compile-ssh: remote compile failed" >&2
  "${SSH[@]}" "rm -f '$REMOTE_IN' '$REMOTE_OUT'" || true
  exit 2
}

mkdir -p "$(dirname "$OUTPUT")"
"${SSH[@]}" "cat '$REMOTE_OUT'" > "$OUTPUT"
"${SSH[@]}" "rm -f '$REMOTE_IN' '$REMOTE_OUT'" || true

[ -s "$OUTPUT" ] || {
  echo "rdk-bpu-compile-ssh: remote produced no bytes" >&2
  exit 2
}
echo "rdk-bpu-compile-ssh: wrote $OUTPUT ($(stat -c %s "$OUTPUT") bytes via $TARGET)"
