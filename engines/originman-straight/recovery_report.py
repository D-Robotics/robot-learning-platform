"""Summarize a recovery trial without hiding individual regressions."""

import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from monitor import digest, verify_run, write_json


def build(evaluation, run, transfer=None):
    summary = json.loads((evaluation / "summary.json").read_text())
    rows = [
        json.loads(line)
        for line in (evaluation / "episodes.jsonl").read_text().splitlines()
    ]
    names = list(summary)
    pairs = [rows[i : i + 3] for i in range(0, len(rows), 3)]
    if any([r["controller"] for r in pair] != names for pair in pairs):
        raise ValueError("expected consistent paired controller order")
    count = len(pairs)
    zero = {r["controller"]: r for r in rows if r["force"] == 0}
    successes = [
        i
        for i, p in enumerate(pairs)
        if not p[0]["walkingSuccess"] and p[2]["walkingSuccess"]
    ]
    regressions = [
        i
        for i, p in enumerate(pairs)
        if p[0]["walkingSuccess"] and not p[2]["walkingSuccess"]
    ]
    experiment = json.loads((run / "experiment.json").read_text())["experiment"]
    cfg = experiment["environment"]
    fig, axes = plt.subplots(1, 3, figsize=(12, 4))
    colors = ["#53758b", "#7a8d60", "#cf674e"]
    series = [
        (
            [summary[n]["walkingSuccesses"] for n in names],
            "Completed walking task",
            f"Cases / {count}",
        ),
        ([summary[n]["falls"] for n in names], "Falls", f"Cases / {count}"),
        (
            [zero[n]["forwardM"] * 100 for n in names],
            "No disturbance: forward distance",
            "cm",
        ),
    ]
    for ax, (values, title, ylabel) in zip(axes, series):
        bars = ax.bar(names, values, color=colors)
        ax.bar_label(bars, fmt="%.1f", padding=3)
        ax.set_ylim(0, count if ylabel.startswith("Cases") else max(values) * 1.25)
        ax.set_title(title)
        ax.set_ylabel(ylabel)
        ax.tick_params(axis="x", rotation=15)
    fig.suptitle(
        f"OriginMan: {run.name} | all {count} fixed final scenarios\nSimulation only; improved cases and regressions are both retained",
        fontsize=12,
    )
    fig.tight_layout()
    fig.savefig(evaluation / "comparison.png", dpi=160)
    plt.close(fig)
    result = {
        "cases": count,
        "improvedCaseIndices": successes,
        "regressedCaseIndices": regressions,
        "normalForwardRetention": zero["rl"]["forwardM"]
        / zero["reference"]["forwardM"],
        "successCountGain": summary["rl"]["walkingSuccesses"]
        - summary["reference"]["walkingSuccesses"],
        "trainingIntegrity": verify_run(run),
        "hardwareValidated": False,
    }
    write_json(evaluation / "assessment.json", result)
    lines = [
        "# OriginMan 受扰行走对照",
        "",
        f"实验：`{run.name}`；训练{experiment['training']['iterations']}轮，固定最终权重比较{count}个预先声明的条件。",
        "",
        "![指标对照](comparison.png)",
        "",
        "|控制器|完成行走|跌倒|平均前进/cm|无扰动前进/cm|",
        "|---|---:|---:|---:|---:|",
    ]
    lines += [
        f"|{n}|{summary[n]['walkingSuccesses']}/{count}|{summary[n]['falls']}/{count}|{summary[n]['meanForwardM'] * 100:.2f}|{zero[n]['forwardM'] * 100:.2f}|"
        for n in names
    ]
    lines += [
        "",
        "完成行走必须同时满足完整回合不跌倒、前进至少15cm、左右腿各至少5帧单支撑；没有降低成功标准。",
        f"接管配置：侧倾阈值{cfg.get('recovery_roll_threshold', 0)}rad，侧倾角速度阈值{cfg.get('recovery_rate_threshold', 0)}rad/s；持续时间{cfg.get('recovery_hold_seconds', 0)}s。",
        "",
        f"参考失败而RL成功的条件编号：{successes}。参考成功而RL失败的条件编号：{regressions}。编号从0开始，完整数据见episodes.jsonl。",
        "",
        "## RL与参考控制的分工",
        "",
        "基础迈步由参考轨迹产生。姿态和角速度超过阈值时，固定接管逻辑开放RL关节残差；接管逻辑不读取外部推力，不生成恢复动作。RL仍须学习如何协调关节完成恢复。",
        "",
        "正常行走保留来自参考轨迹与接管逻辑，不能将它单独算作RL收益。只有相同条件下额外恢复成功的动作，才是当前策略的效果证据；整体收益必须结合退化场景判断。",
        "",
        "IMU反馈基线只完成有限参数搜索，选出的参数见feedback.json；不代表所有经典控制方法的最优性能。",
        "",
        "## 全部条件",
        "",
        "|编号|侧向力/N|开始/s|参考|RL|RL前进/cm|",
        "|---:|---:|---:|---|---|---:|",
    ]
    for i, pair in enumerate(pairs):
        a, _, b = pair
        lines.append(
            f"|{i}|{a['force']}|{a['start']}|{'成功' if a['walkingSuccess'] else '失败'}|{'成功' if b['walkingSuccess'] else '失败'}|{b['forwardM'] * 100:.2f}|"
        )
    if transfer:
        data = json.loads((transfer / "summary.json").read_text())
        lines += [
            "",
            "## 冻结控制器的物理参数检查",
            "",
            "这些是已使用的开发/回归条件；单因素参数范围没有实物测量依据，不是新的独立最终测试或真机成功率。",
            "",
            "|配置|参考成功|RL成功|",
            "|---|---:|---:|",
        ]
        for profile in dict.fromkeys(r["profile"] for r in data):
            a = next(
                r
                for r in data
                if r["profile"] == profile and r["controller"] == "reference"
            )
            b = next(
                r for r in data if r["profile"] == profile and r["controller"] == "rl"
            )
            lines.append(
                f"|{profile}|{a['successes']}/{a['cases']}|{b['successes']}/{b['cases']}|"
            )
    lines += [
        "",
        "## 当前证据边界",
        "",
        f"无扰动前进距离保留比例为{result['normalForwardRetention']:.1%}；完整成功场景净增加{result['successCountGain']}个。单个恢复例子不能替代总体和多种子结论。",
        "",
        "当前仍是理想观测、未实测执行器和接触的仿真。尚未验证机载状态估计、通信时序或实际动作，不能标记为已落地。",
        "",
        "视频improvement.mp4和regression.mp4若存在，分别展示从完整结果中选出的改善与退化例子，不能视为所有场景表现。源码、模型、参数和权重快照保留在对应训练目录。",
    ]
    (evaluation / "RESULTS.md").write_text("\n".join(lines) + "\n")
    write_json(
        evaluation / "report-receipt.json",
        {
            "sourceSha256": digest(Path(__file__)),
            "inputSha256": {
                name: digest(evaluation / name)
                for name in ["summary.json", "episodes.jsonl", "plan.json"]
            },
            "outputSha256": {
                name: digest(evaluation / name)
                for name in ["RESULTS.md", "comparison.png", "assessment.json"]
            },
        },
    )
    print(
        json.dumps({k: v for k, v in result.items() if k != "trainingIntegrity"}),
        flush=True,
    )


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--evaluation", type=Path, required=True)
    p.add_argument("--run", type=Path, required=True)
    p.add_argument("--transfer", type=Path)
    a = p.parse_args()
    build(a.evaluation, a.run, a.transfer)
