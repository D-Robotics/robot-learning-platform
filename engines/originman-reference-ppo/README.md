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

Register `originman-reference-ppo` in the Worker
`RDK_SIM2REAL_TRAIN_ENGINES_JSON` with an absolute Python executable and this
directory's `adapter.py`. Stage both OriginMan engine directories and
`plugins/rdk-robot-learning-platform/references/originman-reference-calibration.json`
in the same layout. Reuse the pinned OriginMan dance Python environment, its
bundle at `RDK_ORIGINMAN_DANCE_BUNDLE_DIR`, and a working offscreen MuJoCo
renderer plus FFmpeg. The engine uses CUDA when available with
`RDK_ORIGINMAN_DANCE_DEVICE=auto`. Run the connection test after updating
the Worker so the platform has current engine capabilities. Large trajectory
transfers are subject to the platform's 2 MiB JSON request limit.
