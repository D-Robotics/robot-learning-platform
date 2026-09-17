#!/bin/bash
# RDK_BPU_COMPILER adapter: platform contract -> vendor hb_mapper.
#
# `scripts/compile-policy.mjs` invokes a compiler as
#     <compiler> --input <model.onnx> --output <model.bin>
# while the vendor toolchain is configured through a YAML file and has no
# command-line input/output flags. This wrapper bridges the two and is the only
# place that knows about the vendor's flag shape.
#
# Required environment (set by the operator, not baked in):
#   RDK_BPU_OE_ROOTFS   absolute path of the OE toolchain root filesystem
#                       (an unpacked `docker_openexplorer_ubuntu_20_x5_cpu` image,
#                        or a host install whose /usr/local/bin/hb_mapper works)
# Optional:
#   RDK_BPU_CALIB_DIR   directory of calibration samples (raw float32, one file
#                       per sample, element count == input_shape). Defaults to
#                       <input dir>/calib_raw.
#   RDK_BPU_SAMPLES     how many calibration files to stage (default 200).
#   RDK_BPU_MARCH       BPU architecture (default bayes-e for RDK X5).
#   RDK_BPU_WORKDIR     scratch directory (default a mktemp -d).
#
# Exit codes: 0 on a produced .bin, 2 on any refusal — the platform treats a
# non-zero exit as `bpu-compile-failed` and never marks the source ONNX
# deployable, which is exactly the intended fail-closed behaviour.

set -euo pipefail

INPUT=""
OUTPUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --input) INPUT="${2:-}"; shift 2 ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    *) echo "rdk-bpu-compile: unexpected argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$INPUT" ] || [ -z "$OUTPUT" ]; then
  echo "rdk-bpu-compile: --input and --output are required" >&2
  exit 2
fi
if [ ! -f "$INPUT" ]; then
  echo "rdk-bpu-compile: input not found: $INPUT" >&2
  exit 2
fi

ROOTFS="${RDK_BPU_OE_ROOTFS:-}"
if [ -z "$ROOTFS" ]; then
  echo "rdk-bpu-compile: RDK_BPU_OE_ROOTFS is not set (absolute path to the OE toolchain rootfs)" >&2
  exit 2
fi
ROOTFS="${ROOTFS%/}"

RUNNER=""
if [ -x "$ROOTFS/usr/local/bin/hb_mapper" ] && [ -x "$ROOTFS/bin/bash" ]; then
  RUNNER="chroot"          # unpacked image rootfs
elif command -v hb_mapper >/dev/null 2>&1; then
  RUNNER="host"            # toolchain installed on this host
else
  echo "rdk-bpu-compile: no usable hb_mapper (looked in $ROOTFS/usr/local/bin and PATH)" >&2
  exit 2
fi

WORKDIR="${RDK_BPU_WORKDIR:-$(mktemp -d)}"
mkdir -p "$WORKDIR"
MARCH="${RDK_BPU_MARCH:-bayes-e}"
SAMPLES="${RDK_BPU_SAMPLES:-200}"
CALIB_SRC="${RDK_BPU_CALIB_DIR:-$(dirname "$INPUT")/calib_raw}"

# --- opset guard ---------------------------------------------------------------
# The vendor front end refuses anything above opset 11:
#   ERROR ... {horizon_nn.build_onnx} ... The opset version of the model is 18,
#   the maximum supported version is 11.
# `onnx.version_converter` cannot downgrade this graph (no adapter for Sub from
# v14), so the only correct fix is a re-export at opset 11. When the upstream
# stack is present this wrapper does that automatically and says so; otherwise it
# refuses with an actionable message instead of letting hb_mapper fail deep.
OPSET=""
if command -v python3 >/dev/null 2>&1; then
  OPSET="$(python3 - "$INPUT" <<'PY' 2>/dev/null || true
import sys

