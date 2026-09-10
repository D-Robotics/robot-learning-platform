#!/usr/bin/env python3
"""rsl-rl worker adapter: one file protocol, two physics backends.

Implements the platform worker protocol (read RDK_SIM2REAL_REQUEST_FILE,
write RDK_SIM2REAL_RESULT_FILE) around an rsl_rl OnPolicyRunner:

  * physicsBackend "mjlab" — the real path. When mjlab is importable the
    adapter builds your vectorized physics environment through
    build_mjlab_env() and trains the full-contact dynamics with PPO.
  * physicsBackend "starter-kinematic" — the honest fallback. Without
    mjlab/mujoco the adapter wraps the platform's own vectorized
    goal-navigation environment (engines/starter-ppo) in the rsl_rl VecEnv
    interface, so the PPO algorithm, export, and quality gate all run for
    real; the result says so (result.physicsBackend, metrics.physicsBackend)
    so nobody can mistake a kinematic run for contact-dynamics training.

The contract in the request is the one the platform validated against the
manifest, so both backends must build the env with exactly those dimensions
(observation_size, action_size, control Hz / decimation); a mismatch is a
contract violation, never a tuning choice.

Register with the local worker:

  RDK_SIM2REAL_TRAIN_EXECUTABLE=/usr/bin/python3
  RDK_SIM2REAL_TRAIN_ARGS_JSON='["/abs/path/to/engines/mjlab-rsl-rl-adapter/adapter.py"]'
"""

import json
import math
import os
import sys
import time

try:
    import numpy as np
except ImportError:  # pragma: no cover - environment guard
    print("adapter requires numpy: python3 -m pip install --user numpy", file=sys.stderr)
    sys.exit(2)

try:
    import torch
except ImportError:  # pragma: no cover - environment guard
    print("adapter requires torch: python3 -m pip install --user torch", file=sys.stderr)
    sys.exit(2)

try:
    import rsl_rl  # noqa: F401
    from rsl_rl.env import VecEnv
    from rsl_rl.runners import OnPolicyRunner
    HAVE_RSL_RL = True
except ImportError:
    HAVE_RSL_RL = False

try:
    import mujoco  # noqa: F401
    import mjlab  # noqa: F401
    HAVE_MJLAB = True
except ImportError:
    HAVE_MJLAB = False

ADAPTER_ID = "mjlab-rsl-rl"

# Mirrors engines/starter-ppo budgets: a CPU trainer must clamp instead of
# silently burning hours; the result records what actually ran.
PROFILE_BUDGETS = {
    "smoke": {"iterations": 40, "envs": 16, "steps": 128},
    "low-vram": {"iterations": 400, "envs": 32, "steps": 128},
    "standard": {"iterations": 400, "envs": 64, "steps": 128},
    "high-vram": {"iterations": 600, "envs": 128, "steps": 128},
}

RSL_TRAIN_CFG = {
    # PPO hyper-parameters follow the platform's calibrated starter values
    # (entropy 0.002 etc.) instead of rsl-rl legged_gym defaults, so both
    # engines share one tuning story.
    "algorithm": {
        "class_name": "PPO",
        "num_learning_epochs": 4,
        "num_mini_batches": 4,
        "clip_param": 0.2,
        "gamma": 0.99,
        "lam": 0.95,
        "value_loss_coef": 1.0,
        "entropy_coef": 0.002,
        "learning_rate": 3.0e-4,
        "max_grad_norm": 1.0,
        "schedule": "fixed",
        "desired_kl": None,
    },
    "policy": {"class_name": "ActorCritic", "actor_hidden_dims": [128, 128], "critic_hidden_dims": [128, 128],
               "activation": "tanh", "init_noise_std": 1.0},
    "num_steps_per_env": 128,
    "save_interval": 1_000_000,  # checkpoint bookkeeping lives in the job dir
    "empirical_normalization": False,
    "logger": "tensorboard",
}


def stdout(line):
    print("[rsl-rl-adapter] " + str(line), flush=True)


def clamp_int(value, low, high, fallback):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, parsed))


def env_int(name, fallback):
    return clamp_int(os.environ.get(name), 1, 2_000_000, fallback)


