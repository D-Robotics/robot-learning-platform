"""Summarize sensitivity and temporal convergence without extrapolating to hardware."""

import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


def read_rows(path):
    return [
        json.loads(line) for line in (path / "episodes.jsonl").read_text().splitlines()
    ]


def build(sensitivity, convergence, out):
    out.mkdir(parents=True, exist_ok=False)
    rows = read_rows(sensitivity)
    conv = read_rows(convergence)
    profiles = [
        p["name"]
        for p in json.loads((sensitivity / "plan.json").read_text())["profiles"]
    ]
    controllers = list(dict.fromkeys(r["controller"] for r in rows))
    matrix = np.array(
        [
            [
                np.mean(
                    [
                        r["errorM"]
                        for r in rows
                        if r["profile"] == p and r["controller"] == c
                    ]
                )
                * 100
                for c in controllers
            ]
            for p in profiles
        ]
    )
    finest = min(r["result"]["physicsTimestepSeconds"] for r in conv)
    ref = {
        (r["controller"], r["targetM"]): r
        for r in conv
        if r["result"]["physicsTimestepSeconds"] == finest
    }
    convergence_stats = []
    for dt in sorted(
        {r["result"]["physicsTimestepSeconds"] for r in conv}, reverse=True
    ):
        cases = [r for r in conv if r["result"]["physicsTimestepSeconds"] == dt]
        deltas = [
            abs(
                r["result"]["ballForwardM"]
                - ref[r["controller"], r["targetM"]]["result"]["ballForwardM"]
            )
            for r in cases
        ]
        convergence_stats.append(
            {
                "timestepSeconds": dt,
                "meanDistanceDifferenceM": float(np.mean(deltas)),
                "maxDistanceDifferenceM": max(deltas),
                "cases": len(cases),
            }
        )
    (out / "convergence.json").write_text(json.dumps(convergence_stats, indent=2))
    fig, axes = plt.subplots(
        1, 2, figsize=(13, 8), gridspec_kw={"width_ratios": [1.5, 1]}
    )
    ax = axes[0]
    im = ax.imshow(matrix, aspect="auto", cmap="YlOrRd", vmin=0, vmax=16)
    ax.set_xticks(range(len(controllers)), controllers, rotation=25, ha="right")
    ax.set_yticks(range(len(profiles)), profiles)
    for i, profile in enumerate(profiles):
        for j, controller in enumerate(controllers):
            fails = sum(
                not r["valid"]
                for r in rows
                if r["profile"] == profile and r["controller"] == controller
            )
            ax.text(
                j,
                i,
                f"{matrix[i, j]:.1f}" + (f" [{fails} invalid]" if fails else ""),
                ha="center",
                va="center",
                fontsize=8,
            )
    fig.colorbar(im, ax=ax, label="Distance MAE (cm)", shrink=0.6)
    ax.set_title("Frozen controllers: one-factor sensitivity")
    ax = axes[1]
    stats = convergence_stats[:-1]
    ax.plot(
        [r["timestepSeconds"] * 1000 for r in stats],
        [r["maxDistanceDifferenceM"] * 100 for r in stats],
        "o-",
        label="Maximum difference",
    )
    ax.plot(
        [r["timestepSeconds"] * 1000 for r in stats],
        [r["meanDistanceDifferenceM"] * 100 for r in stats],
        "o-",
        label="Mean difference",
    )
    ax.axhline(0.1, linestyle="--", color="gray", label="1mm diagnostic threshold")
    ax.set_xscale("log")
    ax.set_xticks([0.125, 0.25, 0.5, 1, 2], ["0.125", "0.25", "0.5", "1", "2"])
    ax.minorticks_off()
    ax.set_xlabel("Physics timestep (ms); control stays at 20ms")
    ax.set_ylabel("Ball displacement difference from finest run (cm)")
    ax.set_title("Temporal convergence: 12 paired cases")
    ax.legend()
    fig.suptitle(
        "OriginMan fidelity probes — simulation assumptions, no hardware measurements"
    )
    fig.tight_layout()
    fig.savefig(out / "fidelity.png", dpi=160)
    plt.close(fig)
    lines = [
        "# OriginMan 仿真可信度复核",
        "",
        "本轮只验证当前仿真的敏感性和数值收敛，不包含真机证据。",
        "",
        "## 实验范围",
        "",
        f"冻结三个 PPO 最终权重和非 RL 标定插值表，完成 {len(rows)} 个参数敏感性回合、{len(conv)} 个步长检查回合。目标为 7、11、19cm；没有重训、重新标定或挑选最佳种子。所有物理参数范围均为探测假设。",
        "",
        "![敏感性与收敛](fidelity.png)",
        "",
        "## 步长检查",
        "",
        "控制周期始终为 20ms，只改变物理积分步长。以本轮最小步长作为比较参考，不把它视为真值。",
        "",
        "|步长 / ms|球位移平均差 / cm|球位移最大差 / cm|",
        "|---:|---:|---:|",
    ]
    lines += [
        f"|{r['timestepSeconds'] * 1000:g}|{r['meanDistanceDifferenceM'] * 100:.3f}|{r['maxDistanceDifferenceM'] * 100:.3f}|"
        for r in convergence_stats
    ]
    lines += [
        "",
        "最小两个步长之间，最大球位移差仍超过图中 1mm 诊断阈值，因此本轮没有证明毫米级数值收敛。该阈值只是诊断标准，并非制造商精度指标。此前方法之间的毫米级优势不足以支撑排序。",
        "",
        "原始脚底 STL 的局部 Z 最低 0.5mm 顶点凸包面积约占包围矩形 90%；它仍是凸包近似，并非实测受压接触面。长宽各缩小 20% 后面积只有原矩形 64%，属于较强压力测试，不能冒充真实脚底尺寸。完整数据见 convergence-01/sole-audit.json；可用 originman-straight/sole_audit.py 重算。",
        "",
        "## 当前决定",
        "",
        "1. 暂停把定点变力度踢球作为 workshop 核心 RL 成果。此前比较没有稳定、明显的 RL 优势，本轮又暴露了接触、伺服和步长敏感性。",
        "2. 现有脚底碰撞框不得继续作为已验证支撑面。缩小横向和纵向尺寸各 20% 是压力检查，不代表真实脚底尺寸；需要检查原始网格的实际底面，并在样机上核对。",
        "3. 不用增加 PPO 训练量掩盖模型问题。下一阶段先改进碰撞与执行器模型，再评估有闭环观测的步态适应任务；尚未证明该候选任务达到用户要求。",
        "4. 无样机时可以完成模型、训练和跨参数仿真验证；不能确认实际落地。厂家确认与真机测量仍为独立必要项。",
        "",
        "## 证据边界",
        "",
        "MAE 对所有回合计算，包括失败回合；失败动作即使距离巧合接近目标也不算成功。图中方括号为无效动作数。",
        "",
        "命令延迟只模拟固定目标传输延迟，不代表传感延迟、丢包、固件排队或舵机内部控制。当前策略每次只选两个轨迹参数，不是实时关节反馈 RL。",
        "",
        "完整参数、权重哈希和逐回合记录见对应实验目录中的 plan.json 和 episodes.jsonl。",
    ]
    (out / "RESULTS.md").write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--sensitivity", type=Path, required=True)
    p.add_argument("--convergence", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    build(a.sensitivity, a.convergence, a.out)
