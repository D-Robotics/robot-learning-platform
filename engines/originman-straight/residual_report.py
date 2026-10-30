"""All-seed report for continuous neural correction beyond a frozen feedback baseline."""

import argparse
import base64
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
        s: lines(root / f"standing-final-residual-seed{s}/episodes.jsonl")
        for s in seeds
    }
    summaries = {
        s: read(root / f"standing-final-residual-seed{s}/summary.json") for s in seeds
    }
    sensor_frozen = read(root / "residual-sensor-ablation-01/summary.json")
    grouped = {
        s: {
            k: [r for r in rows[s] if r["controller"] == k]
            for k in [
                "reference",
                "imu-feedback",
                "untrained",
                "rl",
                "rl-frozen-correction",
            ]
        }
        for s in seeds
    }
    common = sorted(
        set.intersection(*(set(summaries[s]["improvementIndices"]) for s in seeds))
    )
    available = [s for s in seeds if summaries[s]["improvementIndices"]]
    chosen = 7 if common or 7 in available else available[0] if available else 7
    index = (
        common[0]
        if common
        else summaries[chosen]["improvementIndices"][0]
        if summaries[chosen]["improvementIndices"]
        else 0
    )
    failure = next(
        (
            i
            for i, (a, b) in enumerate(
                zip(grouped[chosen]["imu-feedback"], grouped[chosen]["rl"], strict=True)
            )
            if not b["recoverySuccess"]
        ),
        None,
    )
    result = {
        "allSeedsClearGain": all(summaries[s]["clearGain"] for s in seeds),
        "seedResults": summaries,
        "commonImprovementIndices": common,
        "videoSeed": chosen,
        "videoCase": index,
        "failureCase": failure,
        "selectionRule": "first common improvement, otherwise first improvement in seed order 7/17/27; all seeds retained",
        "scope": "SAC learns 50Hz hip/ankle corrections beyond frozen PD; not per-episode gain selection; simulation only",
        "hardwareEligible": False,
        "sensorFrozen": sensor_frozen,
    }
    write_json(out / "results.json", result)
    fig, axes = plt.subplots(1, 2, figsize=(14, 4.6), layout="constrained")
    colors = ["#1b7884", "#7966a4", "#b87c3d"]
    for seed, color in zip(seeds, colors, strict=True):
        curve = lines(root / f"standing-residual-seed{seed}/telemetry.jsonl")
        x = np.array([p["timesteps"] for p in curve]) / 1000
        y = np.array([p["meanReward"] for p in curve])
        window = 30
        axes[0].plot(
            x[window - 1 :],
            np.convolve(y, np.ones(window) / window, mode="valid"),
            label=f"种子{seed}",
            color=color,
        )
        checks = [
            read(p)
            for p in sorted(
                (root / f"standing-residual-seed{seed}/validation").glob("*.json")
            )
        ]
        axes[1].plot(
            [p["timesteps"] / 1000 for p in checks],
            [p["rlSuccesses"] for p in checks],
            label=f"RL种子{seed}",
            color=color,
            marker="o",
        )
    checks = [
        read(p)
        for p in sorted((root / "standing-residual-seed7/validation").glob("*.json"))
    ]
    axes[1].plot(
        [p["timesteps"] / 1000 for p in checks],
        [p["referenceSuccesses"] for p in checks],
        label="冻结基础反馈",
        color="#667079",
        linestyle="--",
    )
    for ax, title in zip(
        axes, ["训练原始奖励，30轮平均", "固定开发条件恢复数 / 9"], strict=True
    ):
        ax.set_title(title)
        ax.set_xlabel("累计控制步（千）")
        ax.grid(alpha=0.2)
        ax.legend(fontsize=9)
    axes[1].set_ylim(0, 9)
    fig.suptitle("连续髋踝修正：训练过程与开发检查", fontsize=18)
    fig.savefig(out / "training.png", dpi=145)
    plt.close(fig)
    groups = (
        [grouped[7]["imu-feedback"], grouped[7]["untrained"]]
        + [grouped[s]["rl"] for s in seeds]
        + [grouped[s]["rl-frozen-correction"] for s in seeds]
    )
    names = (
        ["基础反馈", "基础＋未训练"]
        + [f"基础＋RL {s}" for s in seeds]
        + [f"固定RL输出 {s}" for s in seeds]
    )
    values = [
        [1 if r["recoverySuccess"] else 0 if r["fallen"] else 0.5 for r in g]
        for g in groups
    ]
    fig, ax = plt.subplots(figsize=(16, 6), layout="constrained")
    ax.imshow(
        values,
        aspect="auto",
        vmin=0,
        vmax=1,
        cmap=ListedColormap(["#d48b83", "#e2c97a", "#72b79a"]),
    )
    ax.set_yticks(
        range(len(groups)),
        [
            f"{n}  {sum(r['recoverySuccess'] for r in g)}/31"
            for n, g in zip(names, groups, strict=True)
        ],
    )
    ax.set_xticks(
        range(31),
        [f"{i}\n{r['force']:+g}N\n{r['start']:g}s" for i, r in enumerate(groups[0])],
        fontsize=7,
    )
    ax.set_title("全部固定条件：绿＝恢复稳定；黄＝未倒但未稳定；红＝跌倒", pad=12)
    fig.savefig(out / "final-conditions.png", dpi=145)
    plt.close(fig)
    base = grouped[chosen]["imu-feedback"][index]
    trained = grouped[chosen]["rl"][index]
    basis = np.load(
        root / f"standing-residual-seed{chosen}/foot-basis.npy", allow_pickle=False
    )[0]
    inverse = np.linalg.pinv(basis)
    scale = read(root / f"standing-residual-seed{chosen}/training-summary.json")[
        "config"
    ]["residual_scale"]
    total_extra = [
        (inverse @ np.asarray(f["residualExecuted"]) - np.asarray(f["baseFeedback"]))
        * scale
        for f in trained["frames"]
    ]
    write_json(
        out / "command-comparison.json",
        {
            "definition": "actual normalized joint target decoded through saved roll basis, minus current nominal PD target, times residual scale; command targets, not measured joint angles",
            "time": [f["time"] for f in trained["frames"]],
            "extraTargetRadians": [v.tolist() for v in total_extra],
        },
    )
    fig, axes = plt.subplots(3, 1, figsize=(12, 9), layout="constrained")
    for row, label, color in [
        (base, "冻结基础反馈", "#9a7855"),
        (grouped[chosen]["untrained"][index], "叠加未训练策略", "#b86a68"),
        (trained, "叠加训练后策略", "#1b7884"),
    ]:
        axes[0].plot(
            [f["time"] for f in row["frames"]],
            [f["tiltDegrees"] for f in row["frames"]],
            label=label,
            color=color,
            linestyle="--" if label == "叠加未训练策略" else "-",
        )
    for i, name in enumerate(["踝", "髋"]):
        time = [f["time"] for f in trained["frames"]]
        axes[i + 1].plot(
            time,
            [f["learningCorrectionRadians"][i] for f in trained["frames"]],
            label=name + "修正请求",
            color="#a5aeb6",
            linestyle="--",
        )
        axes[i + 1].plot(
            time,
            [v[i] for v in total_extra],
            label=name + "实际额外目标",
            color="#1b7884",
        )
    for ax, title in zip(
        axes,
        ["身体倾角（度）", "RL额外踝目标（rad）", "RL额外髋目标（rad）"],
        strict=True,
    ):
        ax.set_title(title)
        ax.axvspan(base["start"], base["start"] + 0.2, color="#e5c778", alpha=0.3)
        ax.grid(alpha=0.2)
        ax.legend(fontsize=9)
        ax.set_xlim(0, 6)
    axes[-1].set_xlabel(
        "仿真时间（秒）；灰线为请求，实线为实际目标与当前名义基础反馈目标之差"
    )
    fig.suptitle(
        f"种子{chosen} · 条件{index}：{base['force']:+g}N，{base['start']:g}s开始",
        fontsize=17,
    )
    fig.savefig(out / "corrections.png", dpi=145)
    plt.close(fig)
    sensitivity = read(root / "residual-sensitivity-01/summary.json")
    fig, ax = plt.subplots(figsize=(14, 5), layout="constrained")
    variant_names = list(sensitivity)
    x = np.arange(len(variant_names))
    width = 0.18
    for i, mode in enumerate(["baseline", "rl-7", "rl-17", "rl-27"]):
        ax.bar(
            x + (i - 1.5) * width,
            [sensitivity[v][mode]["recoverySuccesses"] for v in variant_names],
            width,
            label=mode,
        )
    ax.set_xticks(
        x,
        [
            "默认",
            "步长0.5ms",
            "步长0.25ms",
            "伺服增益−20%",
            "伺服增益＋20%",
            "力矩上限−20%",
            "力矩上限＋20%",
        ],
        rotation=10,
    )
    ax.set_ylim(0, 14)
    ax.set_ylabel("恢复条件数 / 13")
    ax.legend(ncol=4)
    ax.set_title("冻结策略的物理假设检查：每档首个时刻、无扰动及所有已观察退化条件")
    fig.savefig(out / "sensitivity.png", dpi=145)
    plt.close(fig)
    fig, ax = plt.subplots(figsize=(11, 4.5), layout="constrained")
    x = np.arange(3)
    width = 0.22
    ax.bar(
        x - width,
        [summaries[s]["controllers"]["rl"]["recoverySuccesses"] for s in seeds],
        width,
        label="实时观测与输出",
        color="#1b7884",
    )
    ax.bar(
        x,
        [
            summaries[s]["controllers"]["rl-frozen-correction"]["recoverySuccesses"]
            for s in seeds
        ],
        width,
        label="只冻结RL输出",
        color="#bd9066",
    )
    ax.bar(
        x + width,
        [sensor_frozen[str(s)]["recoverySuccesses"] for s in seeds],
        width,
        label="冻结身体观测，保留动作历史",
        color="#8a7aaa",
    )
    ax.axhline(13, color="#63727c", linestyle="--", label="基础反馈13/31")
    ax.set_xticks(x, [f"种子{s}" for s in seeds])
    ax.set_ylim(0, 32)
    ax.set_ylabel("恢复条件数 / 31")
    ax.legend(fontsize=9)
    ax.set_title("机制诊断：实时身体状态与连续修正都参与了收益")
    fig.savefig(out / "ablations.png", dpi=145)
    plt.close(fig)
    paired = out / "paired-records"
    paired.mkdir()
    paired_rows = []
    for i in range(31):
        for mode in ["reference", "imu-feedback", "untrained", "rl"]:
            paired_rows.append({"originalCaseIndex": i, **grouped[chosen][mode][i]})
    with (paired / "episodes.jsonl").open("w") as f:
        for r in paired_rows:
            f.write(json.dumps(r) + "\n")
    write_json(
        paired / "provenance.json",
        {
            "seed": chosen,
            "originalEpisodesSha256": digest(
                root / f"standing-final-residual-seed{chosen}/episodes.jsonl"
            ),
            "operation": "select four paired controllers; recorded poses unchanged",
        },
    )
    table = "".join(
        f"<tr><td>种子{s}</td><td>{summaries[s]['controllers']['rl']['recoverySuccesses']}/31</td><td>{len(summaries[s]['improvementIndices'])}</td><td>{len(summaries[s]['regressionIndices'])}</td><td>{summaries[s]['controllers']['rl-frozen-correction']['recoverySuccesses']}/31</td><td>{'通过' if summaries[s]['clearGain'] else '未通过'}</td></tr>"
        for s in seeds
    )
    figures = []
    for file, title in [
        ("training.png", "训练过程"),
        ("final-conditions.png", "全部固定条件与冻结输出对照"),
        ("corrections.png", "连续修正实际改变了什么"),
        ("sensitivity.png", "数值步长与执行器假设变化"),
        ("ablations.png", "实时观测与输出是否必要"),
    ]:
        data = base64.b64encode((out / file).read_bytes()).decode()
        figures.append(
            f"<section><h2>{title}</h2><a href='{file}' target='_blank' rel='noopener'><img src='data:image/png;base64,{data}' alt='{title}'></a><p>点击图查看原图。</p></section>"
        )
    headline = (
        "三个种子均达到预定明显收益门槛"
        if result["allSeedsClearGain"]
        else "出现改善案例，整体明显收益门槛尚未全部通过"
        if available
        else "本轮未获得恢复改善"
    )
    baseline = summaries[7]["controllers"]["imu-feedback"]["recoverySuccesses"]
    content = f"""<!doctype html><html lang='zh-CN'><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>OriginMan 连续髋踝RL修正验证</title><style>body{{max-width:1180px;margin:32px auto;padding:0 20px;font:16px/1.8 system-ui;color:#243842;background:#f5f8f8}}section{{padding:22px;background:white;border:1px solid #dce5e8;border-radius:12px;margin:22px 0}}img,video{{width:100%;height:auto}}table{{width:100%;border-collapse:collapse}}td,th{{padding:8px;border-bottom:1px solid #dce5e8;text-align:left}}h1{{font-size:30px}}h2{{font-size:22px}}</style><h1>OriginMan 连续髋踝RL修正验证</h1><p>{headline}。基础反馈参数固定为Kp=2.5、Kd=0.225，RL每20ms根据14维本体状态输出两个额外髋踝目标。本轮不再学习每回合固定反馈参数。</p><section><h2>同条件对照结果</h2><p>冻结基础反馈与叠加未训练策略均为{baseline}/31。最终权重只评测一次，保留全部种子。预定门槛为净增加至少6个恢复条件、无扰动站立保留、至少3个条件证明动态修正优于固定输出。</p><table><tr><th>训练</th><th>恢复数</th><th>改善条件</th><th>退化条件</th><th>冻结修正输出</th><th>明显收益门槛</th></tr>{table}</table><p>数字是有限确定性仿真条件覆盖，不是真机成功率。固定输出对照仅冻结神经策略的输出；基础PD始终保持闭环。</p></section>{"".join(figures)}<section><h2>精确模型前后对照</h2><p>种子{chosen}、条件{index}。按预先说明的规则选取，所有条件与失败在上图保留。跌倒后保持实际终止姿态；封面为末帧。</p><video controls preload='metadata' poster='recovery-poster.png' src='recovery.mp4'></video><h2>未通过的条件</h2><video controls preload='metadata' poster='failure-poster.png' src='failure.mp4'></video><h2>固定训练阶段回放</h2><video controls preload='metadata' poster='training-stages-poster.png' src='training-stages.mp4'></video></section><section><h2>可追溯范围与限制</h2><p>保留源码与模型快照、固定基础控制器、初始与最终权重、检查点、归一化约定、训练曲线、逐条件物理轨迹及神经策略输入输出。灰色修正请求经过限幅后可能不改变关节目标，图中实线为实际下发目标与该状态名义基础反馈目标之差，不是实测关节角度。</p><p>模型的接触、伺服增益、力矩和传感器仍未真机标定。本实验是原地恢复，不是迈步或人体跟随验收；策略没有硬件部署资格。厂家确认和真机验证继续单独管理。</p></section></html>"""
    (out / "index.html").write_text(content)
    print(
        json.dumps(
            {
                "allSeedsClearGain": result["allSeedsClearGain"],
                "commonImprovements": common,
                "videoSeed": chosen,
                "videoCase": index,
                "failureCase": failure,
            }
        )
    )


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--font", required=True)
    a = p.parse_args()
    report(a.root, a.out, a.font)
