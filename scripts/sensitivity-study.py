#!/usr/bin/env python3
"""Hyperparameter sensitivity study for the task-pack quality gate.

Research question: how fragile is the release verdict (successRate CI
lower bound >= 0.7, collisionRate CI upper bound <= 0.15) to the reward
weights and the PPO hyperparameters? A gate that flips on a +-20% weight
nudge is not evidence — it is luck.

Method: train short-budget runs (150 iterations, 32 envs — about 45 s
each on a laptop CPU) around the shipped OriginBot task pack, sweeping
one factor at a time while holding the seed fixed, then report each
run's nominal-envelope point rate, Wilson CI floor, and verdict. The
seed is fixed per factor level so differences come from the factor, not
from sampling noise.

Run (development machine, CPU):
  python3 scripts/sensitivity-study.py [outdir]

Writes sensitivity-report.json into outdir (default: the script's own
tmp dir) and prints a table.
"""

import copy
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
RUNNER = os.path.join(REPO, "engines", "starter-ppo", "runner.py")

sys.path.insert(0, os.path.join(REPO, "engines", "starter-ppo"))
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location("starter_runner", RUNNER)
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)

BASE_ITERATIONS = 150
BASE_ENVS = 32

# One factor at a time around the shipped values. Each entry:
# (label, mutation on the task pack).
def task_variants(base):
    reward = base["reward"]
    return [
        ("baseline (shipped weights)",
         lambda p: p),
        ("progress x0.8", lambda p: mutate_reward(p, "progress", 0.8)),
        ("progress x1.2", lambda p: mutate_reward(p, "progress", 1.2)),
        ("goal x0.8", lambda p: mutate_reward(p, "goal", 0.8)),
        ("goal x1.2", lambda p: mutate_reward(p, "goal", 1.2)),
        ("collision x0.8 (=-4)", lambda p: mutate_reward(p, "collision", 0.8)),
        ("collision x1.2 (=-6)", lambda p: mutate_reward(p, "collision", 1.2)),
        ("actionPenalty x5 (=-0.05)", lambda p: mutate_reward(p, "actionPenalty", 5.0)),
        ("goalDistance 0.10 (harder termination)",
         lambda p: mutate_key(p, ("termination", "goalDistance"), 0.10)),
        ("timeout 160 (harder budget)",
         lambda p: mutate_key(p, ("termination", "timeoutSteps"), 160)),
    ]


def mutate_reward(pack, key, scale):
    pack = copy.deepcopy(pack)
    pack["reward"][key] = round(pack["reward"][key] * scale, 4)
    return pack


def mutate_key(pack, path, value):
    pack = copy.deepcopy(pack)
    node = pack
    for part in path[:-1]:
        node = node[part]
    node[path[-1]] = value
    return pack


def load_base_pack():
    with open(os.path.join(REPO, "tasks", "originbot-goal-navigation.json")) as handle:
        task = json.load(handle)
    with open(os.path.join(REPO, "adapters", "rdk-originbot.json")) as handle:
        adapter = json.load(handle)
    pack = dict(task)
    pack.update({
        "kind": "goal-navigation",
        "adapter": adapter,
        "controlHz": 10,
        "physicsTimestepSeconds": 0.02,
        "decimation": 1,
        "seed": 7,
    })
    return pack


def run_variant(label, mutate, outdir):
    pack = mutate(load_base_pack())
    request = {
        "schemaVersion": 1,
        "contract": {
            "id": "sensitivity", "robotId": pack["adapter"]["id"],
            "observationSize": 8, "actionSize": 2, "controlHz": 10,
            "physicsTimestepSeconds": 0.02, "decimation": 1,
        },
        "model": {"modelId": "sensitivity-{}".format(label.replace(" ", "-")), "version": "0.1"},
        "training": {"profile": "low-vram", "numEnvs": BASE_ENVS,
                     "maxIterations": BASE_ITERATIONS, "video": False},
        "task": pack,
    }
    os.environ["RDK_STARTER_ENGINE_DEVICE"] = "cpu"
    workdir = tempfile.mkdtemp(prefix="sensitivity-")
    old_cwd = os.getcwd()
    os.chdir(workdir)
    try:
        result = runner.train(request)
    finally:
        os.chdir(old_cwd)
    report = json.load(open(os.path.join(workdir, "eval-report.json")))
    nominal = report["trained"]["envelopes"]["nominal"]
    return {
        "label": label,
        "successRate": nominal["successRate"],
        "successRateCiLow": nominal["successRateCiLow"],
        "collisionRate": nominal["collisionRate"],
        "collisionRateCiHigh": nominal["collisionRateCiHigh"],
        "episodes": nominal["episodes"],
        "gatePassed": report["qualityGate"]["passed"],
        "trainingSeconds": result["metrics"].get("trainingSeconds"),
    }


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="sensitivity-out-")
    base = load_base_pack()
    rows = []
    for label, mutate in task_variants(base):
        row = run_variant(label, mutate, outdir)
        rows.append(row)
        print("[sensitivity] {:36s} success={:.2f} (CI low {:.2f}) collision={:.2f} gate={}".format(
            label, row["successRate"], row["successRateCiLow"], row["collisionRate"],
            "PASS" if row["gatePassed"] else "FAIL"))
    passing = sum(1 for row in rows if row["gatePassed"])
    summary = {
        "date": "2026-09-10",
        "taskId": "originbot-goal-navigation",
        "method": "one-factor-at-a-time, fixed seed 7, {} iterations x {} envs per run".format(BASE_ITERATIONS, BASE_ENVS),
        "budgetNote": "short-budget probe: absolute rates are lower than the shipped 400-iteration record; the signal is the SPREAD across factor levels, not the levels",
        "rows": rows,
        "verdicts": {
            "runsTotal": len(rows),
            "runsPassed": passing,
            "gateFlipCount": sum(
                1 for row in rows
                if row["gatePassed"] != rows[0]["gatePassed"]
            ),
            "successCiLowMin": min(row["successRateCiLow"] for row in rows),
            "successCiLowMax": max(row["successRateCiLow"] for row in rows),
        },
        "conclusion": "",
    }
    spread = summary["verdicts"]["successCiLowMax"] - summary["verdicts"]["successCiLowMin"]
    summary["conclusion"] = (
        "CI floor spread across all factor levels: {:.2f}; gate flips: {} / {} runs. ".format(
            spread, summary["verdicts"]["gateFlipCount"], len(rows))
        + ("The verdict is robust to single +-20% weight perturbations at this budget."
           if summary["verdicts"]["gateFlipCount"] == 0 else
           "The verdict flips under at least one perturbation — treat the shipped weights as load-bearing and pin them in review.")
    )
    out_path = os.path.join(outdir, "sensitivity-report.json")
    with open(out_path, "w") as handle:
        json.dump(summary, handle, indent=2)
    print("[sensitivity] report written: {}".format(out_path))
    print("[sensitivity] {}".format(summary["conclusion"]))


if __name__ == "__main__":
    main()
