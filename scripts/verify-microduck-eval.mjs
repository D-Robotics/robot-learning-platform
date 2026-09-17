#!/usr/bin/env node
/**
 * Contract check for engines/microduck-eval — no GPU, and no MuJoCo required.
 *
 * The evaluator's whole job is to be *readable*: a success rate is only valid
 * inside a pinned envelope, with a Wilson bound the platform's own gate
 * recomputes, and with the dynamics/actuator that produced it written down.
 * Those are pure-logic properties, so they are pinned here and fail on a laptop
 * instead of silently drifting on the machine that runs real evaluations.
 *
 * Usage: node scripts/verify-microduck-eval.mjs
 *   RDK_MICRODUCK_EVAL_PYTHON   python with mujoco+onnxruntime (default python3)
 *   RDK_MICRODUCK_RL_DIR        microduck_rl checkout (default ~/microduck_rl)
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVAL_DIR = path.join(ROOT, 'engines', 'microduck-eval');
const PYTHON = process.env.RDK_MICRODUCK_EVAL_PYTHON || 'python3';
const MODEL_ROOT = process.env.RDK_MICRODUCK_RL_DIR || path.join(os.homedir(), 'microduck_rl');

/**
 * Shared TypeScript is consumed through its build output when present, and
 * through tsx otherwise — same pattern as verify-vision-observation.mjs.
 */
async function loadShared(relative) {
  const built = path.join(ROOT, 'dist-server', 'shared', relative.replace(/\.ts$/, '.js'));
  if (fs.existsSync(built)) return import(pathToFileURL(built).href);
  const tsx = await import('tsx/esm/api').catch(() => null);
  // tsx 4 exports `tsImport`, not `import`; the latter silently does not exist,
  // which would make this fallback dead code for every script that uses it.
  if (!tsx?.tsImport) throw new Error(`cannot load shared/${relative}: no build output and no tsx`);
  return tsx.tsImport(path.join(ROOT, 'shared', relative), import.meta.url);
}

const { normalizeTaskEvaluationEvidence } = await loadShared('task-evaluation.ts');

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
  }
}

function runPython(args, options = {}) {
  return execFileSync(PYTHON, args, {
    cwd: EVAL_DIR,
    encoding: 'utf8',
    // A probe that fails to import is an expected outcome, not noise: keep its
    // traceback out of the report and let the caller decide what it means.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    ...options,
  });
}

function pythonJson(code) {
  return JSON.parse(runPython(['-c', code]).trim());
}

// ── 1. The report contract: a rate without its envelope is not evidence ──────
check('contract constants are pinned (envelope seeds, episodes, thresholds)', () => {
  const payload = pythonJson(`
import json
from microduck_eval.envelope import NOMINAL, HARD
from microduck_eval.tasks import BallKickTask, VelocityTask
print(json.dumps({
  "nominalSeed": NOMINAL.seed,
  "hardSeed": HARD.seed,
  "nominalEpisodes": NOMINAL.episodes,
  "nominalBall": NOMINAL.initial_state.ball_distance,
  "hardPayload": HARD.payload_fraction,
  "hardGyro": HARD.gyro_noise_std,
  "ballKick": BallKickTask().definition,
  "velocity": VelocityTask().definition,
}))`);
  assert.equal(payload.nominalSeed, 20260916);
  assert.notEqual(payload.nominalSeed, payload.hardSeed);
  // The platform release gate refuses fewer than 30 episodes per envelope
  // (server/sim2real/release-evidence.ts); the shipped envelopes must satisfy it.
  assert.ok(payload.nominalEpisodes >= 30, 'nominal envelope needs >= 30 episodes');
  assert.ok(payload.nominalBall > 0, 'ball-kick envelope must place the ball');
  assert.ok(payload.hardPayload > 0 && payload.hardGyro > 0, 'hard envelope must disturb');
  assert.ok(payload.ballKick.minBallTravelM > 0 && payload.ballKick.minPeakBallSpeedMps > 0);
  assert.ok(payload.velocity.speedToleranceMps > 0);
  return `nominal ${payload.nominalEpisodes} eps, ball ${payload.nominalBall} m`;
});

