"""Isolated classroom preparation, training and paired evaluation; simulation only."""

import argparse
import html
import json
import math
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

from monitor import digest, write_json

HERE = Path(__file__).resolve().parent


def prepare(workspace, scene, seed=7, steps=500000, push_max_force=8.1):
    workspace, scene = Path(workspace).resolve(), Path(scene).resolve()
    if not scene.is_file():
        raise ValueError("caller-owned adapted scene.xml required")
    if (
        seed < 0
        or steps < 1
        or not math.isfinite(push_max_force)
        or not 6.4 <= push_max_force <= 9
    ):
        raise ValueError(
            "seed >= 0, steps >= 1, training push maximum in [6.4, 9] N required"
        )
    experiment = json.loads((HERE / "experiments/standing-residual.json").read_text())
    experiment["environment"]["push_max_force"] = push_max_force
    run_name = f"standing-residual-seed{seed}"
    plan = json.loads((HERE / "workshop/benchmark.json").read_text())
    plan.update(declaredAt=datetime.now(UTC).isoformat(), plannedRuns=[run_name])
    workspace.mkdir(parents=True, exist_ok=False)
    write_json(workspace / "experiment.json", experiment)
    write_json(workspace / "benchmark.json", plan)
    session = {
        "createdAt": plan["declaredAt"],
        "scene": str(scene),
        "sceneSha256": digest(scene),
        "experimentSha256": digest(workspace / "experiment.json"),
        "benchmarkSha256": digest(workspace / "benchmark.json"),
        "seed": seed,
        "steps": steps,
        "runName": run_name,
        "hardwareEligible": False,
        "scope": "New training from zero correction. Reused classroom benchmark, not unseen-test evidence. Short training need not pass.",
    }
    write_json(workspace / "session.json", session)
    return session


def session(workspace):
    workspace = Path(workspace).resolve()
    data = json.loads((workspace / "session.json").read_text())
    for name, key in [
        ("experiment.json", "experimentSha256"),
        ("benchmark.json", "benchmarkSha256"),
    ]:
        if digest(workspace / name) != data[key]:
            raise ValueError("prepared configuration changed; prepare a new workspace")
    return workspace, data


def train(workspace):
    from sb3_receipt import seal

    workspace, data = session(workspace)
    if digest(Path(data["scene"])) != data["sceneSha256"]:
        raise ValueError("prepared scene changed; prepare a new workspace")
    subprocess.run(
        [
            sys.executable,
            str(HERE / "residual_trial.py"),
            "--scene",
            data["scene"],
            "--experiment",
            str(workspace / "experiment.json"),
            "--out",
            str(workspace / data["runName"]),
            "--seed",
            str(data["seed"]),
            "--steps",
            str(data["steps"]),
        ],
        check=True,
    )
    run = workspace / data["runName"]
    summary = json.loads((run / "training-summary.json").read_text())
    if summary["sourceChangedDuringRun"]:
        raise ValueError(
            "source changed during training; keep evidence and create a new experiment"
        )
    receipt = seal(run)
    if not receipt["verified"]:
        raise ValueError("post-training integrity verification failed")
    return receipt


def evaluate(workspace):
    workspace, data = session(workspace)
    subprocess.run(
        [
            sys.executable,
            str(HERE / "residual_evaluate.py"),
            "--run",
            str(workspace / data["runName"]),
            "--plan",
            str(workspace / "benchmark.json"),
            "--out",
            str(workspace / "evaluation"),
        ],
        check=True,
    )
    return report(workspace / "evaluation", workspace / "report")


