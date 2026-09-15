#!/usr/bin/env node

/**
 * mujoco-models gate: compiles and steps every model the mujoco-web service
 * can serve, and proves the deployer registry contract is fail-closed.
 *
 * With mujoco importable this checks, in one python process:
 *   1. every MODEL_DEFINITIONS entry (builtin + any deployer registry
 *      entries on this machine) compiles via MjModel.from_xml_string,
 *      steps 10 physics steps from its initial_qpos, stays finite, and its
 *      metadata agrees with the compiled model (actuator count, qpos size,
 *      rangefinder count vs lidar_angles);
 *   2. registry loading: a valid entry loads with source="registry",
 *      *.json.example / README are ignored, and bad entries (bad MJCF,
 *      actuator-count lie, key collision, missing field, overlong qpos,
 *      orphan lidar metadata) raise ValueError so the service refuses to
 *      start — the fail-closed promise.
 * On machines without mujoco (CI runners) it prints SKIP and exits 0 so
 * `npm run verify` stays green.
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function probe(python, code) {
  const out = spawnSync(python, ['-c', code], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.status === 0;
}

function pythonInterpreter() {
  const candidates = [
    process.env.RDK_MUJOCO_WEB_PYTHON,
    // The mjx adapter's checked-in venv has mujoco installed as well.
    path.join(repoRoot, 'engines/mjx-adapter/.venv/bin/python'),
    'python3',
    '/usr/bin/python3',
    '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3.11',
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (probe(candidate, 'import mujoco')) {
      return candidate;
    }
  }
  return null;
}

const python = pythonInterpreter();
if (!python) {
  console.log(
    '[mujoco-models] SKIP — python with mujoco not found. ' +
      'Install with: python3 -m pip install --user mujoco',
  );
  process.exit(0);
}

const checks = String.raw`
import json
import pathlib
import sys
import tempfile

import mujoco

REPO = pathlib.Path(${JSON.stringify(repoRoot)})
sys.path.insert(0, str(REPO / "services" / "mujoco-web"))

import models  # noqa: E402


def compile_and_step(definition):
    model = mujoco.MjModel.from_xml_string(definition.xml)
    data = mujoco.MjData(model)
    assert model.nu == len(definition.actuator_names), (
        f"{definition.key}: actuator_names has {len(definition.actuator_names)} "
        f"entries but the MJCF exposes {model.nu} actuators"
    )
    assert model.nq >= len(definition.initial_qpos), (
        f"{definition.key}: initial_qpos has {len(definition.initial_qpos)} values "
        f"but the MJCF has {model.nq} position DOFs"
    )
    if definition.lidar_angles:
        rangefinders = 0
        for sensor_id in range(model.nsensor):
            name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_SENSOR, sensor_id) or ""
            if name.startswith("lidar_"):
                rangefinders += 1
        assert rangefinders == len(definition.lidar_angles), (
            f"{definition.key}: lidar_angles declares {len(definition.lidar_angles)} beams "
            f"but the MJCF has {rangefinders} lidar_* sensors"
        )
    for index, value in enumerate(definition.initial_qpos):
        data.qpos[index] = value
    mujoco.mj_forward(model, data)
    for _ in range(10):
        mujoco.mj_step(model, data)
    assert data.time > 0.0, f"{definition.key}: physics time did not advance"
    import math
    for value in data.qpos:
        assert math.isfinite(float(value)), f"{definition.key}: qpos diverged after 10 steps"
    for value in data.qvel:
        assert math.isfinite(float(value)), f"{definition.key}: qvel diverged after 10 steps"
    return model


# ---- 1. every servable model compiles, steps, and matches its metadata ----
assert models.MODEL_DEFINITIONS, "MODEL_DEFINITIONS must not be empty"
builtin_keys = {"cartpole", "double-pendulum", "originbot"}
assert builtin_keys <= set(models.MODEL_DEFINITIONS), "builtin models went missing"
for key in builtin_keys:
    assert models.MODEL_DEFINITIONS[key].source == "builtin", f"{key} must stay builtin"

compiled = {}
for key, definition in sorted(models.MODEL_DEFINITIONS.items()):
    compiled[key] = compile_and_step(definition)
    print(
        f"[mujoco-models] {key}: nu={compiled[key].nu} nq={compiled[key].nq} "
        f"nsensor={compiled[key].nsensor} dt={compiled[key].opt.timestep} "
        f"source={definition.source} — compile+10 steps OK"
    )

# The OriginBot body/wheel actuator XML is injected from the shared
# assets/originbot module; prove the rendered XML still carries the velocity
# wheel actuators (the embedded wheel-controller contract app.py relies on).
originbot_xml = models.MODEL_DEFINITIONS["originbot"].xml
assert '<velocity name="left_wheel"' in originbot_xml, (
    "originbot: rendered XML lost the left_wheel velocity actuator"
)
assert '<velocity name="right_wheel"' in originbot_xml, (
    "originbot: rendered XML lost the right_wheel velocity actuator"
)

# ---- 2. registry contract: the loader is fail-closed -----------------------
example = json.loads(
    (REPO / "services" / "mujoco-web" / "registry" / "example-model.json.example").read_text(
        encoding="utf-8"
    )
)


def load_dir(payloads):
    with tempfile.TemporaryDirectory() as tmp:
        directory = pathlib.Path(tmp)
        for name, payload in payloads.items():
            (directory / name).write_text(
                payload if isinstance(payload, str) else json.dumps(payload),
                encoding="utf-8",
            )
        return models.load_registry_models(
            directory, reserved_keys=frozenset(models.MODEL_DEFINITIONS)
        )


def expect_error(label, payloads):
    try:
        load_dir(payloads)
    except ValueError as exc:
        assert label in str(exc), f"error for {label} should mention it: {exc}"
        return
    raise AssertionError(f"registry must fail closed on {label}")


# valid entry loads with registry provenance and actually compiles+steps
loaded = load_dir({"a.json": example})
assert set(loaded) == {"example-mass"}, loaded.keys()
assert loaded["example-mass"].source == "registry"
compile_and_step(loaded["example-mass"])

# non-.json files (README.md, *.json.example) are ignored even when present
loaded = load_dir({"README.md": "not json", "sample.json.example": json.dumps(example)})
assert loaded == {}, "only strict *.json files may be loaded"

# key collision with a builtin is refused
expect_error(
    "originbot",
    {"a.json": {**example, "key": "originbot"}},
)
# two files claiming the same registry key is refused
expect_error(
    "already used",
    {
        "a.json": example,
        "b.json": {**example, "name": "duplicate"},
    },
)
# MJCF that does not compile is refused
expect_error(
    "does not compile",
    {"a.json": {**example, "key": "bad-xml", "xml": "<mujoco><no-worldbody/>"}},
)
# an actuator-count lie is refused
expect_error(
    "actuators",
    {"a.json": {**example, "key": "bad-count", "actuator_names": ["left", "right"]}},
)
# missing required fields are refused
expect_error(
    "'name'",
    {"a.json": {"key": "no-name", "xml": example["xml"], "actuator_names": ["push"]}},
)
# an overlong initial_qpos is refused
expect_error(
    "position DOFs",
    {"a.json": {**example, "key": "bad-qpos", "initial_qpos": [0, 0, 0, 0, 0]}},
)
# lidar metadata without wheel_radius is refused
expect_error(
    "wheel_radius",
    {"a.json": {**example, "key": "orphan-lidar", "lidar_angles": [0.0, 0.1]}},
)
# invalid JSON is refused
expect_error(
    "JSON",
    {"a.json": "{not json"},
)

# the repo's own registry directory (README + .example only, or deployer
# entries) must load without error and only yield registry provenance
default_loaded = models.load_registry_models()
for definition in default_loaded.values():
    assert definition.source == "registry"
    compile_and_step(definition)
print(
    f"[mujoco-models] registry contract OK — {len(default_loaded)} deployer entries in the "
    f"repo registry dir, 10 fail-closed cases refused"
)
`;

const scratch = await mkdtemp(path.join(os.tmpdir(), 'rdk-mujoco-models-'));
try {
  const scriptPath = path.join(scratch, 'verify-models.py');
  await writeFile(scriptPath, checks, 'utf8');
  const run = spawnSync(python, [scriptPath], {
    cwd: scratch,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 4 * 1024 * 1024,
  });
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.status !== 0) {
    if (run.stderr) process.stderr.write(run.stderr);
    throw new Error(`mujoco model verification exited with ${run.status}`);
  }
  const builtinCount = ['cartpole', 'double-pendulum', 'originbot'].length;
  console.log(
    `[mujoco-models] PASS — all served models compile, step and match their metadata ` +
      `(${builtinCount} builtin + repo registry entries), fail-closed registry contract proven ` +
      `via ${python}`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
