"""Report every frozen condition, including regressions and non-RL baselines."""

import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib import font_manager
from matplotlib.colors import ListedColormap
from monitor import write_json
from sb3_receipt import verify


def read(path):
    return json.loads(path.read_text())


def report(root, out, font=None):
    out.mkdir(parents=True, exist_ok=False)
    if font:
        font_manager.fontManager.addfont(font)
        plt.rcParams["font.family"] = font_manager.FontProperties(fname=font).get_name()
    plt.rcParams["axes.unicode_minus"] = False
    datasets = {}
    for mode in ["joints", "feet"]:
        path = root / f"sb3-final-{mode}"
        datasets[mode] = [
            json.loads(s) for s in (path / "episodes.jsonl").read_text().splitlines()
        ]
    grouped = {
        key: [r for r in datasets["joints"] if r["controller"] == key]
        for key in ["reference", "imu-feedback"]
    }
    for mode, rows in datasets.items():
        grouped[mode] = [r for r in rows if r["controller"] == "rl"]
        for key in ["reference", "imu-feedback"]:
            comparison = [r for r in rows if r["controller"] == key]
            for a, b in zip(grouped[key], comparison, strict=True):
                if any(
                    a[k] != b[k]
                    for k in ["force", "start", "fallen", "walkingSuccess", "forwardM"]
                ):
                    raise ValueError("non-RL replay differs between evaluations")
    labels = {
        "reference": "参考步态",
        "imu-feedback": "修正后的普通反馈",
        "joints": "RL：十关节残差",
        "feet": "RL：两维脚部修正",
    }
    counts = {k: sum(r["walkingSuccess"] for r in rows) for k, rows in grouped.items()}
    criteria = read(root / "sb3-adoption-check-01.json")["prototypePass"]
    results = {}
    for mode in ["joints", "feet"]:
        rows = grouped[mode]
        retain = rows[-1]["forwardM"] / grouped["reference"][-1]["forwardM"]
        improvements = [
            i
            for i, (a, b) in enumerate(zip(grouped["reference"], rows, strict=True))
            if not a["walkingSuccess"] and b["walkingSuccess"]
        ]
        regressions = [
            i
            for i, (a, b) in enumerate(zip(grouped["reference"], rows, strict=True))
            if a["walkingSuccess"] and not b["walkingSuccess"]
        ]
        integrity = verify(root / f"sb3-{mode}-seed7")
        results[mode] = {
            "walkingSuccesses": counts[mode],
            "cases": len(rows),
            "normalForwardRetention": retain,
            "improvementIndices": improvements,
            "regressionIndices": regressions,
            "integrity": integrity,
            "prototypePass": bool(
                counts[mode] - max(counts["reference"], counts["imu-feedback"])
                >= criteria["minimumWalkingSuccessGainOverBestNonRl"]
                and retain >= criteria["normalForwardRetentionMinimum"]
                and improvements
                and integrity["verified"]
            ),
        }
    write_json(
        out / "results.json",
        {"counts": counts, "rl": results, "hardwareEligible": False},
    )
    fig = plt.figure(figsize=(15, 10), layout="constrained")
    gs = fig.add_gridspec(3, 2, height_ratios=[1, 1.25, 1])
    ax = fig.add_subplot(gs[0, 0])
    bars = ax.bar(
        range(4),
        list(counts.values()),
        color=["#728192", "#b28c61", "#207b8a", "#6466a4"],
    )
    ax.set_xticks(range(4), list(labels.values()), fontsize=10)
    ax.set_ylim(0, 28)
    ax.set_ylabel("完整行走条件数 / 25")
    ax.bar_label(bars, labels=[f"{v}/25" for v in counts.values()], padding=4)
    ax.set_title("相同初态、相同推力；只使用最终权重")
    ax = fig.add_subplot(gs[0, 1])
    ax.axis("off")
    ax.text(
        0,
        0.95,
        "通过条件：8秒不倒、前进≥15cm、两腿均有单支撑\n\n"
        + "\n".join(
            f"{labels[k]}：正常前进 {grouped[k][-1]['forwardM'] * 100:.1f}cm"
            for k in grouped
        )
        + "\n\n全部为未标定仿真；不能视为真机成功率。",
        va="top",
        fontsize=12,
        linespacing=1.6,
    )
    ax = fig.add_subplot(gs[1, :])
    matrix = np.array(
        [
            [1 if r["walkingSuccess"] else 0 if r["fallen"] else 0.5 for r in rows]
            for rows in grouped.values()
        ]
    )
    ax.imshow(
        matrix,
        aspect="auto",
        vmin=0,
        vmax=1,
        cmap=ListedColormap(["#d7847c", "#e3c875", "#73b99b"]),
    )
    ax.set_yticks(range(4), list(labels.values()))
    ax.set_xticks(
        range(25),
        [
            f"{i}\n{r['force']:+g}N\n{r['start']:g}s"
            for i, r in enumerate(grouped["reference"])
        ],
        fontsize=8,
    )
    ax.set_title("全部固定条件：绿＝完整行走；红＝跌倒；黄＝未倒但未完成行走", pad=12)
    for col, mode in enumerate(["joints", "feet"]):
        ax = fig.add_subplot(gs[2, col])
        curve = [
            json.loads(s)
            for s in (root / f"sb3-{mode}-seed7/telemetry.jsonl")
            .read_text()
            .splitlines()
        ]
        x = np.array([r["timesteps"] for r in curve]) / 1000
        y = np.array([r["meanReward"] for r in curve])
        ax.plot(x, y, alpha=0.25, color="#207b8a")
        window = 30
        ax.plot(
            x[window - 1 :],
            np.convolve(y, np.ones(window) / window, mode="valid"),
            color="#207b8a",
        )
        ax.set_xlabel("累计控制步（千）")
        ax.set_ylabel("训练原始平均奖励")
        ax.set_title(labels[mode] + "；奖励不代替动作验收")
        ax.grid(alpha=0.2)
    fig.suptitle("OriginMan 独立 PPO 与两维修正兜底验证", fontsize=20)
    fig.savefig(out / "comparison.png", dpi=150)
    plt.close(fig)
    print(json.dumps({"counts": counts, "rl": results}, ensure_ascii=False))


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--font")
    a = p.parse_args()
    report(a.root, a.out, a.font)