def safe_slug(value, fallback):
    slug = "".join(ch if (ch.isalnum() or ch in "._-") else "-" for ch in str(value)).strip("-")
    return slug[:48] or fallback


# ---------------------------------------------------------------------------
# PROJECT HOOK 1 — build the vectorized environment from the manifest
# contract. Both branches MUST honor observation_size / action_size /
# control loop; a mismatch is a policy-contract violation.
# ---------------------------------------------------------------------------
class GoalNavVecEnv(VecEnv):
    """rsl_rl VecEnv wrapper over the platform's vectorized GoalNavEnv.

    This is the kinematic fallback backend. It exists so the adapter runs a
    genuine rsl_rl PPO loop on a clean checkout, and so a task pack
    transferred to a GPU box swaps ONE function (build_mjlab_env) to reach
    contact dynamics — the file protocol, training loop, export, and quality
    gate are shared.
    """

    def __init__(self, pack, num_envs, seed, device):
        # Imported lazily: starter engine availability is a property of the
        # deployment, not of this adapter file.
        from starter_ppo_loader import load_starter_engine  # noqa: PLC0415

        starter = load_starter_engine()
        self.env = starter.GoalNavEnv(pack, num_envs, seed=seed)
        self.pack = pack
        self.device = torch.device(device)
        self.num_envs = num_envs
        self.num_actions = self.env.action_size
        self.num_obs = self.env.observation_size
        self.max_episode_length = int(self.env.timeout_steps)
        self.episode_length_buf = torch.zeros(num_envs, dtype=torch.long)
        self.cfg = pack
        self.dt = 1.0 / float(pack.get("controlHz", 10))
        # Cumulative episode reward for the "log" extras the runner reads.
        self._episode_reward = torch.zeros(num_envs, dtype=torch.float32)

    # -- VecEnv contract -----------------------------------------------------
    def get_observations(self):
        obs = torch.from_numpy(self.env.observe()).to(self.device)
        return obs, {"observations": {}}

    def reset(self):
        obs = self.env.reset()
        self.episode_length_buf.zero_()
        self._episode_reward.zero_()
        return torch.from_numpy(obs).to(self.device), {"observations": {}}

    def step(self, actions):
        actions_np = actions.detach().cpu().numpy()
        obs, rewards, dones, _success = self.env.step(actions_np)
        obs_t = torch.from_numpy(obs).to(self.device)
        rewards_t = torch.from_numpy(rewards.astype(np.float32)).to(self.device)
        dones_t = torch.from_numpy(dones.astype(np.float32)).to(self.device)
        self.episode_length_buf += 1
        self._episode_reward += rewards_t
        # Timeouts (not goal/collision terminations) must bootstrap the value
        # target, exactly as PPO.process_env_step expects.
        timeout_mask = torch.zeros_like(dones_t)
        timeout_mask[self.episode_length_buf >= self.max_episode_length] = 1.0
        infos = {
            "observations": {},
            "time_outs": timeout_mask,
            "log": {
                "episode_reward": float(self._episode_reward.mean()),
                "episode_length": float(self.episode_length_buf.float().mean()),
            },
        }
        return obs_t, rewards_t, dones_t, infos


def build_mjlab_env(request, contract, num_envs, device):
    """PROJECT HOOK 1 (mjlab branch): build the vectorized physics env.

    Replace this with your mjlab scene constructor. The return value must
    satisfy the rsl_rl VecEnv contract (get_observations/reset/step,
    num_envs/num_actions/dt/max_episode_length) and MUST use exactly the
    contract dimensions; a mismatch is a policy-contract violation, not a
    tuning choice. The kinematic fallback keeps this hook honest: until it is
    filled, the adapter says plainly which physics it ran.
    """
    raise NotImplementedError(
        "PROJECT HOOK 1 (mjlab): construct your mjlab VecEnv here "
        "(obs={}, act={}, decimation from contract); until then the adapter "
        "honestly falls back to the kinematic backend".format(
            contract.get("observationSize"), contract.get("actionSize")
        )
    )