// ── 2. Wilson parity with the platform's own formula ────────────────────────
check('Wilson interval matches the platform formula and refuses empty evidence', () => {
  const payload = pythonJson(`
import json
from microduck_eval.wilson import wilson_bounds
cases = [(0,50),(35,50),(50,50),(1,100),(17,30)]
print(json.dumps({
  "bounds": [wilson_bounds(*case) for case in cases],
  "cases": cases,
  "empty": wilson_bounds(0, 0),
}))`);
  const z = 1.959963984540054;
  payload.cases.forEach(([successes, total], index) => {
    const p = successes / total;
    const denom = 1 + (z * z) / total;
    const centre = (p + (z * z) / (2 * total)) / denom;
    const spread = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
    const [low, high] = payload.bounds[index];
    assert.ok(
      Math.abs(low - (centre - spread)) < 5e-9,
      `low bound drift for ${successes}/${total}`,
    );
    assert.ok(
      Math.abs(high - (centre + spread)) < 5e-9,
      `high bound drift for ${successes}/${total}`,
    );
  });
  assert.equal(payload.empty, null, 'zero episodes must not read as 0% or 100%');
  return `${payload.cases.length} cases exact`;
});

// ── 3. Task verdicts are physical, not reward-shaped ────────────────────────
check('ball-kick verdict needs travel, speed and balance together', () => {
  const payload = pythonJson(`
import json
from microduck_eval.envelope import NOMINAL
from microduck_eval.tasks import BallKickTask, EpisodeTrace

def trace(base_z, ball_x, dt=0.02):
    tr = EpisodeTrace(dt=dt)
    for i in range(len(base_z)):
        tr.base_z.append(base_z[i]); tr.base_xy.append((0.0, 0.0))
        tr.body_pitch.append(0.0); tr.body_roll.append(0.0)
        tr.ball_xy.append((ball_x[i], 0.0)); tr.ball_z.append(0.035)
        tr.ground_contact.append(False)
    return tr

task = BallKickTask()
upright = [0.118]*200
kicked = [0.0]*60 + [0.05*i for i in range(140)]
fallen = [0.118]*100 + [0.03]*100
nudged = [0.0]*195 + [0.05]*5
print(json.dumps({
  "kicked": task.judge(trace(upright, kicked), NOMINAL).success,
  "fallen": task.judge(trace(fallen, kicked), NOMINAL).success,
  "nudged": task.judge(trace(upright, nudged), NOMINAL).success,
}))`);
  assert.equal(payload.kicked, true, 'a kicked ball with the duck upright is a success');
  assert.equal(payload.fallen, false, 'falling must void the kick');
  assert.equal(payload.nudged, false, 'a 5 cm nudge is not a kick');
  return 'travel + speed + balance all enforced';
});

// ── 4. Harness qualification fails closed ───────────────────────────────────
check('an unqualified harness cannot certify anything', () => {
  const payload = pythonJson(`
import json
from microduck_eval.envelope import NOMINAL
from microduck_eval.metrics import EnvelopeResult, EpisodeResult, harness_qualification
from microduck_eval.tasks import EpisodeOutcome

def baseline(falls, episodes):
    result = EnvelopeResult(envelope=NOMINAL)
    for i in range(episodes):
        fell = i < falls
        result.episodes.append(EpisodeResult(index=i, seed=i, outcome=EpisodeOutcome(
            success=False, fall=fell, collision=fell, reward=0.0, length_seconds=4.0,
            metrics={"minBaseHeightM": 0.03 if fell else 0.118})))
    return result

print(json.dumps({
  "allFall": harness_qualification([baseline(10, 10)])["passed"],
  "someStand": harness_qualification([baseline(2, 10)])["passed"],
  "noBaseline": harness_qualification([])["passed"],
}))`);
  assert.equal(payload.allFall, false);
  assert.equal(payload.someStand, true);
  assert.equal(payload.noBaseline, false);
  return 'fail-closed on all three paths';
});