# Minimal protobuf reader: read ModelProto.opset_import (field 8, repeated
# OperatorSetIdProto with .version = field 2). Pure stdlib on purpose — the
# worker host has no `onnx` package, and an empty answer here would silently
# skip the opset-11 re-export and fail deep inside hb_mapper instead.


def read_varint(data, pos):
    result = 0
    shift = 0
    while True:
        byte = data[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, pos
        shift += 7


def fields(data):
    pos = 0
    while pos < len(data):
        key, pos = read_varint(data, pos)
        field, wire = key >> 3, key & 7
        if wire == 0:
            value, pos = read_varint(data, pos)
            yield field, wire, value
        elif wire == 2:
            length, pos = read_varint(data, pos)
            yield field, wire, data[pos : pos + length]
            pos += length
        elif wire == 5:
            pos += 4
        elif wire == 1:
            pos += 8
        else:
            return


try:
    with open(sys.argv[1], "rb") as handle:
        raw = handle.read()
    versions = []
    for field, wire, value in fields(raw):
        if field == 8 and wire == 2:
            for version_field, version_wire, version_value in fields(value):
                if version_field == 2 and version_wire == 0:
                    versions.append(version_value)
    print(max(versions) if versions else "")
except Exception:
    print("")
PY
)"
fi
if [ -n "$OPSET" ] && [ "$OPSET" -gt 11 ] 2>/dev/null; then
  CKPT="${RDK_BPU_CHECKPOINT:-}"
  EXPORTER="${RDK_BPU_EXPORT_SCRIPT:-$(cd "$(dirname "$0")" && pwd)/export_opset11.py}"
  REPO="${RDK_MICRODUCK_RL_DIR:-$HOME/microduck_rl}"
  TASK="${RDK_BPU_TASK_ID:-Mjlab-Velocity-Flat-MicroDuck}"
  if [ -n "$CKPT" ] && [ -x "$REPO/.venv/bin/python" ] && [ -f "$EXPORTER" ]; then
    echo "rdk-bpu-compile: input is opset $OPSET; re-exporting at opset 11 from $CKPT" >&2
    # A non-interactive SSH session has a minimal PATH; uv usually lives in
    # ~/.local/bin, so make it findable instead of failing the whole compile.
    export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
    UV_BIN="$(command -v uv || true)"
    [ -n "$UV_BIN" ] || {
      echo "rdk-bpu-compile: uv not found in PATH ($PATH)" >&2
      exit 2
    }
    (cd "$REPO" && "$UV_BIN" run python "$EXPORTER" "$TASK" --checkpoint-file "$CKPT" --onnx-file "$WORKDIR/model_opset11.onnx") \
      > "$WORKDIR/export11.log" 2>&1 || {
        echo "rdk-bpu-compile: opset-11 re-export failed; tail:" >&2
        tail -n 15 "$WORKDIR/export11.log" >&2
        exit 2
      }
    INPUT="$WORKDIR/model_opset11.onnx"
  else
    echo "rdk-bpu-compile: input ONNX is opset $OPSET but the toolchain supports at most 11." >&2
    echo "  Re-export from the checkpoint first:" >&2
    echo "    uv run python $EXPORTER $TASK --checkpoint-file <model_*.pt> --onnx-file <out.onnx>" >&2
    echo "  (or set RDK_BPU_CHECKPOINT to let this wrapper do it)" >&2
    exit 2
  fi
fi

if [ ! -d "$CALIB_SRC" ]; then
  echo "rdk-bpu-compile: calibration directory not found: $CALIB_SRC" >&2
  echo "  generate it with engines/microduck-rl-adapter/x5/make-calib-raw.py (raw float32 per sample)" >&2
  exit 2
fi