# ---------------------------------------------------------------------------
# PROJECT HOOK 2 — train with rsl_rl PPO and export the actor to ONNX.
# ---------------------------------------------------------------------------
def export_actor_onnx(runner, obs_size, act_size, path):
    """Export the deterministic actor exactly as the manifest declares it.

    The exported graph is mean-action (act_inference) with the output clamped
    to [-1, 1], dynamic batch axis, opset 13 — the same contract
    engines/starter-ppo exports, so the board runtime loads either engine's
    artifact identically.
    """
    actor = runner.alg.actor_critic
    actor.eval()

    class ActorOnly(torch.nn.Module):
        def __init__(self, ac):
            super().__init__()
            self.ac = ac

        def forward(self, observation):
            return self.ac.act_inference(observation).clamp(-1.0, 1.0)

    model = ActorOnly(actor)
    dummy = torch.zeros(1, obs_size)
    import warnings
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=DeprecationWarning)
        torch.onnx.export(
            model,
            (dummy,),
            path,
            input_names=["observation"],
            output_names=["action"],
            dynamic_axes={"observation": {0: "batch"}, "action": {0: "batch"}},
            opset_version=13,
        )
    return os.path.getsize(path)


def measure_control_latency_ms(runner, obs_size, device):
    """Single-sample inference latency for the one-thread CPU budget."""
    actor = runner.alg.actor_critic
    actor.eval()
    sample = torch.zeros(1, obs_size)
    with torch.inference_mode():
        actor.act_inference(sample)  # warm-up
        timings = []
        for _ in range(32):
            started = time.perf_counter()
            actor.act_inference(sample)
            timings.append((time.perf_counter() - started) * 1000.0)
    return round(float(np.median(timings)), 3)


# ---------------------------------------------------------------------------
# PROJECT HOOK 3 — evaluate the trained policy and emit the result contract.
# ---------------------------------------------------------------------------
def evaluate_kinematic(runner, pack, seed, episodes_per_envelope, confidence):
    """Reuse the starter engine's pinned-envelope evaluation unchanged.

    The rsl_rl actor is wrapped in the .act() shape the evaluation helper
    expects (deterministic mean action), so the same Wilson-CI metrics, the
    same baseline comparison, and the same eval-report.json shape come out of
    both engines — the platform's release gate re-computes the verdict from
    these numbers either way.
    """
    from starter_ppo_loader import load_starter_engine  # noqa: PLC0415

    _engines_dir_on_path()
    starter = load_starter_engine()
    envelopes = (pack.get("domainRandomization") or {}).get("evalEnvelopes") or {}
    eval_cfg = pack.get("evaluationConfig") or {}
    device = next(runner.alg.actor_critic.parameters()).device
    env = starter.GoalNavEnv(pack, 1, seed=seed)

    class _RslPolicy:
        """Adapter giving the starter evaluator the .act() it expects."""

        def __init__(self, actor):
            self.actor = actor

        def act(self, obs_tensor, deterministic=True):
            with torch.inference_mode():
                action = self.actor.act_inference(obs_tensor)
            return action.clamp(-1.0, 1.0), torch.zeros(action.shape[0], device=action.device)

        @property
        def training(self):
            return self.actor.training

        def eval(self):
            self.actor.eval()
            return self

        def train(self):
            self.actor.train()
            return self

    policy = _RslPolicy(runner.alg.actor_critic)
    eval_seed = seed + 1000
    trained_report = starter.evaluate_goal_navigation(
        policy, env, device, envelopes, eval_seed,
        episodes_per_envelope=episodes_per_envelope, confidence=confidence,
    )
    baseline_model = starter.ActorCritic(env.observation_size, env.action_size).to(device)
    baseline_report = starter.evaluate_goal_navigation(
        baseline_model, env, device, envelopes, eval_seed,
        episodes_per_envelope=episodes_per_envelope, confidence=confidence,
    )
    gate = starter.evaluate_quality_gate(trained_report, pack.get("qualityGate") or {})
    return trained_report, baseline_report, gate


def _engines_dir_on_path():
    engines_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if engines_dir not in sys.path:
        sys.path.insert(0, engines_dir)


