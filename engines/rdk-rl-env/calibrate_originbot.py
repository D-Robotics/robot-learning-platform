#!/usr/bin/env python3
"""Estimate OriginBot drive parameters from a timestamped telemetry JSONL.

The estimator is deliberately conservative: it never turns simulator or
imported fixtures into live calibration evidence.  A report becomes eligible
for deployment only when the samples are marked ``board-agent`` and contain
enough motion in both linear and angular channels.
"""
from __future__ import annotations

import argparse
import json
import math
import statistics
from pathlib import Path


def _number(value):
    return float(value) if isinstance(value, (int, float)) and math.isfinite(value) else None


def _pick(row, *paths):
    for path in paths:
        value = row
        for key in path:
            if not isinstance(value, dict):
                value = None
                break
            value = value.get(key)
        number = _number(value)
        if number is not None:
            return number
    return None


def load_rows(path: Path):
    rows = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"line {line_no} is not valid JSON: {exc}") from exc
        if not isinstance(payload, dict):
            continue
        # API/uploader exports use a record envelope with `source` and a
        # `samples[]` array. Expand it so a downloaded board-agent shard is
        # calibrated exactly like the local policy-runtime JSONL spool.
        sample_rows = payload.get("samples")
        if isinstance(sample_rows, list):
            inherited_source = payload.get("source")
            expanded = []
            for sample in sample_rows:
                if not isinstance(sample, dict):
                    continue
                item = dict(sample)
                if item.get("source") is None:
                    item["source"] = inherited_source
                expanded.append(item)
        else:
            expanded = [payload]
        for row in expanded:
            t = _pick(row, ("t",), ("time",), ("timestamp",))
            x = _pick(row, ("odom", "x"), ("telemetry", "odom", "x"), ("telemetry", "odom", "positionX"))
            y = _pick(row, ("odom", "y"), ("telemetry", "odom", "y"), ("telemetry", "odom", "positionY"))
            yaw = _pick(row, ("odom", "yaw"), ("telemetry", "odom", "yaw"), ("telemetry", "imu", "yaw"))
            # Prefer the physical command actually published by the board agent.
            # ``action`` is the policy head output and may be normalized or a
            # multi-joint vector, so treating it as m/s/rad/s biases calibration.
            linear = _pick(row, ("cmd_vel", "linear"), ("telemetry", "cmd_vel", "linear"), ("action", "linear"))
            angular = _pick(row, ("cmd_vel", "angular"), ("telemetry", "cmd_vel", "angular"), ("action", "angular"))
            # Legacy rows may contain only `action`; it is safe to use that
            # fallback only when the producer explicitly says the policy head
            # already emits physical twist units.  Normalized actions must be
            # projected with the adapter scale before they can calibrate a
            # motor gain, otherwise the estimate is off by 0.3/1.0.
            action_is_physical = str(row.get("actionOutput", "")).strip().lower() == "physical-twist"
            if row.get("cmd_vel") is None and action_is_physical and isinstance(row.get("action"), list) and len(row["action"]) >= 2:
                linear = _number(row["action"][0])
                angular = _number(row["action"][1])
            if t is None or x is None or y is None or yaw is None:
                continue
            rows.append({"t": t, "x": x, "y": y, "yaw": yaw, "linear": linear, "angular": angular, "source": row.get("source")})
    rows.sort(key=lambda item: item["t"])
    return rows


def _unwrap_delta(value):
    return (value + math.pi) % (2 * math.pi) - math.pi


def _slope(xs, ys):
    pairs = [(x, y) for x, y in zip(xs, ys) if x is not None and y is not None and abs(x) > 1e-5]
    if not pairs:
        return None
    return sum(x * y for x, y in pairs) / sum(x * x for x, _ in pairs)


def estimate(rows):
    if len(rows) < 5:
        raise ValueError("at least 5 valid odom samples are required")
    dts = [b["t"] - a["t"] for a, b in zip(rows, rows[1:]) if 1e-4 <= b["t"] - a["t"] <= 2]
    if not dts:
        raise ValueError("timestamps do not contain a usable sampling interval")
    linear_rates = []
    angular_rates = []
    command_linear = []
    command_angular = []
    for a, b in zip(rows, rows[1:]):
        dt = b["t"] - a["t"]
        if dt <= 0 or dt > 2:
            continue
        dx = b["x"] - a["x"]
        dy = b["y"] - a["y"]
        # Preserve forward/reverse sign by projecting displacement onto the
        # measured heading.  A magnitude-only speed makes reverse samples look
        # like positive commands and corrupts the least-squares gain.
        heading = a["yaw"]
        linear_rates.append((dx * math.cos(heading) + dy * math.sin(heading)) / dt)
        angular_rates.append(_unwrap_delta(b["yaw"] - a["yaw"]) / dt)
        command_linear.append(a["linear"])
        command_angular.append(a["angular"])
    linear_gain = _slope(command_linear, linear_rates)
    angular_gain = _slope(command_angular, angular_rates)
    sources = sorted({row["source"] for row in rows if row.get("source")})
    board_samples = sum(1 for row in rows if row.get("source") == "board-agent")
    ready = board_samples >= 30 and linear_gain is not None and angular_gain is not None
    if board_samples < 30:
        recommendation_reason = "需要至少 30 条 board-agent 真实运动样本"
    elif linear_gain is None or angular_gain is None:
        recommendation_reason = "需要同时包含直行和原地旋转的有效 cmd_vel 激励"
    else:
        recommendation_reason = "真实 board-agent 数据达到标定门槛"
    report = {
        "schemaVersion": 1,
        "robot": "originbot",
        "provenance": {"sources": sources, "sampleCount": len(rows), "boardAgentSamples": board_samples,
                        "kind": "real" if board_samples >= 30 else "synthetic-or-insufficient"},
        "sampling": {"medianDtSeconds": statistics.median(dts), "estimatedHz": 1 / statistics.median(dts)},
        "drive": {"linearGain": linear_gain, "angularGain": angular_gain,
                  "linearSpeedP95": _percentile(linear_rates, .95), "angularSpeedP95": _percentile(angular_rates, .95)},
        "recommendation": {"status": "ready-for-review" if ready else "blocked", "reason": recommendation_reason},
    }
    return report


def _percentile(values, fraction):
    if not values:
        return None
    values = sorted(abs(value) for value in values)
    index = min(len(values) - 1, int(round((len(values) - 1) * fraction)))
    return values[index]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("jsonl", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    report = estimate(load_rows(args.jsonl))
    text = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.out:
        args.out.write_text(text, encoding="utf-8")
    else:
        print(text, end="")


if __name__ == "__main__":
    main()
