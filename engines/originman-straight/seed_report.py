"""Compare every predeclared seed; never promote the best single run."""

import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import ListedColormap
from matplotlib.patches import Patch
from monitor import digest, verify_run, write_json


def build(root, plan_path, out):
    out.mkdir(parents=True, exist_ok=False)
    plan = json.loads(plan_path.read_text())
    limit = plan["primaryOperatingForceLimitN"]
    seeds = [7, 17, 27]
    data = {}
    summary = []
    integrity = {}
    reference = None
    for seed in seeds:
        run = root / f"push-clock-seed{seed}"
        folder = root / f"push-clock-final-seed{seed}"
        if run.name not in plan["plannedRuns"]:
            raise ValueError("unplanned seed")
        rows = [
            json.loads(line)
            for line in (folder / "episodes.jsonl").read_text().splitlines()
        ]
        pairs = [rows[i : i + 3] for i in range(0, len(rows), 3)]
        if len(pairs) != len(plan["cases"]):
            raise ValueError("incomplete evaluation")
        for case, pair in zip(plan["cases"], pairs):
            if any(
                r["force"] != case["force"] or r["start"] != case["start"] for r in pair
            ):
                raise ValueError("case-plan mismatch")
            if [r["controller"] for r in pair] != ["reference", "imu-feedback", "rl"]:
                raise ValueError("controller pairing mismatch")
        current = [pair[0] for pair in pairs]
        if reference is None:
            reference = current
        elif any(
            a["walkingSuccess"] != b["walkingSuccess"]
            or abs(a["forwardM"] - b["forwardM"]) > 1e-10
            for a, b in zip(reference, current)
        ):
            raise ValueError("reference physics differs between seeds")
        rl = [pair[2] for pair in pairs]
        data[seed] = rl
        core = [i for i, c in enumerate(plan["cases"]) if abs(c["force"]) <= limit]
        zero = next(i for i, c in enumerate(plan["cases"]) if c["force"] == 0)
        summary.append(
            {
                "seed": seed,
                "referenceSuccesses": sum(r["walkingSuccess"] for r in reference),
                "rlSuccesses": sum(r["walkingSuccess"] for r in rl),
                "cases": len(rl),
                "primaryReferenceSuccesses": sum(
                    reference[i]["walkingSuccess"] for i in core
                ),
                "primaryRlSuccesses": sum(rl[i]["walkingSuccess"] for i in core),
                "primaryCases": len(core),
                "normalForwardRetention": rl[zero]["forwardM"]
                / reference[zero]["forwardM"],
                "improvedCaseIndices": [
                    i
                    for i, (a, b) in enumerate(zip(reference, rl))
                    if not a["walkingSuccess"] and b["walkingSuccess"]
                ],
                "regressedCaseIndices": [
                    i
                    for i, (a, b) in enumerate(zip(reference, rl))
                    if a["walkingSuccess"] and not b["walkingSuccess"]
                ],
            }
        )
        receipt = json.loads((folder / "evaluation-runtime.json").read_text())
        integrity[str(seed)] = {
            "training": verify_run(run),
            "evaluationSourceChanged": receipt["sourceChangedDuringEvaluation"],
            "evaluationModelChanged": receipt["modelChangedDuringEvaluation"],
            "policySha256": digest(run / "policy.onnx"),
            "summarySha256": digest(folder / "summary.json"),
        }
        if (
            not integrity[str(seed)]["training"]["verified"]
            or receipt["sourceChangedDuringEvaluation"]
            or receipt["modelChangedDuringEvaluation"]
        ):
            raise ValueError("evidence integrity check failed")
    state = lambda row: 2 if row["walkingSuccess"] else (0 if row["fallen"] else 1)
    columns = [reference] + [data[s] for s in seeds]
    matrix = np.array(
        [[state(col[i]) for col in columns] for i in range(len(reference))]
    )
    fig, axes = plt.subplots(
        1, 2, figsize=(12, 10), gridspec_kw={"width_ratios": [1.2, 1]}
    )
    ax = axes[0]
    ax.imshow(
        matrix,
        aspect="auto",
        cmap=ListedColormap(["#ba6562", "#e7b75f", "#5a9471"]),
        vmin=0,
        vmax=2,
    )
    ax.set_xticks(
        range(4),
        ["Reference", "RL seed 7", "RL seed 17", "RL seed 27"],
        rotation=20,
        ha="right",
    )
    ax.set_yticks(
        range(len(reference)),
        [
            f"{i}: {c['force']:+g}N @ {c['start']:g}s"
            for i, c in enumerate(plan["cases"])
        ],
        fontsize=8,
    )
    for i in range(matrix.shape[0]):
        for j in range(4):
            ax.text(
                j,
                i,
                ["F", "P", "S"][matrix[i, j]],
                ha="center",
                va="center",
                fontsize=8,
                color="white" if matrix[i, j] != 1 else "black",
            )
    ax.set_title("Every scenario and seed retained")
    ax.legend(
        handles=[
            Patch(color=c, label=t)
            for c, t in [
                ("#ba6562", "Fall"),
                ("#e7b75f", "Incomplete walking"),
                ("#5a9471", "Complete walking"),
            ]
        ],
        loc="upper left",
        bbox_to_anchor=(0, -0.07),
        fontsize=8,
    )
    ax = axes[1]
    values = [summary[0]["referenceSuccesses"]] + [r["rlSuccesses"] for r in summary]
    bars = ax.bar(
        ["Reference", "RL 7", "RL 17", "RL 27"],
        values,
        color=["#53758b", "#cf674e", "#cf674e", "#cf674e"],
    )
    ax.bar_label(bars, padding=3)
    ax.set_ylim(0, len(reference))
    ax.set_ylabel("Complete walking / 25 scenarios")
    ax.set_title("Frozen final policies, no checkpoint selection")
    fig.suptitle(
        "OriginMan: corrected disturbance timing, three fresh training seeds\nSimulation evidence only; no hardware capability claim",
        fontsize=12,
    )
    fig.tight_layout(rect=(0, 0.04, 1, 0.94))
    fig.savefig(out / "three-seed.png", dpi=160)
    plt.close(fig)
    write_json(out / "summary.json", summary)
    write_json(out / "integrity.json", integrity)
    all_gain = all(r["rlSuccesses"] > r["referenceSuccesses"] for r in summary)
    lines = [
        "# OriginMan 步态RL三种子复核",
        "",
        "当前结论：未证明稳定且明显的整体RL收益，不将本策略作为已经可交付的workshop核心动作。没有样机，实际落地仍未验证。",
        "",
        "![全部条件与种子](three-seed.png)",
        "",
        "## 固定条件的完整结果",
        "",
        "三个种子均从头训练500轮；参数固定，只更换随机种子。使用相同修正后的物理推力计时、相同模型和相同25个预先声明条件。只评测最终权重，不挑选检查点或最好种子。",
        "",
        "|种子|参考成功|RL成功|预先限定较小力范围内参考成功|同范围RL成功|无扰动前进保留|",
        "|---|---:|---:|---:|---:|---:|",
    ]
    lines += [
        f"|{r['seed']}|{r['referenceSuccesses']}/{r['cases']}|{r['rlSuccesses']}/{r['cases']}|{r['primaryReferenceSuccesses']}/{r['primaryCases']}|{r['primaryRlSuccesses']}/{r['primaryCases']}|{r['normalForwardRetention']:.0%}|"
        for r in summary
    ]
    lines += [
        "",
        f"较小力范围为预先声明的绝对值不超过{limit}N；更强诊断条件也全部保留。两个范围都只是仿真假设，不是实物允许范围。",
        "",
        "成功标准保持完整8秒不跌倒、前进至少15cm、左右腿各至少5帧单支撑。正常行走保留主要由参考轨迹与IMU接管逻辑实现，不能单独宣传为RL收益。",
        "",
        "## 改善与退化",
        "",
    ]
    for r in summary:
        lines.append(
            f"- 种子{r['seed']}：改善条件编号{r['improvedCaseIndices']}；退化条件编号{r['regressedCaseIndices']}。"
        )
    lines += [
        "",
        "之前存在可见的单次恢复例子，本轮不否定其发生；它不足以证明稳定、可重复的总体改善。所有比例均为有限确定性仿真场景覆盖，不是独立随机实机成功率。",
        "",
        "## 可信度检查",
        "",
        "推力在物理子步施加，并记录每个控制周期的冲量、平均力和实际作用窗口；已修复浮点累加造成整周期延迟及非对齐脉冲时长偏差。20ms和40ms控制周期的对齐推力时序检查通过，非对齐脉冲的物理冲量检查通过。",
        "",
        "训练与评测分别保留源码和运行时快照；三份训练完整性及评测源码、模型未变更检查通过。ONNX一致性只证明导出实现，不证明动作能力。",
        "",
        "## 对workshop的决定",
        "",
        "基础版继续保留腿部关节RL路线，但当前只能定位为研发或探索课程，不能承诺学员得到稳定的实物抗扰动作。简略版也不能将旧成功视频当作已验收能力。最后的人体跟随仍为官方独立应用，不能称为本RL步态已完成视觉跟随。",
        "",
        "要推进实际落地，需要对应样机及模型适用性、关节约定、固件目标语义、IMU坐标等确认；随后实测时序、负载响应和足底接触，再据实修订模型和训练。继续只优化未标定的仿真假设，无法消除这些迁移不确定性。",
        "",
        "本结论不等于OriginMan在物理上不能做强化学习，也不证明所有其他算法或动作都失败；它说明本次实现与验证尚未满足所要求的稳定收益和实际落地。",
    ]
    (out / "RESULTS.md").write_text("\n".join(lines) + "\n")
    write_json(
        out / "receipt.json",
        {
            "planSha256": digest(plan_path),
            "reportSourceSha256": digest(Path(__file__)),
            "everySeedHasPositiveCountGain": all_gain,
            "hardwareValidated": False,
            "summarySha256": digest(out / "summary.json"),
            "figureSha256": digest(out / "three-seed.png"),
        },
    )
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--plan", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    build(a.root, a.plan, a.out)
