"""Tune conventional proprioceptive feedback, freeze it, then compare final RL.

Final cases are never loaded by the tuning entry point. Same physical model,
reference, amplitude/slew/effort limits and recovery criteria as residual RL.
No controller observes the push force, schedule or world translation.
"""

import argparse
from concurrent.futures import ProcessPoolExecutor
import gzip
import json
from pathlib import Path

import numpy as np
from scipy.stats import qmc
from scipy.optimize import differential_evolution

from env import Config
from evaluation_evidence import capture, finish
from monitor import digest, write_json
from residual_env import CONTROLLER, ResidualStandingGym
from sb3_evaluate import ArtifactPolicy
from sb3_receipt import verify
from standing_env import CRITERIA, StandingGym, episode


def feedback_features(bridge):
    """Roll/rate and physical ankle/hip mean offsets/rates, in SI units."""
    env = bridge.physical
    rotation, _ = env.orientation()
    index = np.array([4, 9, 0, 5])
    signs = env.model.jnt_axis[env.leg_j[index], 0]
    offsets = (env.data.qpos[env.qa[index]] - env.home[env.qa[index]]) * signs
    rates = env.data.qvel[env.va[index]] * signs
    return np.array([
        np.arctan2(rotation[2, 1], rotation[2, 2]),
        env.data.sensordata[0],
        np.mean(offsets[:2]), np.mean(rates[:2]),
        np.mean(offsets[2:]), np.mean(rates[2:]),
    ])


def conventional_action(features, coefficients, scale):
    """Four body PD gains and four same-joint position/velocity gains."""
    p = np.asarray(coefficients)
    if p.shape != (8,) or not np.isfinite(p).all():
        raise ValueError("expected eight finite feedback coefficients")
    roll, rate, ankle, ankle_rate, hip, hip_rate = features
    request = np.array([
        p[0] * roll + p[1] * rate + p[4] * ankle + p[5] * ankle_rate,
        p[2] * roll + p[3] * rate + p[6] * hip + p[7] * hip_rate,
    ])
    return np.clip(request / scale, -1, 1)


def actor(bridge, coefficients):
    return lambda obs: conventional_action(
        feedback_features(bridge), coefficients, bridge.physical.config.residual_scale
    )


def make_cases(forces, starts):
    return [
        {"force": sign * force, "start": start}
        for sign in [-1, 1] for force in forces for start in starts
    ] + [{"force": 0.0, "start": 2.3}]


def score(rows):
    # Recovery and retention, not RL reward, decide both tuning stages.
    return [
        int(all(r["recoverySuccess"] for r in rows if r["force"] == 0)),
        sum(r["recoverySuccess"] for r in rows),
        -sum(r["fallen"] for r in rows),
        float(np.mean([r["settledFraction"] for r in rows])),
        -float(np.mean([r["peakTiltDegrees"] for r in rows])),
        -float(np.mean([r["finalTiltDegrees"] for r in rows])),
    ]


_bridge = None
_cases = None


def initialize(scene, config, cases):
    global _bridge, _cases
    _bridge = StandingGym(Path(scene), Config(**config))
    _cases = cases


def trial(candidate):
    rows = [episode(_bridge, c, actor(_bridge, candidate["coefficients"])) for c in _cases]
    return {**candidate, "score": score(rows), "cases": rows}


def candidates():
    result = []

    def add(family, p):
        result.append({"id": len(result), "family": family, "coefficients": list(p)})

    add("original", [2.5, .225, 0, 0, 0, 0, 0, 0])
    for kp in [0, .5, 1, 2.5, 4, 6, 8]:
        for kd in [0, .1, .225, .45, .75]:
            add("ankle-pd", [kp, kd, 0, 0, 0, 0, 0, 0])
    for kp in [-6, -3, 0, 3, 6]:
        for kd in [-.8, -.4, 0, .4, .8]:
            add("hip-ankle-pd", [2.5, .225, kp, kd, 0, 0, 0, 0])
    points = qmc.Sobol(4, scramble=True, seed=9461).random_base2(7)
    for p in qmc.scale(points, [0, 0, -8, -1.2], [8, .9, 8, 1.2]):
        add("hip-ankle-pd", [*p, 0, 0, 0, 0])
    return result