def report(evaluation, out):
    """Render actual paired outcomes without assuming the student policy improved."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    evaluation, out = Path(evaluation).resolve(), Path(out).resolve()
    summary = json.loads((evaluation / "summary.json").read_text())
    rows = [
        json.loads(s) for s in (evaluation / "episodes.jsonl").read_text().splitlines()
    ]
    modes = ["imu-feedback", "untrained", "rl", "rl-frozen-correction"]
    groups = {mode: [r for r in rows if r["controller"] == mode] for mode in modes}
    plan = json.loads((evaluation / "plan.json").read_text())
    cases = plan["cases"]
    if len(cases) != 31 or any(len(g) != 31 for g in groups.values()):
        raise ValueError("complete 31-case classroom evaluation required")
    for group in groups.values():
        if any(
            (r["force"], r["start"]) != (c["force"], c["start"])
            for r, c in zip(group, cases, strict=True)
        ):
            raise ValueError("paired cases are missing or reordered")
    for mode, group in groups.items():
        counts = summary["controllers"][mode]
        if counts["recoverySuccesses"] != sum(
            r["recoverySuccess"] for r in group
        ) or counts["falls"] != sum(r["fallen"] for r in group):
            raise ValueError("summary disagrees with episode records")
    improvements = [
        i
        for i, (a, b) in enumerate(
            zip(groups["imu-feedback"], groups["rl"], strict=True)
        )
        if b["recoverySuccess"] and not a["recoverySuccess"]
    ]
    regressions = [
        i
        for i, (a, b) in enumerate(
            zip(groups["imu-feedback"], groups["rl"], strict=True)
        )
        if a["recoverySuccess"] and not b["recoverySuccess"]
    ]
    dynamic = sum(
        b["recoverySuccess"] and not a["recoverySuccess"]
        for a, b in zip(groups["rl-frozen-correction"], groups["rl"], strict=True)
    )
    clear = bool(
        len(improvements) - len(regressions) >= plan["minimumClearGainConditions"]
        and groups["rl"][-1]["recoverySuccess"]
        and dynamic >= 3
    )
    if (
        summary["improvementIndices"] != improvements
        or summary["regressionIndices"] != regressions
        or summary["clearGain"] != clear
    ):
        raise ValueError("claimed learning gain disagrees with paired episodes")
    out.mkdir(parents=True, exist_ok=False)
    write_json(out / "summary.json", summary)
    write_json(out / "benchmark.json", plan)
    write_json(
        out / "provenance.json",
        {
            "evaluationFiles": {
                name: digest(evaluation / name)
                for name in [
                    "summary.json",
                    "episodes.jsonl",
                    "plan.json",
                    "evaluation-runtime.json",
                ]
            },
            "scope": "Classroom rendering of existing evaluation, not a new evaluation or independent attestation",
            "hardwareEligible": False,
        },
    )
    labels = ["PD baseline", "PD + initial RL", "PD + trained RL", "PD + frozen RL"]
    fig, ax = plt.subplots(figsize=(9, 4), layout="constrained")
    values = [summary["controllers"][m]["recoverySuccesses"] for m in modes]
    ax.barh(labels, values, color=["#8b969e", "#aab4b8", "#187d83", "#b98653"])
    ax.set(
        xlim=(0, 33),
        xlabel="Recovered conditions / 31",
        title="Same model, same 31 perturbation conditions",
    )
    ax.invert_yaxis()
    for i, value in enumerate(values):
        ax.text(value + 0.3, i, str(value), va="center")
    fig.savefig(out / "comparison.png", dpi=145)
    plt.close(fig)
    body = []
    for i, case in enumerate(cases):
        cells = []
        for mode in modes:
            r = groups[mode][i]
            cells.append(
                "恢复" if r["recoverySuccess"] else "跌倒" if r["fallen"] else "未恢复"
            )
        body.append(
            f"<tr><td>{i}</td><td>{case['force']:+g} N</td><td>{case['start']:g} s</td>"
            + "".join(f"<td>{x}</td>" for x in cells)
            + "</tr>"
        )
    gain = values[2] - values[0]
    verdict = (
        "达到本轮明显收益判据"
        if summary["clearGain"]
        else "本轮未达到明显收益判据；保留结果并分析"
    )
    page = f"""<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OriginMan 学员评测</title><style>body{{max-width:1050px;margin:40px auto;padding:0 20px;font:17px/1.7 system-ui;color:#18323a}}img{{width:100%}}table{{border-collapse:collapse;width:100%}}td,th{{padding:8px;border-bottom:1px solid #ddd;text-align:left}}.scroll{{overflow:auto}}</style>
<h1>OriginMan 学员评测</h1><p>{verdict}。相对基础反馈净变化：{gain:+d}/31。</p>
<p>改善条件：{html.escape(str(summary["improvementIndices"]))}；退化条件：{html.escape(str(summary["regressionIndices"]))}。</p>
<img src="comparison.png" alt="四种控制器的恢复条件数"><p>这些是重复使用的课堂测试条件，不是真机成功率，也不证明未见扰动泛化。奖励升高和没有跌倒均不能替代最终恢复判据。</p>
<div class="scroll"><table><thead><tr><th>条件</th><th>侧推</th><th>开始</th><th>基础</th><th>未训练</th><th>训练后</th><th>冻结输出</th></tr></thead><tbody>{"".join(body)}</tbody></table></div>
<p><a href="summary.json">完整统计</a> · <a href="benchmark.json">评测条件</a> · <a href="provenance.json">输入摘要</a></p><p>原始逐步轨迹位于同一实验目录的 evaluation/episodes.jsonl。仿真策略不具备硬件部署资格。</p></html>"""
    (out / "index.html").write_text(page)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("--workspace", type=Path, required=True)
    p.add_argument("--scene", type=Path, required=True)
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--steps", type=int, default=500000)
    p.add_argument("--push-max-force", type=float, default=8.1)
    for name in ["train", "evaluate"]:
        sub.add_parser(name).add_argument("--workspace", type=Path, required=True)
    p = sub.add_parser("report")
    p.add_argument("--evaluation", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "prepare":
        result = prepare(
            args.workspace, args.scene, args.seed, args.steps, args.push_max_force
        )
    elif args.command == "train":
        result = train(args.workspace)
    elif args.command == "evaluate":
        result = evaluate(args.workspace)
    else:
        result = report(args.evaluation, args.out)
    if result is not None:
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
