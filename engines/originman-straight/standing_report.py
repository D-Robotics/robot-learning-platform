"""All-seed stationary recovery evidence, with explicit parameter-RL scope."""

import argparse
import base64
import html
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib import font_manager
from matplotlib.colors import ListedColormap
from monitor import digest, write_json


def read(path):
    return json.loads(path.read_text())


def lines(path):
    return [json.loads(s) for s in path.read_text().splitlines()]


def report(root, out, font):
    out.mkdir(parents=True, exist_ok=False)
    font_manager.fontManager.addfont(font)
    plt.rcParams["font.family"] = font_manager.FontProperties(fname=font).get_name()
    plt.rcParams["axes.unicode_minus"] = False
    seeds = [7, 17, 27]
    rows = {
        s: lines(root / f"standing-final-gain-seed{s}/episodes.jsonl") for s in seeds
    }
    reference = rows[7][::4]
    trained = {s: rows[s][3::4] for s in seeds}
    calibrated = lines(root / "standing-calibrated-01/final-episodes.jsonl")
    successes = {s: sum(r["recoverySuccess"] for r in trained[s]) for s in seeds}
    improvement = {
        s: [
            i
            for i, (a, b) in enumerate(zip(reference, trained[s], strict=True))
            if a["fallen"] and b["recoverySuccess"]
        ]
        for s in seeds
    }
    regressions = {
        s: [
            i
            for i, (a, b) in enumerate(zip(reference, trained[s], strict=True))
            if a["recoverySuccess"] and not b["recoverySuccess"]
        ]
        for s in seeds
    }
    common = sorted(set.intersection(*(set(improvement[s]) for s in seeds)))
    selected = common[0] if common else 0
    failures = [
        i
        for i, r in enumerate(reference)
        if r["fallen"] and all(not trained[s][i]["recoverySuccess"] for s in seeds)
    ]
    failure = failures[0] if failures else None
    for s in seeds:
        for a, b in zip(rows[s][::4], rows[s][2::4], strict=True):
            if {k: v for k, v in a.items() if k != "controller"} != {
                k: v for k, v in b.items() if k != "controller"
            }:
                raise ValueError("initial zero-gain controller differs from reference")
    payload = {
        "prototypeAchieved": bool(common)
        and all(trained[s][-1]["recoverySuccess"] for s in seeds),
        "scope": "PPO learns two feedback gains per episode; 50Hz PD runtime; no per-step neural gait or hardware claim",
        "referenceSuccesses": sum(r["recoverySuccess"] for r in reference),
        "rlSuccesses": successes,
        "calibrated": read(root / "standing-calibrated-01/summary.json"),
        "commonImprovementIndices": common,
        "improvementIndices": improvement,
        "regressionIndices": regressions,
        "selectedCase": selected,
        "failureCase": failure,
        "videoSelection": "first common improvement and first common failure; all conditions plotted",
        "coefficients": {
            s: read(root / f"standing-gain-seed{s}/gains.json")["coefficients"]
            for s in seeds
        },
        "hardwareEligible": False,
    }
    write_json(out / "results.json", payload)
    fig, axes = plt.subplots(2, 2, figsize=(13, 8), layout="constrained")
    colors = ["#1e7a83", "#7a66a3", "#b77c3e"]
    for s, color in zip(seeds, colors, strict=True):
        curve = lines(root / f"standing-gain-seed{s}/telemetry.jsonl")
        x = [c["timesteps"] for c in curve]
        for ax, key in [
            (axes[0, 0], "meanReward"),
            (axes[0, 1], "sampledRecoveryFraction"),
        ]:
            ax.plot(x, [c[key] for c in curve], label=f"种子 {s}", color=color)
        for i, ax in enumerate(axes[1]):
            ax.plot(
                [0] + x,
                [0] + [c["gains"][i] for c in curve],
                label=f"种子 {s}",
                color=color,
            )
            final = payload["coefficients"][s][i]
            ax.scatter([2048], [final], color=color, zorder=3)
    for ax, title in zip(
        axes.flat,
        [
            "完整物理回合的学习奖励",
            "采样回合恢复比例（含20%无扰动）",
            "学出的姿态反馈系数 Kp",
            "学出的角速度反馈系数 Kd",
        ],
        strict=True,
    ):
        ax.set_title(title)
        ax.set_xlabel("完整物理试验回合数")
        ax.grid(alpha=0.2)
        ax.legend(fontsize=9)
    fig.suptitle("训练过程：从零反馈参数开始，无教师参数或标签", fontsize=18)
    fig.savefig(out / "training.png", dpi=145)
    plt.close(fig)
    groups = [reference, calibrated] + [trained[s] for s in seeds]
    labels = ["参考 / 训练前", "非RL标定搜索"] + [f"RL 种子{s}" for s in seeds]
    values = [
        [1 if r["recoverySuccess"] else 0 if r["fallen"] else 0.5 for r in g]
        for g in groups
    ]
    fig, ax = plt.subplots(figsize=(16, 5), layout="constrained")
    ax.imshow(
        values,
        aspect="auto",
        vmin=0,
        vmax=1,
        cmap=ListedColormap(["#d38b82", "#e3c979", "#73b89c"]),
    )
    ax.set_yticks(
        range(5),
        [
            f"{label}  {sum(r['recoverySuccess'] for r in g)}/31"
            for label, g in zip(labels, groups, strict=True)
        ],
    )
    ax.set_xticks(
        range(31),
        [f"{i}\n{r['force']:+g}N\n{r['start']:g}s" for i, r in enumerate(reference)],
        fontsize=7,
    )
    ax.set_title(
        "31个固定条件全部保留：绿＝恢复稳定；黄＝未倒但未稳定；红＝跌倒", pad=15
    )
    fig.savefig(out / "final-conditions.png", dpi=145)
    plt.close(fig)
    fig, axes = plt.subplots(3, 1, figsize=(12, 9), layout="constrained")
    case_rows = [
        rows[7][selected * 4],
        rows[7][selected * 4 + 2],
        rows[7][selected * 4 + 3],
    ]
    visual_replay = root / "standing-visual-replays-02/episodes.jsonl"
    if visual_replay.exists():
        visual = lines(visual_replay)
        case_rows = [
            r
            for r in visual
            if r.get("originalCaseIndex") == selected
            and r["controller"] in ["reference", "untrained", "rl"]
        ]
    for row, label, color in zip(
        case_rows,
        ["参考站姿", "训练前零反馈", "训练后参数反馈"],
        ["#94704f", "#b16462", "#1e7a83"],
        strict=True,
    ):
        frames = row["frames"]
        time = [f["time"] for f in frames]
        for ax, key in zip(
            axes, ["tiltDegrees", "angularSpeed", "planarSpeed"], strict=True
        ):
            ax.plot(
                time,
                [f[key] for f in frames],
                label=label,
                color=color,
                linestyle="--" if label == "训练前零反馈" else "-",
            )
    for ax, title, limit in zip(
        axes,
        ["身体倾斜角（度）", "身体角速度（rad/s）", "平面速度（m/s）"],
        [5, 0.3, 0.05],
        strict=True,
    ):
        ax.axvspan(
            reference[selected]["start"],
            reference[selected]["start"] + 0.2,
            color="#e6c67a",
            alpha=0.35,
        )
        ax.axvspan(5, 6, color="#73b89c", alpha=0.12)
        ax.axhline(limit, color="#8a949b", linestyle=":")
        ax.set_title(title)
        ax.grid(alpha=0.2)
        ax.legend(fontsize=9)
        ax.set_xlim(0, 6)
    axes[-1].set_xlabel("仿真时间（秒）；黄色为扰动，浅绿为最终1秒检查窗口")
    fig.suptitle(
        f"共同改善条件 {selected}：{reference[selected]['force']:+g}N，{reference[selected]['start']:g}s开始",
        fontsize=17,
    )
    fig.savefig(out / "case-dynamics.png", dpi=145)
    plt.close(fig)
    sensitivity = read(root / "standing-sensitivity-01/summary.json")
    fig, ax = plt.subplots(figsize=(13, 5), layout="constrained")
    names = list(sensitivity)
    x = np.arange(len(names))
    width = 0.18
    for i, key in enumerate(["reference", "rl-7", "rl-17", "rl-27"]):
        ax.bar(
            x + (i - 1.5) * width,
            [sensitivity[n][key]["recoverySuccesses"] for n in names],
            width,
            label=key,
        )
    ax.set_xticks(x, names, rotation=15)
    ax.set_ylim(0, 12)
    ax.set_ylabel("恢复条件数 / 11")
    ax.legend(ncol=4)
    ax.set_title("冻结参数的敏感性检查：假设变化，不代表实测硬件范围")
    fig.savefig(out / "sensitivity.png", dpi=145)
    plt.close(fig)
    captions = [
        ("training.png", "1 · 学习过程"),
        ("final-conditions.png", "2 · 全部固定条件"),
        ("case-dynamics.png", "3 · 同一扰动的姿态与速度"),
        ("sensitivity.png", "4 · 数值与执行器假设变化"),
    ]
    sections = []
    for file, title in captions:
        uri = (
            "data:image/png;base64,"
            + base64.b64encode((out / file).read_bytes()).decode()
        )
        sections.append(
            f"<section><h2>{title}</h2><a href='{file}' target='_blank' rel='noopener'><img src='{uri}' alt='{html.escape(title)}'></a><p class='note'>点击图可查看原图。</p></section>"
        )
    table = "".join(
        f"<tr><td>RL 种子{s}</td><td>{successes[s]}/31</td><td>{payload['coefficients'][s][0]:.3f}</td><td>{payload['coefficients'][s][1]:.3f}</td></tr>"
        for s in seeds
    )
    document = f"""<!doctype html><html lang='zh-CN'><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>OriginMan 原地受扰恢复验证</title><style>body{{max-width:1180px;margin:32px auto;padding:0 20px;font:16px/1.8 system-ui;color:#243842;background:#f7f9f9}}h1{{font-size:30px}}h2{{font-size:22px}}section{{padding:22px;background:white;border:1px solid #dce5e8;border-radius:12px;margin:22px 0}}img,video{{width:100%;height:auto}}table{{border-collapse:collapse;width:100%}}td,th{{padding:10px;border-bottom:1px solid #dce5e8;text-align:left}}.note{{color:#5b6e79}}code{{background:#edf2f3;padding:3px 5px}}</style>
<h1>OriginMan 原地受扰恢复验证</h1><p>本阶段在仿真中出现了可重复的“参考倒、学习后的反馈恢复”。RL学习两个反馈参数，运行时为连续PD控制；逐时刻神经关节策略、迈步和真机迁移仍未通过。</p>
<section><h2>结果与边界</h2><p>参考站姿与训练前：{payload["referenceSuccesses"]}/31。非RL标定搜索：{payload["calibrated"]["recoverySuccesses"]}/31。三次独立RL训练：{successes[7]}、{successes[17]}、{successes[27]}/31。共同改善条件：{", ".join(map(str, common))}。这些是有限确定性仿真条件的覆盖数量，不是真机成功概率。</p><table><tr><th>训练</th><th>恢复条件</th><th>Kp</th><th>Kd</th></tr>{table}</table><p class='note'>每个种子2048个完整物理试验回合；从零参数开始，无教师标签。每回合PPO选择Kp、Kd，IMU反馈以50Hz形成踝关节位置残差。髋关节残差为零。非RL标定使用相同参数范围和训练推力，2000个回合，并要求保留无扰动站立。它也能实现恢复，不能宣称RL独有或必然更优。</p></section>
{"".join(sections)}<section><h2>5 · 四画面精确模型对照</h2><p>共同改善条件中编号最小的一例；参考、普通反馈、训练前与训练后使用同一初态、推力和模型。跌倒后保持最后记录姿态。</p><video controls preload='metadata' src='recovery.mp4'></video><p>更强扰动的失败例子也保留：</p><video controls preload='metadata' src='failure.mp4'></video></section>
<section><h2>6 · 训练阶段回放</h2><p>同一训练条件对照零参数、阶段检查点和最终参数；这是开发回放，不用于选择最终权重。</p><video controls preload='metadata' src='training-stages.mp4'></video></section>
<section><h2>接下来仍需完成</h2><p>原地参数学习不能直接当作步态强化学习已经完成。下一步应冻结这个小控制器，验证加入迈步后的效果；连续神经策略保留为未成功实验。厂家需确认模型适用性、关节装配、固件执行语义与IMU坐标；拿到样机后测量时序、执行器响应和足底接触，再验证迁移。当前没有硬件部署资格。</p></section></html>"""
    (out / "index.html").write_text(document)
    write_json(
        out / "report-inputs.json",
        {
            "files": {
                str(root / f"standing-final-gain-seed{s}/summary.json"): digest(
                    root / f"standing-final-gain-seed{s}/summary.json"
                )
                for s in seeds
            },
            "scope": "report generated from frozen evaluation records; video selection recorded in results.json",
        },
    )
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--font", required=True)
    a = p.parse_args()
    report(a.root, a.out, a.font)