def tune(root, out, workers):
    source = root / "standing-residual-seed7"
    cfg = json.loads((source / "training-summary.json").read_text())["config"]
    scene = source / "model/scene.xml"
    train = make_cases([6.6, 7.2, 7.8], [1.7, 2.9])
    validation = make_cases([6.9, 7.45, 8.05], [2.1, 3.5])
    out.mkdir(parents=True, exist_ok=False)
    capture(out, scene)
    initial = candidates()
    write_json(out / "tuning-plan.json", {
        "seed": 9461, "trainCases": train, "validationCases": validation,
        "initialCandidates": initial,
        "stages": "189 structured/Sobol candidates; 96 train-only local PD candidates; 128 joint-feedback candidates; top 8 per family on validation; freeze per-family and overall winners",
        "jointFeedbackSearch": "64 Sobol points across [-2,2] position and [-.5,.5] velocity feedback, attached to top 2 PD anchors",
        "localSearch": "top 4 train PD anchors, 24 seeded Gaussian perturbations each, std [.8,.08,1.2,.12], within original bounds",
        "selection": "lexicographic: no-force retention, recovered count, minus falls, mean terminal settled fraction, minus mean peak tilt, minus mean final tilt; ties lowest candidate id",
        "validationUse": "only ranks top 8 unique train candidates per family, never used for search; finite familiar simulation, no claim of blind task design",
        "testUse": "old 31-condition suite is known historical benchmark, not unseen; separate new suite is declared after tuning freezes, before evaluation",
        "config": cfg, "criteria": CRITERIA, "hardwareEligible": False,
        "limits": "same 0.3rad common amplitude, 0.25 normalized slew/20ms, same joint bounds/servo/effort/model; full non-RL hip authority allowed",
        "features": ["roll", "gyroX", "mean ankle roll offset", "mean ankle roll rate", "mean hip roll offset", "mean hip roll rate"],
        "coefficientOrder": ["ankle roll P", "ankle roll D", "hip roll P", "hip roll D", "ankle offset", "ankle rate", "hip offset", "hip rate"],
    })
    all_rows = []

    def evaluate_batch(batch, label):
        with ProcessPoolExecutor(workers, initializer=initialize, initargs=(str(scene), cfg, train)) as pool:
            for row in pool.map(trial, batch, chunksize=1):
                all_rows.append(row)
                with (out / "tuning-trials.jsonl").open("a") as f:
                    f.write(json.dumps(row, allow_nan=False) + "\n")
                if len(all_rows) % 16 == 0:
                    best = max(all_rows, key=lambda r: r["score"])
                    print(f"{label}: {len(all_rows)} candidates, train best {best['score'][1]}/{len(train)}", flush=True)

    evaluate_batch(initial, "coarse")
    anchors = sorted([r for r in all_rows if r["family"] != "original"], key=lambda r: r["score"], reverse=True)[:4]
    rng = np.random.default_rng(9462)
    batch = []
    for anchor in anchors:
        for _ in range(24):
            p = np.clip(np.asarray(anchor["coefficients"][:4]) + rng.normal(size=4) * [.8, .08, 1.2, .12], [0, 0, -8, -1.2], [8, .9, 8, 1.2])
            batch.append({"id": len(all_rows) + len(batch), "family": "hip-ankle-pd", "coefficients": [*p.tolist(), 0, 0, 0, 0]})
    evaluate_batch(batch, "local-pd")
    anchors = sorted(all_rows, key=lambda r: r["score"], reverse=True)[:2]
    points = qmc.scale(qmc.Sobol(4, scramble=True, seed=9463).random_base2(6), [-2, -.5, -2, -.5], [2, .5, 2, .5])
    batch = []
    for anchor in anchors:
        for p in points:
            batch.append({"id": len(all_rows) + len(batch), "family": "joint-feedback", "coefficients": [*anchor["coefficients"][:4], *p.tolist()]})
    evaluate_batch(batch, "joint-feedback")
    finalists = [all_rows[0]]
    for family in ["ankle-pd", "hip-ankle-pd", "joint-feedback"]:
        ranked = sorted([r for r in all_rows if r["family"] == family], key=lambda r: r["score"], reverse=True)
        seen = set()
        for r in ranked:
            key = tuple(r["coefficients"])
            if key in seen:
                continue
            seen.add(key)
            finalists.append({k: r[k] for k in ["id", "family", "coefficients"]})
            if len(seen) == 8:
                break
    write_json(out / "validation-plan.json", {"cases": validation, "finalists": finalists})
    with ProcessPoolExecutor(workers, initializer=initialize, initargs=(str(scene), cfg, validation)) as pool:
        valid = list(pool.map(trial, finalists))
    write_json(out / "validation-results.json", valid)
    winners = {family: max([r for r in valid if r["family"] == family], key=lambda r: r["score"]) for family in ["original", "ankle-pd", "hip-ankle-pd", "joint-feedback"]}
    best = max(valid, key=lambda r: r["score"])
    write_json(out / "frozen-feedback.json", {"selected": best, "families": winners, "tuningCandidateCount": len(all_rows), "validationCandidateCount": len(valid), "config": cfg, "sceneSha256": digest(scene), "hardwareEligible": False})
    finish(out, scene)
    print(json.dumps({"frozen": best["coefficients"], "family": best["family"], "validationScore": best["score"]}), flush=True)