# --- inside-rootfs working copy ------------------------------------------------
# The vendor tool writes next to its config, and a chroot cannot see the host
# paths, so the model + a bounded calibration subset are staged inside.
if [ "$RUNNER" = "chroot" ]; then
  INNER="$ROOTFS/rdk-bpu-work"
  rm -rf "$INNER"
  mkdir -p "$INNER/calib"
  cp "$INPUT" "$INNER/model.onnx"
  count=0
  for sample in "$CALIB_SRC"/*; do
    [ -f "$sample" ] || continue
    cp "$sample" "$INNER/calib/"
    count=$((count + 1))
    [ "$count" -ge "$SAMPLES" ] && break
  done
  if [ "$count" -eq 0 ]; then
    echo "rdk-bpu-compile: no calibration samples in $CALIB_SRC" >&2
    exit 2
  fi
  cat > "$INNER/convert.yaml" <<YAML
model_parameters:
  onnx_model: "/rdk-bpu-work/model.onnx"
  march: "$MARCH"
  output_model_file_prefix: "policy"
  working_dir: "/rdk-bpu-work/workspace"
  layer_out_dump: false
input_parameters:
  input_name: "obs"
  input_type_rt: "featuremap"
  input_layout_rt: "NCHW"
  input_type_train: "featuremap"
  input_layout_train: "NCHW"
  input_shape: "1x61"
  norm_type: "no_preprocess"
calibration_parameters:
  cal_data_dir: "/rdk-bpu-work/calib"
  cal_data_type: "float32"
  calibration_type: "default"
compiler_parameters:
  compile_mode: "latency"
  optimize_level: "O3"
  debug: false
YAML
  mkdir -p "$ROOTFS/dev"
  [ -e "$ROOTFS/dev/null" ] || mknod "$ROOTFS/dev/null" c 1 3
  [ -e "$ROOTFS/dev/urandom" ] || mknod "$ROOTFS/dev/urandom" c 1 9
  chmod 666 "$ROOTFS/dev/null" "$ROOTFS/dev/urandom" 2>/dev/null || true
  chroot "$ROOTFS" /bin/bash -lc \
    "cd /rdk-bpu-work && hb_mapper makertbin --config convert.yaml --model-type onnx" \
    > "$WORKDIR/hb_mapper.log" 2>&1 || {
      echo "rdk-bpu-compile: hb_mapper failed; last lines:" >&2
      tail -n 20 "$WORKDIR/hb_mapper.log" >&2
      exit 2
    }
  BIN="$(find "$INNER/workspace" -maxdepth 1 -name '*.bin' -print -quit)"
else
  cp "$INPUT" "$WORKDIR/model.onnx"
  mkdir -p "$WORKDIR/calib"
  count=0
  for sample in "$CALIB_SRC"/*; do
    [ -f "$sample" ] || continue
    cp "$sample" "$WORKDIR/calib/"
    count=$((count + 1))
    [ "$count" -ge "$SAMPLES" ] && break
  done
  sed -e "s#/rdk-bpu-work#$WORKDIR#g" \
      -e "s#march: \".*\"#march: \"$MARCH\"#" \
      -e "s#input_shape: \".*\"#input_shape: \"1x61\"#" \
      "$(dirname "$0")/convert.yaml" > "$WORKDIR/convert.yaml"
  (cd "$WORKDIR" && hb_mapper makertbin --config convert.yaml --model-type onnx) \
    > "$WORKDIR/hb_mapper.log" 2>&1 || {
      echo "rdk-bpu-compile: hb_mapper failed; last lines:" >&2
      tail -n 20 "$WORKDIR/hb_mapper.log" >&2
      exit 2
    }
  BIN="$(find "$WORKDIR/workspace" -maxdepth 1 -name '*.bin' -print -quit)"
fi

if [ -z "$BIN" ] || [ ! -s "$BIN" ]; then
  echo "rdk-bpu-compile: hb_mapper reported success but produced no .bin" >&2
  exit 2
fi

mkdir -p "$(dirname "$OUTPUT")"
cp "$BIN" "$OUTPUT"
echo "rdk-bpu-compile: wrote $OUTPUT ($(stat -c %s "$OUTPUT") bytes, march=$MARCH, calib=$count samples)"