// ── 4b. Declarative task specs stay equivalent to the built-in tasks ────────
check('shipped task specs reproduce the built-in thresholds and envelopes', () => {
  const payload = pythonJson(`
import json, pathlib
from microduck_eval.task_spec import load_task_spec
from microduck_eval.tasks import BallKickTask, VelocityTask

specs = pathlib.Path("task-specs")
out = {}
for name, builtin in (("ball-kick", BallKickTask()), ("walking-velocity", VelocityTask())):
    task, envelopes = load_task_spec(specs / (name + ".json"))
    out[name] = {
        "thresholdsMatch": all(
            abs(task.definition[key] - value) < 1e-9 for key, value in builtin.definition.items()
        ),
        "envelopes": sorted(envelopes),
        "forwardSpeed": envelopes["nominal"].command.lin_vel_x,
        "episodes": envelopes["nominal"].episodes,
    }
task, envelopes = load_task_spec(specs / "duck-stand.json")
out["newTask"] = {"id": task.task_id, "kind": task.kind, "parameters": sorted(task.parameters)}
print(json.dumps(out))
`);
  for (const name of ['ball-kick', 'walking-velocity']) {
    assert.equal(
      payload[name].thresholdsMatch,
      true,
      `${name}: spec drifted from the built-in task`,
    );
    assert.deepEqual(payload[name].envelopes, ['hard', 'nominal']);
    assert.ok(payload[name].episodes >= 30, `${name}: envelope is below the release gate's floor`);
  }
  assert.equal(payload['walking-velocity'].forwardSpeed, 0.4);
  // A task family that exists only as a spec is the whole extensibility claim.
  assert.equal(payload.newTask.id, 'duck-stand');
  assert.equal(payload.newTask.kind, 'hold');
  return `4 specs checked, new kind available: ${payload.newTask.kind}`;
});

check('a malformed task spec is rejected, never defaulted', () => {
  const payload = pythonJson(`
import json
from microduck_eval.task_spec import parse_task_spec, TaskSpecError

def probe(payload):
    try:
        parse_task_spec(payload, source="probe")
        return "accepted"
    except TaskSpecError:
        return "rejected"

base = {
    "schemaVersion": 1, "id": "t", "kind": "hold",
    "parameters": {"maxDriftM": 0.05, "fallHeightM": 0.06, "fallTiltRad": 1.05},
    "envelopes": {"nominal": {"episodes": 5}},
}
def variant(**changes):
    out = json.loads(json.dumps(base))
    out.update(changes)
    return out

print(json.dumps({
    "ok": probe(base),
    "badKind": probe(variant(kind="basketball")),
    "badParam": probe(variant(parameters={"maxDriftM": 9.0, "fallHeightM": 0.06, "fallTiltRad": 1.0})),
    "badEnvelope": probe(variant(envelopes={"dream": {}})),
    "badId": probe(variant(id="../escape")),
}))
`);
  assert.equal(payload.ok, 'accepted');
  for (const key of ['badKind', 'badParam', 'badEnvelope', 'badId']) {
    assert.equal(payload[key], 'rejected', `${key} was not rejected`);
  }
  return 'fail-closed on kind/params/envelope/id';
});

// ── 5. Evidence from the platform side: measurements survive normalization ──
check('platform normalization keeps measurements and promotes fall rate', () => {
  const normalized = normalizeTaskEvaluationEvidence({
    taskId: 'ball-kick',
    adapterId: 'microduck-cpu-eval',
    trained: {
      envelopes: {
        nominal: {
          episodes: 50,
          successRate: 0,
          successRateCiLow: 0,
          fallRate: 1,
          fallRateCiLow: 0.9287,
          meanEpisodeLength: 4,
          ballTravelM: 0,
          ballPeakSpeedMps: 0.31,
          minBaseHeightM: 0.0425,
          'bad-key': 3,
          ignored: 'text',
        },
      },
    },
  });
  const nominal = normalized?.trained?.envelopes?.nominal;
  assert.ok(nominal, 'microduck evidence must survive the boundary');
  assert.equal(nominal.fallRate, 1);
  assert.equal(nominal.meanEpisodeLength, 4);
  assert.deepEqual(nominal.measurements, {
    ballTravelM: 0,
    ballPeakSpeedMps: 0.31,
    minBaseHeightM: 0.0425,
  });
  assert.equal(nominal.measurements['bad-key'], undefined);
  assert.equal(nominal.measurements.ignored, undefined);
  return 'measurements preserved, junk rejected';
});

