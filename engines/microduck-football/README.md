# MicroDuck Football (MuJoCo prototype)

This package adds the next task after the upstream blind ball-kick task:

* `single-goal-kick`: one duck observes the ball and drives it through the
  opponent goal;
* `soccer-2v2` and `soccer-3v3`: the same field and ball with shared team
  reward, opponent agents, and a batched PPO trainer.

The platform engine intentionally uses a **high-level duck controller**
(`forward`, `strafe`, `turn`, `kick`) around a MuJoCo body. It is a runnable
task and training contract, not a claim that the 3D full-body MicroDuck policy
is already solved. The adapter boundary is explicit so the controller can be
replaced by the 14-servo `microduck-policy-v1` actor after the task reward is
validated.

The field layout and training split follow the same ideas used by the open
source MicroDuck RL stack (`pollen-robotics/microduck_rl`) and MuJoCo Soccer:
centralized state during training, local observations for each duck, dense
ball-to-goal shaping, and goal termination. The repository's existing
`engines/microduck-eval` remains the authority for full-body MicroDuck ONNX
evaluation. The platform adapter records both dimensions explicitly: football
training is 20/24D → 4D, while the real actor contract is 61D → 14D. This keeps
a high-level football checkpoint from being mistaken for a deployable 14-servo
policy.

## Run a MuJoCo smoke rollout

```bash
python3 engines/microduck-football/train_football.py \
  --task single-goal-kick --iterations 2 --num-envs 8 --steps-per-env 64 \
  --out /tmp/microduck-football-smoke.json
```

Use `--device cuda` on the GPU worker. A run writes JSON metrics, a PyTorch
checkpoint, and (with `--export`) a portable TorchScript actor. The kick impulse
is goal-facing in the MuJoCo proxy, so the learner is evaluated on actual ball
contact, goal detection, batching, and PPO updates rather than a random-action
protocol check. The smoke command is deliberately small; it is not enough
budget to certify a policy.

For a longer run with an exported actor:

```bash
python3 engines/microduck-football/train_football.py \
  --task single-goal-kick --device cuda --num-envs 256 \
  --steps-per-env 128 --iterations 60 \
  --out training-summary.json --checkpoint policy.pt --export policy.ts
python3 engines/microduck-football/evaluate_policy.py \
  --policy policy.ts --episodes 200 --out evaluation.json
```

The deterministic chase controller is useful as a task sanity check before
training:

```bash
python3 engines/microduck-football/evaluate_football.py \
  --task single-goal-kick --episodes 20
```

## Task IDs

| task | agents | controlled side | observation/action |
| --- | ---: | --- | --- |
| `single-goal-kick` | 1 | blue | 20 / 4 |
| `soccer-2v2` | 4 | blue (2) | 24 / 4 per duck |
| `soccer-3v3` | 6 | blue (3) | 24 / 4 per duck |

The opponent is scripted for the first milestone. Self-play and centralized
critic training are the next step after the single-agent reward is stable.

The first GPU smoke evidence is checked in under `evidence/`: RTX 4090,
`cuda=true`, 64 parallel single-agent worlds (3 iterations) and 32 parallel
2v2 worlds (2 iterations). The deterministic single-agent sanity controller
scored 3/10 goals in the same scene. These are pipeline evidence, not a
converged policy claim.

## Real MicroDuck actor

`real_microduck_demo.py` loads the upstream `scene_ball.xml` and an exported
MicroDuck ONNX actor, then reuses the platform evaluator's 61D observation
assembly, 14D joint action order, calibrated `bam-ctrl` actuator, and 50 Hz
step cadence. The command used on the GPU host was:

```bash
xvfb-run -a python real_microduck_demo.py \
  --model-root /root/microduck_rl \
  --policy /root/microduck-football/microduck-ball-kick-14d.onnx \
  --out microduck-real-14d-football.mp4
```

The resulting real-actor render is recorded in
`evidence/microduck-real-14d-football.mp4`. The five-iteration checkpoint is a
smoke policy for validating the 61D→14D and actuator path; it is not yet a
goal-scoring football policy.