def refine(root, previous, out, workers):
    """A separately recorded refinement, still before any new final comparison."""
    prior = json.loads((previous / "tuning-plan.json").read_text())
    cfg = prior["config"]
    scene = root / "standing-residual-seed7/model/scene.xml"
    out.mkdir(parents=True, exist_ok=False)
    capture(out, scene)
    write_json(out / "tuning-plan.json", {
        **prior,
        "previousTuningSha256": digest(previous / "frozen-feedback.json"),
        "refinement": "first 413 trials retained; 4D signed hip-ankle PD differential evolution: 40 population, 6 generations; 8D joint-feedback: 64 population, 6 generations; no polish; deterministic seeds 9464/9465; same train cases; final suites not opened",
        "refinementBounds": {"bodyP": [-8, 8], "bodyD": [-1.2, 1.2], "jointP": [-2, 2], "jointD": [-.5, .5]},
        "refinementObjective": "-1e6*normalRetention -1e4*recovered +1e3*falls -100*meanSettled +meanPeakTilt +.1*meanFinalTilt; same terminal recovery preference with continuous tiebreaks",
        "validationUse": "top 8 unique train candidates per family are reranked after search; validation remains a model selection set, not a fresh blind set",
    })
    rows = [json.loads(s) for s in (previous / "tuning-trials.jsonl").read_text().splitlines()]
    with (out / "tuning-trials.jsonl").open("w") as f:
        for row in rows:
            f.write(json.dumps(row, allow_nan=False)+"\n")
    for dim, population, seed, family in [(4,40,9464,"hip-ankle-pd"),(8,64,9465,"joint-feedback")]:
        lower = np.array([-8,-1.2,-8,-1.2,-2,-.5,-2,-.5])[:dim]
        upper = -lower
        rng = np.random.default_rng(seed)
        init = rng.uniform(lower, upper, (population,dim))
        ranked = sorted(rows,key=lambda r:r["score"],reverse=True)
        seen = set()
        anchors = []
        for r in ranked:
            key = tuple(r["coefficients"][:dim])
            if key in seen:
                continue
            seen.add(key)
            anchors.append(np.asarray(key))
            if len(anchors) == population//4:
                break
        for i, anchor in enumerate(anchors):
            init[i] = np.clip(anchor,lower,upper)
        for i in range(len(anchors), population//2):
            anchor = anchors[(i-len(anchors))%len(anchors)]
            init[i] = np.clip(anchor+rng.normal(size=dim)*(upper-lower)*.06,lower,upper)
        generation = [0]
        with ProcessPoolExecutor(workers, initializer=initialize, initargs=(str(scene),cfg,prior["trainCases"])) as pool:
            def mapped(_function, iterable):
                values=list(iterable)
                batch=[{"id":len(rows)+i,"family":family,"coefficients":[*np.asarray(p).tolist(), *([0]*(8-dim))]} for i,p in enumerate(values)]
                evaluated=list(pool.map(trial,batch,chunksize=1))
                with (out/"tuning-trials.jsonl").open("a") as f:
                    for r in evaluated:
                        f.write(json.dumps(r,allow_nan=False)+"\n")
                rows.extend(evaluated)
                generation[0]+=1
                best=max(rows,key=lambda r:r["score"])
                print(f"refine {family} generation {generation[0]}/7, total {len(rows)}, train best {best['score'][1]}/13",flush=True)
                return [-1e6*r["score"][0]-1e4*r["score"][1]-1e3*r["score"][2]-100*r["score"][3]-r["score"][4]-.1*r["score"][5] for r in evaluated]
            differential_evolution(lambda p:0, list(zip(lower,upper)),init=init,maxiter=6,polish=False,tol=0,atol=0,rng=np.random.default_rng(seed),workers=mapped,updating="deferred")
    finalists=[{k:rows[0][k] for k in ["id","family","coefficients"]}]
    for family in ["ankle-pd","hip-ankle-pd","joint-feedback"]:
        ranked=sorted([r for r in rows if r["family"]==family],key=lambda r:r["score"],reverse=True)
        seen=set()
        for r in ranked:
            key=tuple(r["coefficients"])
            if key in seen:
                continue
            seen.add(key)
            finalists.append({k:r[k] for k in ["id","family","coefficients"]})
            if len(seen)==8:
                break
    write_json(out/"validation-plan.json",{"cases":prior["validationCases"],"finalists":finalists})
    with ProcessPoolExecutor(workers,initializer=initialize,initargs=(str(scene),cfg,prior["validationCases"])) as pool:
        valid=list(pool.map(trial,finalists))
    write_json(out/"validation-results.json",valid)
    winners={family:max([r for r in valid if r["family"]==family],key=lambda r:r["score"]) for family in ["original","ankle-pd","hip-ankle-pd","joint-feedback"]}
    best=max(valid,key=lambda r:r["score"])
    write_json(out/"frozen-feedback.json",{"selected":best,"families":winners,"tuningCandidateCount":len(rows),"validationCandidateCount":len(valid),"config":cfg,"sceneSha256":digest(scene),"hardwareEligible":False})
    finish(out,scene)
    print(json.dumps({"frozen":best["coefficients"],"family":best["family"],"validationScore":best["score"]}),flush=True)


def evaluate(root, tuning, historical_plan, out):
    frozen = json.loads((tuning / "frozen-feedback.json").read_text())
    scene = root / "standing-residual-seed7/model/scene.xml"
    if digest(scene) != frozen["sceneSha256"]:
        raise ValueError("model differs from tuning")
    historical = json.loads(historical_plan.read_text())["cases"]
    new = make_cases([6.55, 6.95, 7.4, 7.75, 8.0], [1.83, 2.47, 3.37])
    new[-1]["start"] = 2.47
    used = {(c["force"], c["start"]) for key in ["trainCases", "validationCases"] for c in json.loads((tuning / "tuning-plan.json").read_text())[key]}
    assert not used.intersection((c["force"], c["start"]) for c in new)
    out.mkdir(parents=True, exist_ok=False)
    capture(out, scene)
    policies, hashes = {}, {}
    for seed in [7, 17, 27]:
        run = root / f"standing-residual-seed{seed}"
        if not verify(run)["verified"] or json.loads((run / "controller.json").read_text()) != CONTROLLER:
            raise ValueError("RL integrity/controller failure")
        if digest(run / "model/scene.xml") != digest(scene):
            raise ValueError("RL models differ")
        if json.loads((run / "training-summary.json").read_text())["config"] != frozen["config"]:
            raise ValueError("RL physical configurations differ")
        policies[f"rl-{seed}"] = ArtifactPolicy(run)
        hashes[f"rl-{seed}"] = {"policySha256": digest(run / "policy.onnx"), "normalizationSha256": digest(run / "normalization.json")}
    plan = {
        "suites": {"historical": historical, "new-fixed": new},
        "frozenFeedbackSha256": digest(tuning / "frozen-feedback.json"),
        "policies": hashes, "criteria": CRITERIA, "selectedFamily": frozen["selected"]["family"],
        "selection": "feedback selected on validation before final cases; RL final weights frozen, no retraining or replacement of RL base",
        "videoSelection": "lowest historical case index where selected conventional feedback and RL seed7 differ; otherwise case0; add lowest reverse-difference case when present",
        "scope": "new fixed conditions withheld from this conventional search, not proof of blind upstream task development or hardware performance",
        "hardwareEligible": False,
    }
    write_json(out / "plan.json", plan)
    bridge = StandingGym(scene, Config(**frozen["config"]))
    rl_bridge = ResidualStandingGym(scene, Config(**frozen["config"]))
    rows = []
    modes = ["original", "ankle-pd", "hip-ankle-pd", "joint-feedback", *policies]
    for suite, cases in plan["suites"].items():
        for index, case in enumerate(cases):
            for mode in modes:
                policy = policies.get(mode)
                current = rl_bridge if policy else bridge
                if policy:
                    policy.reset()
                controller = policy if policy else actor(current, frozen["families"][mode]["coefficients"])
                row = {"suite": suite, "caseIndex": index, "controller": mode, **episode(current, case, controller, trace=True)}
                rows.append(row)
                with gzip.open(out / "episodes.jsonl.gz", "at") as f:
                    f.write(json.dumps(row, allow_nan=False) + "\n")
            print(f"{suite} {index+1}/{len(cases)}", flush=True)
    summary = {}
    chosen = frozen["selected"]["family"]
    for suite, cases in plan["suites"].items():
        table = {mode: [r for r in rows if r["suite"] == suite and r["controller"] == mode] for mode in modes}
        summary[suite] = {}
        for mode, group in table.items():
            gains = [r["caseIndex"] for a, r in zip(table[chosen], group, strict=True) if r["recoverySuccess"] and not a["recoverySuccess"]]
            losses = [r["caseIndex"] for a, r in zip(table[chosen], group, strict=True) if a["recoverySuccess"] and not r["recoverySuccess"]]
            summary[suite][mode] = {"recovered": sum(r["recoverySuccess"] for r in group), "falls": sum(r["fallen"] for r in group), "cases": len(group), "normalStanding": all(r["recoverySuccess"] for r in group if r["force"] == 0), "gainIndicesVsSelectedFeedback": gains, "lossIndicesVsSelectedFeedback": losses, "meanPeakTiltDegrees": float(np.mean([r["peakTiltDegrees"] for r in group]))}
    write_json(out / "summary.json", {"selectedFeedbackFamily": chosen, "suites": summary, "hardwareEligible": False})
    for seed in [7, 17, 27]:
        run = root / f"standing-residual-seed{seed}"
        if digest(run / "policy.onnx") != hashes[f"rl-{seed}"]["policySha256"] or not verify(run)["verified"]:
            raise ValueError("RL artifacts changed during evaluation")
    if digest(tuning / "frozen-feedback.json") != plan["frozenFeedbackSha256"]:
        raise ValueError("feedback changed during evaluation")
    finish(out, scene)
    print(json.dumps({s: {m: v["recovered"] for m, v in table.items()} for s, table in summary.items()}), flush=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("command", choices=["tune", "refine", "evaluate"])
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--tuning", type=Path)
    p.add_argument("--historical-plan", type=Path)
    a = p.parse_args()
    if a.command == "tune":
        tune(a.root, a.out, a.workers)
    elif a.command == "refine":
        refine(a.root, a.tuning, a.out, a.workers)
    else:
        evaluate(a.root, a.tuning, a.historical_plan, a.out)
