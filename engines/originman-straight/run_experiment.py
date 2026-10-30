"""One immutable experiment: training, then separate paired test evaluation."""

import argparse
import json
from pathlib import Path

from evaluate import evaluate
from monitor import parse_experiment, seal_run, write_json
from train import train

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--scene", required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--experiment", type=Path, required=True)
    p.add_argument("--parent-run")
    p.add_argument("--warm-start")
    a = p.parse_args()
    cfg, learner, budget = parse_experiment(json.loads(a.experiment.read_text()))
    a.out.mkdir(parents=True, exist_ok=True)
    try:
        write_json(a.out / "pipeline-status.json", {"state": "training"})
        train(
            a.scene,
            a.out,
            config=cfg,
            learner=learner,
            parent=a.parent_run,
            warm_start=a.warm_start,
            **budget,
        )
        write_json(a.out / "pipeline-status.json", {"state": "evaluating"})
        evaluate(
            str(a.out / "model/scene.xml"), a.out / "policy.onnx", a.out, episodes=30
        )
        write_json(a.out / "pipeline-status.json", {"state": "completed"})
        seal_run(a.out, "evaluation")
    except BaseException as exc:
        write_json(
            a.out / "pipeline-status.json",
            {
                "state": "cancelled"
                if isinstance(exc, KeyboardInterrupt)
                else "failed",
                "error": str(exc),
            },
        )
        if (a.out / "experiment.json").exists():
            seal_run(a.out, "evaluation")
        raise