def main():
    _engines_dir_on_path()

    request_path = os.environ.get("RDK_SIM2REAL_REQUEST_FILE", "").strip()
    result_path = os.environ.get("RDK_SIM2REAL_RESULT_FILE", "").strip()
    if not request_path or not result_path:
        print(
            "RDK_SIM2REAL_REQUEST_FILE and RDK_SIM2REAL_RESULT_FILE are required; "
            "run this through local-training-worker.mjs",
            file=sys.stderr,
        )
        sys.exit(2)

    with open(request_path) as handle:
        request = json.load(handle)
    if request.get("schemaVersion") != 1:
        raise ValueError("schemaVersion must be 1")

    if not HAVE_RSL_RL:
        print(
            "[rsl-rl-adapter] REFUSED — rsl_rl is not installed "
            f"(python3 -m pip install --user rsl-rl-lib==2.2.3). This adapter "
            "never fabricates a completed training run.",
            file=sys.stderr,
        )
        sys.exit(3)

    contract = request.get("contract") or {}
    model = request.get("model") or {}
    training = request.get("training") or {}
    task = request.get("task") or {}
    observation_size = int(contract.get("observationSize", 0))
    action_size = int(contract.get("actionSize", 0))
    if observation_size <= 0 or action_size <= 0:
        raise ValueError("contract.observationSize and contract.actionSize are required")
    control_hz = int(contract.get("controlHz", 50))
    physics_dt = float(contract.get("physicsTimestepSeconds", 0.002))
    decimation = int(contract.get("decimation", max(1, round(control_hz * physics_dt))))
    model_id = str(model.get("modelId", "rsl-rl-policy"))
    version = str(model.get("version", "0.1.0"))
    profile = str(training.get("profile", "smoke"))
    pack = task if isinstance(task, dict) and task.get("kind") == "goal-navigation" else None

    requested_device = (os.environ.get("RDK_STARTER_ENGINE_DEVICE") or "auto").strip().lower()
    if requested_device not in ("auto", "cpu", "cuda"):
        raise ValueError("RDK_STARTER_ENGINE_DEVICE must be 'auto', 'cuda', or 'cpu'")
    if requested_device == "cpu":
        device = "cpu"
    else:
        device = "cuda" if torch.cuda.is_available() else "cpu"
    torch.set_num_threads(1 if device == "cpu" else 4)
    if pack is not None:
        seed = int(pack.get("seed", 7))
        torch.manual_seed(seed)
        np.random.seed(seed % (2 ** 31))

    # ---- choose the physics backend honestly ------------------------------
    use_mjlab = HAVE_MJLAB and os.environ.get("RDK_RSL_ADAPTER_FORCE_MJLAB", "") != "0"
    if use_mjlab and pack is None:
        # The mjlab branch currently needs a task-pack scene spec; a raw
        # contract-only request falls back rather than inventing a scene.
        use_mjlab = False
    physics_backend = "mjlab" if use_mjlab else "starter-kinematic"
    runner = None
    seed = int(pack.get("seed", 7)) if pack else 7
    max_iterations = 0
    training_seconds = None
    latency = None
    onnx_bytes = 0
    nominal, baseline_nominal = {}, {}
    trained_report, baseline_report = {}, {}
    if use_mjlab:
        env = build_mjlab_env(request, contract, 0, device)  # num_envs resolved inside
    else:
        if pack is None:
            raise ValueError(
                "the kinematic fallback requires a goal-navigation task pack in the request; "
                "submit through the platform's task-pack training path"
            )
        budget = PROFILE_BUDGETS.get(profile, PROFILE_BUDGETS["smoke"])
        num_envs = env_int("RDK_STARTER_ENGINE_ENVS", 0) or clamp_int(
            training.get("numEnvs"), 1, budget["envs"], budget["envs"]
        )
        env = GoalNavVecEnv(pack, num_envs, int(pack.get("seed", 7)), device)
        if env.num_obs != observation_size or env.num_actions != action_size:
            raise ValueError(
                "environment dimensions {}x{} violate the contract {}x{}".format(
                    env.num_obs, env.num_actions, observation_size, action_size
                )
            )
        max_iterations = env_int("RDK_STARTER_ENGINE_ITERATIONS", 0) or clamp_int(
            training.get("maxIterations"), 1, budget["iterations"], min(budget["iterations"], 60)
        )
        cfg = {
            **RSL_TRAIN_CFG,
            "num_steps_per_env": env_int(
                "RDK_STARTER_ENGINE_STEPS", PROFILE_BUDGETS.get(profile, PROFILE_BUDGETS["smoke"])["steps"]
            ),
        }
        stdout(
            "engine=rsl-rl-ppo physics={} task={} profile={} iters={} envs={} obs={} act={} device={}".format(
                physics_backend, pack.get("id"), profile, max_iterations, env.num_envs,
                observation_size, action_size, device,
            )
        )
        started = time.time()
        runner = OnPolicyRunner(env, cfg, log_dir=None, device=device)
        # rsl_rl 2.2.3 assumes a logging deployment: it imports tensorboard
        # when log_dir is set, saves a checkpoint whenever `it % save_interval
        # == 0` (it=0 always satisfies that), and store_code_state() crashes
        # on log_dir=None. The worker protocol owns durability (job dir +
        # result.json); checkpoint .pt files are engine-internal, so disable
        # runner-side logging/saving rather than pulling a tensorboard
        # dependency into every training worker.
        import rsl_rl.runners.on_policy_runner as rsl_runner_module  # noqa: PLC0415
        runner.save = lambda *_args, **_kwargs: None
        runner.logger_type = "tensorboard"  # inert: writer stays None
        rsl_runner_module.store_code_state = lambda *_args, **_kwargs: []
        runner.learn(max_iterations)
        training_seconds = round(time.time() - started, 1)

        # ---- evaluation + quality gate (starter evaluator, shared shape) ----
        eval_cfg = pack.get("evaluationConfig") or {}
        episodes_per_envelope = clamp_int(eval_cfg.get("episodesPerEnvelope"), 1, 200, 50)
        confidence = float(eval_cfg.get("confidenceLevel", 0.95))
        trained_report, baseline_report, gate = evaluate_kinematic(
            runner, pack, seed, episodes_per_envelope, confidence
        )
        latency = measure_control_latency_ms(runner, observation_size, "cpu")

        onnx_bytes = 0
        try:
            onnx_bytes = export_actor_onnx(runner, observation_size, action_size, "policy.onnx")
            stdout("exported policy.onnx ({} bytes)".format(onnx_bytes))
        except Exception as error:  # noqa: BLE001 - export failure must not lose the run
            stdout("ONNX export failed: {}; continuing without it".format(error))

        with open("telemetry.jsonl", "w") as handle:
            for row in trained_report["jsonl"].get("hard", []):
                handle.write(json.dumps(row) + "\n")
        with open("baseline-telemetry.jsonl", "w") as handle:
            for row in baseline_report["jsonl"].get("nominal", []):
                handle.write(json.dumps(row) + "\n")
        with open("training-summary.json", "w") as handle:
            json.dump(
                {
                    "engine": ADAPTER_ID,
                    "physicsBackend": physics_backend,
                    "task": pack["id"],
                    "taskKind": "goal-navigation",
                    "profile": profile,
                    "iterations": max_iterations,
                    "numEnvs": env.num_envs,
                    "seed": seed,
                    "rslRlVersion": getattr(rsl_rl, "__version__", "unknown"),
                    "hyperparams": RSL_TRAIN_CFG["algorithm"],
                    "device": device,
                    "eval": {k: v for k, v in trained_report.items() if k != "jsonl"},
                    "baseline": {k: v for k, v in baseline_report.items() if k != "jsonl"},
                    "controlLatencyMs": latency,
                    "onnxExported": bool(onnx_bytes),
                    "trainingSeconds": training_seconds,
                },
                handle, indent=2,
            )
        with open("eval-report.json", "w") as handle:
            json.dump(
                {
                    "schemaVersion": 1,
                    "taskId": pack["id"],
                    "adapterId": pack["adapter"]["id"],
                    "observationAdapterId": pack["adapter"]["policy"]["observationAdapterId"],
                    "engine": ADAPTER_ID,
                    "physicsBackend": physics_backend,
                    "trained": {k: v for k, v in trained_report.items() if k != "jsonl"},
                    "baseline": {k: v for k, v in baseline_report.items() if k != "jsonl"},
                    "qualityGate": gate,
                    "controlLatencyMs": latency,
                    "seed": seed + 1000,
                },
                handle, indent=2,
            )

        nominal = trained_report["envelopes"].get("nominal") or {}
        baseline_nominal = baseline_report["envelopes"].get("nominal") or {}
        stdout(
            "eval nominal: successRate={:.2f} collisionRate={:.2f} (baseline {:.2f}/{:.2f}) gate={} physics={}".format(
                nominal.get("successRate", 0.0), nominal.get("collisionRate", 0.0),
                baseline_nominal.get("successRate", 0.0), baseline_nominal.get("collisionRate", 0.0),
                "PASS" if gate["passed"] else "FAIL", physics_backend,
            )
        )
    if use_mjlab:
        # mjlab branch: training/eval metrics produced by the hook above.
        max_iterations = int(training.get("maxIterations", 1_000))
        gate = {"passed": False, "errors": ["mjlab evaluation hook not implemented"]}

    slug_model = safe_slug(model_id, ADAPTER_ID)
    slug_version = safe_slug(version, "0-1-0")
    result = {
        "checkpoint": {
            "checkpointId": "rsl-rl-{}".format(slug_version),
            "artifactRef": "artifact://rsl-rl/{}/{}/checkpoint".format(slug_model, slug_version),
            "iteration": max_iterations,
        },
        "artifact": {
            "artifactId": "{}-policy".format(slug_model),
            "artifactRef": "artifact://rsl-rl/{}/{}/policy.onnx".format(slug_model, slug_version),
            "kind": "source",
            **({"format": "onnx", "runtime": "cpu-onnx", "workload": "goal-navigation", "threads": 1,
                "sizeBytes": onnx_bytes} if onnx_bytes else {"format": "unknown"}),
            "deployable": False,
        },
        "metrics": {
            "contractValid": True,
            "engine": ADAPTER_ID,
            "physicsBackend": physics_backend,
            "taskId": pack["id"] if pack else None,
            "taskKind": "goal-navigation" if pack else None,
            "observationSize": observation_size,
            "actionSize": action_size,
            "iterations": max_iterations,
            **(
                {
                    "successRate": round(nominal.get("successRate", 0.0), 4),
                    "successRateCiLow": round(nominal.get("successRateCiLow", 0.0), 4),
                    "successRateCiHigh": round(nominal.get("successRateCiHigh", 0.0), 4),
                    "evalEpisodes": nominal.get("episodes"),
                    "collisionRate": round(nominal.get("collisionRate", 0.0), 4),
                    "hardSuccessRate": round(
                        (trained_report.get("envelopes", {}).get("hard") or {}).get("successRate", 0.0), 4
                    ),
                    "initialReward": round(baseline_report.get("meanReward", 0.0), 4),
                    "reward": round(trained_report.get("meanReward", 0.0), 4),
                    "qualityGatePassed": gate["passed"],
                    "controlLatencyMs": latency,
                    "onnxExported": bool(onnx_bytes),
                    "telemetrySamples": sum(len(rows) for rows in trained_report.get("jsonl", {}).values()),
                }
                if physics_backend == "starter-kinematic" else {}
            ),
        },
        "taskEvaluation": (
            {
                "schemaVersion": 1,
                "taskId": pack["id"],
                "adapterId": pack["adapter"]["id"],
                "observationAdapterId": pack["adapter"]["policy"]["observationAdapterId"],
                "trained": {k: v for k, v in trained_report.items() if k != "jsonl"},
                "baseline": {k: v for k, v in baseline_report.items() if k != "jsonl"},
                "qualityGate": gate,
                "controlLatencyMs": latency,
                "seed": seed + 1000,
            }
            if pack and physics_backend == "starter-kinematic" else None
        ),
        "deployable": False,
        "cuda": device == "cuda",
        "physicsBackend": physics_backend,
    }
    if result["taskEvaluation"] is None:
        del result["taskEvaluation"]
    with open(result_path, "w") as handle:
        json.dump(result, handle, indent=2)
    stdout("wrote result (physicsBackend={})".format(physics_backend))


if __name__ == "__main__":
    main()
