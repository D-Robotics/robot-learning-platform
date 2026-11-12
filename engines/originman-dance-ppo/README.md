# OriginMan dance PPO worker

This directory is the platform-owned home for the OriginMan full-body dance
environment. It uses a separately staged OriginMan MuJoCo bundle; model meshes
and hardware assets are not included in this repository. A worker must point
`RDK_ORIGINMAN_DANCE_BUNDLE_DIR` at a complete, non-symlink bundle containing
`model/scene.xml`, `model/model-manifest.json`, `model/meshes/`, and
`reference.npy`.

The training contract is simulation-only. The fixed model produces 18 policy
actions (the 20-joint robot's two head actuators are excluded) and every
choreography uses a fixed 78-value observation contract (up to eight section
slots). Hardware deployment is not
implemented by this adapter; full-body joint calibration, direction mapping,
limits, timing, policy parity, safety gates, and physical acceptance remain
separate requirements.

`body.py`, `env.py`, `dance_env.py`, and `train.py` provide the simulator,
learner-configurable choreography, PPO training, three-BPM style evaluation,
and a nominal-BPM replay trace. For `squat-rise`, the target reaches its lowest
point in the middle of the section and returns to the starting height at the
end. The evaluation reports `squatDescentM` and `squatAscentM` separately and
requires at least 24 mm in each direction. `adapter.py` implements the local worker's
file protocol and emits a checked ONNX policy. The platform run contract carries
the choreography under `training.originmanDance` and the worker receives it as
`task.originmanDance`.

Install the fully pinned environment with `uv pip install --require-hashes -r
requirements.txt`, then register the engine in `RDK_SIM2REAL_TRAIN_ENGINES_JSON`
using that environment's Python and `adapter.py`. Set
`RDK_ORIGINMAN_DANCE_BUNDLE_DIR` to the separately staged model bundle; the
worker refuses to train when any required file or mesh digest is invalid.
`/healthz` advertises registered engine IDs so the plugin can stop before
submission when this adapter is absent. An engine appearing in health does not
prove that its assets are valid; the first job performs that check and can fail
closed without producing a policy. `model-manifest.json` must include
`sceneSha256`, the exact SHA-256 of the mounted `scene.xml`; this verifies the
actual worker input. `sourceSceneSha256` remains separate lineage metadata and
is reported independently, so an adapted scene is never misreported as the
original source scene.

## Run on your own computer

Start the local training Worker and the standalone platform on the same
computer. In the Worker environment, register the engine and choose a device:

```sh
export RDK_SIM2REAL_TRAIN_ENGINES_JSON='{"originman-dance-ppo":{"executable":"/absolute/venv/bin/python","args":["/absolute/repo/engines/originman-dance-ppo/adapter.py"]}}'
export RDK_ORIGINMAN_DANCE_BUNDLE_DIR=/absolute/originman-bundle
export RDK_ORIGINMAN_DANCE_DEVICE=cpu
export RDK_SIM2REAL_LOCAL_RUNNER_TOKEN='<your local worker token>'
node services/sim2real-web/local-training-worker.mjs
```

Set `RDK_SIM2REAL_LOCAL_RUNNER_URL=http://127.0.0.1:19091/train` and the same
token in the standalone platform environment. Use the OriginMan dance model
contract and the `originman-dance-ppo` engine. To select this Worker through
the dance plugin, register its `/train` URL as a server Runner and test the
connection. A hosted platform needs a connection from its server to the
Worker. The dance plugin currently excludes browser-only relay resources.

`cpu` is the default. Use `cuda` with an NVIDIA GPU and a CUDA-enabled
PyTorch build, or `mps` with Apple Silicon and an MPS-enabled PyTorch build.
An explicitly requested accelerator must be available or the run fails.
The run records the actual PPO device as `metrics.trainingDevice`; MuJoCo
physics still runs on the CPU. CPU is a good starting point for this small
policy, where using a GPU can take longer.

The scene XML SHA-256 must exactly match the manifest's `sceneSha256`, which
is the digest of the actual mounted scene. `sourceSceneSha256` is a separate
lineage digest for the source asset and can differ when the scene has been
adapted; the worker reports both facts independently.

## Provenance and the 2026-11-11 serialization fix

First committed to the repository on 2026-11-11, snapshotted from the live
GPU-runner engine directory
`/root/rdk-originman-dance-validation-20261109/engine/originman-dance-ppo/`
(the runtime copy registered with the training worker). The runner remains
the execution surface; this copy is the canonical, version-controlled source.

Includes the 2026-11-11 fix for intermittent run failures after training:
evaluation reports can carry numpy scalars and (via the traced evaluation)
a `qpos` ndarray. `train.py` now selects the traced evaluation by qpos
presence instead of `bpms.index(bpm)` (BPM clamping to 80–140 collapses the
probe set and misaligned the index, leaving the ndarray in the report), and
all three JSON write sites (`evaluation.json`, `training-summary.json`,
`result.json`) serialize through `_json_default`, which converts numpy types
to built-ins while `allow_nan=False` keeps failing closed on NaN.
