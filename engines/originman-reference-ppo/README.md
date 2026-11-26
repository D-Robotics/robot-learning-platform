# OriginMan reference trajectory tracking

In the OriginMan Workshop choose **参考轨迹跟跳**. Import a 50 Hz NPZ with
`joint_names`, `joint_pos`, `joint_vel` and `fps`, import the same fields as
schema-version 1 JSON, or load the included four-second arm movement.
Positions are offsets from the reference stance, in radians. The first two
channels are the fixed head channels. The metadata keeps the file order,
actuator policy order, and physical servo number separate.

The task runs on the existing validated OriginMan MuJoCo bundle. The new
calibration profile records which data came from `originman-rl-pack.zip` and
which servo directions or angle scales still lack direct measurement. The
simulator applies its contact parameters, PD gains, effort limit, stance
and actuator lag. Simulation retains the 1 ms scene step and executes one
policy action every 20 ms. The source pack lists a distinct training step and
decimation. Its exact training clock and external MJLab implementation require
the source environment.

The adapter first runs the same trajectory through a zero-residual controller,
both with the reference calibration and with the existing scene parameters.
Then PPO learns reference-conditioned residual commands. The result policy
takes 96 values and emits 18 normalized corrections in the tracked joint order.
The evaluator runs the exported ONNX on the same reference; completion, tilt
below 32° and absolute terminal yaw below 5° determine the gate. The page also
reports mean tracking error. An ONNX is downloadable for completed simulation
runs even when the quality gate fails. This version is scoped to simulation.
Training evaluates a checkpoint every 32,768 steps and at the budget
boundary. Preset and action-group compositions finish the selected budget.
The Workshop offers 8,192 steps for a quick check and up to 1,998,848 steps for
full-length training. Steps are shared by the parallel environments. Each
environment starts the sequence at its first frame, and a fall may end it
early. An uploaded trajectory can stop at the first passing checkpoint. The worker
selects the best evaluation by pass status, frame coverage, tracking error and
tilt, then exports its ONNX and matching replay. The results record both total
training steps and the exported checkpoint's step count.

Use the workbench's physical screen on the current trajectory or a group of up
to eight files. The selected account Worker checks each reference through the
calibrated zero-residual simulation and returns frame counts, peak tilt, early
failure frame and input digests. Screening creates no training run.

Register `originman-reference-ppo` in the Worker
`RDK_SIM2REAL_TRAIN_ENGINES_JSON` with an absolute Python executable and this
directory's `adapter.py`. Stage both OriginMan engine directories and
`plugins/rdk-robot-learning-platform/references/originman-reference-calibration.json`
in the same layout. Reuse the pinned OriginMan dance Python environment, its
bundle at `RDK_ORIGINMAN_DANCE_BUNDLE_DIR`, and a working offscreen MuJoCo
renderer plus FFmpeg. The engine uses CUDA when available with
`RDK_ORIGINMAN_DANCE_DEVICE=auto`. Run the connection test after updating
the Worker so the platform has current engine capabilities. Allow up to 16 MiB
on the authenticated OriginMan reference upload and screening paths if a reverse
proxy imposes a lower limit. Other training uploads use the standard limit.

## Workshop reference choreography

The Workshop and the Studio MCP can preview an existing preset or an ordered
list of motion IDs with repeat counts. The platform compiles the same references
at submission, checks the preview SHA-256 and records the recipe and source
digests with the Run. Free compositions support up to 12,000 frames at 50 Hz
(240 seconds), including transitions. Approved full-length presets retain their
recorded timing within the same frame budget. The simulation reports tracking
RMSE, completion for each action occurrence and ONNX parity. The legacy dance
recipe and the direct reference file upload retain their contracts.

The built-in catalog includes a teaching example. To enable an approved shared
library, prepare a source `catalog.json` with `schemaVersion: 1`, `motions` and
`presets`. Each motion needs `id`, `file` (a sibling 50 Hz NPZ or JSON),
`displayName`, and `category`. Set `clipped` if the source was scaled. Each
preset needs `id`, `displayName`, `bpm`, and ordered `blocks` with `id` and
optional `repeats`, plus optional `transitionSeconds`. Run
`python scripts/import-originman-motion-library.py catalog.json /absolute/output`
with NumPy available, then set `RDK_ORIGINMAN_MOTION_DIR` on the platform service
to the output directory. Use a directory outside the public web root. This
library is available to signed-in learners. Individual source recordings can
also be uploaded directly from the reference page for an account's own Run.

The public plugin uses the model bundle already configured on the selected
Worker. For a new Worker, use the [dance engine bundle generator](../originman-dance-ppo/README.md)
with a converted model supplied by the operator.