// ── 6. Shipped evidence must be self-describing ─────────────────────────────
check('every shipped evidence report carries its dynamics and actuator facts', () => {
  const dir = path.join(EVAL_DIR, 'evidence');
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.ok(files.length > 0, 'no evidence reports are shipped');
  for (const file of files) {
    const report = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const facts = report.dynamicsFacts;
    assert.ok(facts, `${file}: dynamicsFacts missing`);
    for (const key of ['dynamics', 'actuator', 'sceneSha256', 'policySha256', 'controlHz']) {
      assert.ok(facts[key] !== undefined, `${file}: dynamicsFacts.${key} missing`);
    }
    assert.equal(facts.dynamics, 'cpu-mujoco');
    assert.ok(facts.jointOrderVerified === true, `${file}: joint order was never verified`);
    assert.ok(report.harnessQualification, `${file}: harness qualification missing`);
    assert.ok(report.qualityGate, `${file}: quality gate missing`);
    const nominal = report.trained?.envelopes?.nominal;
    assert.ok(nominal && nominal.episodes >= 30, `${file}: nominal envelope too small`);
  }
  return `${files.length} report(s) self-describing`;
});

// ── 7. Live rollout, only where a usable harness interpreter exists ─────────
// The engine needs MuJoCo *and* a Python the package imports under (3.12+).
// Rather than guess from `python3 --version`, ask it to import the package the
// same way the rollout will — a wrong interpreter must SKIP, not crash.
function harnessUsable() {
  try {
    runPython([
      '-c',
      'import mujoco, onnxruntime, numpy, microduck_eval.sim, microduck_eval.report',
    ]);
    return true;
  } catch {
    return false;
  }
}

if (!harnessUsable()) {
  results.push({
    name: 'live rollout (calibrated actuator holds the standing baseline)',
    ok: true,
    detail:
      `SKIP — ${PYTHON} cannot import mujoco+onnxruntime+microduck_eval; ` +
      'run with RDK_MICRODUCK_EVAL_PYTHON pointing at engines/microduck-eval/.eval-venv/bin/python',
    skipped: true,
  });
} else if (!fs.existsSync(path.join(MODEL_ROOT, 'src', 'mjlab_microduck', 'robot', 'microduck'))) {
  results.push({
    name: 'live rollout (calibrated actuator holds the standing baseline)',
    ok: true,
    detail: `SKIP — no microduck_rl checkout at ${MODEL_ROOT}`,
    skipped: true,
  });
} else {
  check('live rollout: calibrated actuator holds the standing baseline', () => {
    const payload = pythonJson(`
import json
from microduck_eval.envelope import NOMINAL
from microduck_eval.report import ZeroPolicy
from microduck_eval.sim import MicroDuckSim, find_scene, rollout
import numpy as np

spec = find_scene(${JSON.stringify(MODEL_ROOT)}, with_ball=False)
sim = MicroDuckSim(spec)
command = np.asarray(NOMINAL.command.as_vector(), dtype=np.float32)
trace = rollout(sim, ZeroPolicy(), NOMINAL, command, episode_index=0)
fell = next((i for i, z in enumerate(trace.base_z) if z < 0.08), None)
print(json.dumps({
  "fallSeconds": None if fell is None else fell * trace.dt,
  "minBaseHeightM": min(trace.base_z),
  "calibratedKp": sim.actuator_facts["calibratedKp"],
  "forceCeilingNm": sim.actuator_facts["forceCeilingNm"],
  "sceneKp": sim.actuator_facts["sceneKp"],
}))`);
    assert.equal(
      payload.fallSeconds,
      null,
      `zero-action baseline fell with the calibrated gains (kp=${payload.calibratedKp})`,
    );
    assert.ok(payload.minBaseHeightM > 0.09, `trunk too low: ${payload.minBaseHeightM} m`);
    assert.ok(
      payload.calibratedKp > payload.sceneKp,
      'the scene default kp is the placeholder value; calibration must raise it',
    );
    return `kp ${payload.sceneKp} -> ${payload.calibratedKp}, ceiling ${payload.forceCeilingNm} N·m, trunk ${payload.minBaseHeightM.toFixed(3)} m`;
  });
}

const failed = results.filter((item) => !item.ok);
for (const item of results) {
  const marker = item.ok ? (item.skipped ? '○' : '✓') : '✗';
  console.log(`${marker} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
}
if (failed.length) {
  console.error(`\n${failed.length} microduck-eval contract check(s) failed`);
  process.exit(1);
}
console.log('\nmicroduck-eval contract verified');
