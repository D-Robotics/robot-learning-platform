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
Training evaluates an exported checkpoint every 32,768 steps and at the budget
boundary. The first passing checkpoint ends the same run, whose results record
actual steps and use that exact ONNX and reference for replay. The 8,192-step
smoke budget is evaluated at its end.

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
