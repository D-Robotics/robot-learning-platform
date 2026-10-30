"""Report all final cases, including reduced locomotion and failures."""

import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from monitor import digest, write_json


def build(evaluation, run, transfer):
    summary = json.loads((evaluation / "summary.json").read_text())
    rows = [
        json.loads(line)
        for line in (evaluation / "episodes.jsonl").read_text().splitlines()
    ]
    baseline = [r for r in rows if r["force"] == 0]
    names = list(summary)
    fig, axes = plt.subplots(1, 3, figsize=(12, 4))
    colors = ["#53758b", "#7a8d60", "#cf674e"]
    series = [
        (
            [summary[n]["walkingSuccesses"] for n in names],
            "Completed walking task",
            "Cases / 25",
        ),
        ([summary[n]["falls"] for n in names], "Falls (less is better)", "Cases / 25"),
        (
            [
                next(r["forwardM"] * 100 for r in baseline if r["controller"] == n)
                for n in names
            ],
            "No push: forward distance",
            "cm in 8 seconds",
        ),
    ]
    for ax, (values, title, ylabel) in zip(axes, series):
        bars = ax.bar(names, values, color=colors)
        ax.bar_label(bars, fmt="%.1f", padding=3)
        ax.set_ylim(0, max(max(values) * 1.25, 1))
        if ylabel == "Cases / 25":
            ax.set_ylim(0, 25)
        ax.set_title(title)
        ax.set_ylabel(ylabel)
        ax.tick_params(axis="x", rotation=15)
    fig.suptitle(
        "OriginMan disturbance recovery: frozen final PPO, 25 predeclared cases\nSimulation only; fewer falls do not count as success if walking is lost",
        fontsize=12,
    )
    fig.tight_layout()
    fig.savefig(evaluation / "comparison.png", dpi=160)
    plt.close(fig)
    lines = [
        "# OriginMan 受扰行走第二轮结果",
        "",
        "结论：当前训练方案不合格，不作为 workshop 核心 RL 演示。尚未证明机器人硬件不具备该能力。",
        "",
        "## 固定最终权重的比较",
        "",
        "训练600轮、8个环境、每轮128步；未按最终测试结果挑选检查点。25个新测试条件在训练完成前预先固定，原13个看过的条件降为开发/回归检查。每个场景在相同物理条件下比较。",
        "",
        "![完整指标对照](comparison.png)",
        "",
        "|控制器|完成行走任务|跌倒|平均前进/cm|",
        "|---|---:|---:|---:|",
    ]
    lines += [
        f"|{n}|{summary[n]['walkingSuccesses']}/25|{summary[n]['falls']}/25|{summary[n]['meanForwardM'] * 100:.2f}|"
        for n in names
    ]
    lines += [
        "",
        "成功必须同时满足：完整8秒不跌倒、前进至少15cm、左右腿各至少5帧单支撑。仅站稳或少走不算成功。",
        "",
        "无扰动时，参考步态前进约26cm，RL约9cm。因此跌倒次数减少不能解释为有效抗扰收益。",
        "",
        "IMU反馈基线在64组有限参数搜索后选择零补偿。它不代表所有经典控制算法的最优性能，也不能据此声称RL超越经典控制。",
        "",
        "## 模型与证据",
        "",
        "本轮脚底使用原始碰撞STL凸包；质量、惯量和关节来源不变，保留独立IK脚部坐标。物理步长1ms，控制周期20ms。执行器和接触仍为未实测参数；姿态与关节观测仍理想化。",
        "",
        "扰动为躯干质心的有限时长侧向力，策略不能读取力值。力的范围只是仿真条件，不能转换为真机抗推指标。",
        "",
        "首轮300轮试验同样失败，已保留；本轮修订学习回报缩放、KL限制和奖励用因果速度平滑，没有修改最终成功判据。",
        "",
        "## 迁移检查",
        "",
        "九个单因素物理配置、每个13个开发/回归条件，共351个控制器回合。冻结权重与反馈参数，不在迁移条件重新训练或调参。这些参数范围不是制造商测量结果。",
        "",
        "|物理配置|参考成功|RL成功|",
        "|---|---:|---:|",
    ]
    transfers = json.loads((transfer / "summary.json").read_text())
    for profile in dict.fromkeys(r["profile"] for r in transfers):
        reference = next(
            r
            for r in transfers
            if r["profile"] == profile and r["controller"] == "reference"
        )
        rl = next(
            r for r in transfers if r["profile"] == profile and r["controller"] == "rl"
        )
        lines.append(f"|{profile}|{reference['successes']}/13|{rl['successes']}/13|")
    lines += [
        "",
        "## 下一项必须解决的问题",
        "",
        "先让训练保留无扰动参考步态，再要求扰动恢复收益。不能继续只提高存活、降低动作幅度而损失行走能力。需要检查残差约束、策略与值函数训练的相互影响，以及观测对受扰状态是否充分。",
        "",
        "只有保留正常迈步并在独立场景稳定改善后，才扩展多种子验证；本轮不进入真机部署。暂无样机，实际落地仍未验证。",
        "",
        "完整数据：episodes.jsonl、plan.json、final-plan-receipt.json；训练配置和源码、模型快照在对应训练目录。视频first-case.mp4固定重放第一个测试条件，包含失败，不挑最好片段。",
    ]
    (evaluation / "RESULTS.md").write_text("\n".join(lines) + "\n")
    write_json(
        evaluation / "report-receipt.json",
        {
            "sourceSha256": digest(Path(__file__)),
            "trainingSummarySha256": digest(run / "training-summary.json"),
            "transferSummarySha256": digest(transfer / "summary.json"),
            "files": {
                name: digest(evaluation / name)
                for name in [
                    "summary.json",
                    "episodes.jsonl",
                    "RESULTS.md",
                    "comparison.png",
                    "plan.json",
                    "final-plan-receipt.json",
                ]
            },
        },
    )


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--evaluation", type=Path, required=True)
    p.add_argument("--run", type=Path, required=True)
    p.add_argument("--transfer", type=Path, required=True)
    a = p.parse_args()
    build(a.evaluation, a.run, a.transfer)
