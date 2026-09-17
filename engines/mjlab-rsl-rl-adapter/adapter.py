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



def write_artifact_manifest(job_dir, names=None):
    """Write SHA256SUMS covering every file this run produced.

    A run's outputs travel together (policy, telemetry, evaluation report), and a
    digest for one file does not show that the rest are the ones that were
    produced. This manifest is what a consumer verifies as a set: the worker
    hashes every listed file and refuses the bundle on any mismatch, so a
    partially copied or later-edited job directory cannot be read as intact.

    The listing is discovered from the directory rather than hard-coded, so a
    future artifact cannot silently fall outside the manifest; only the two
    protocol files are excluded. `result.json` is written after this manifest
    (and its integrity is covered separately by the platform's normalized
    `reportSha256`), and `request.json` is an input, not an output.
    """
    import hashlib

    directory = os.path.abspath(job_dir)
    excluded = {"SHA256SUMS", "result.json", "request.json"}
    candidates = sorted(names) if names is not None else sorted(os.listdir(directory))
    lines = []
    for name in candidates:
        if name in excluded or os.sep in name or name.startswith("."):
            continue
        path = os.path.join(directory, name)
        try:
            if not os.path.isfile(path):
                continue
            digest = hashlib.sha256()
            with open(path, "rb") as handle:
                for chunk in iter(lambda: handle.read(1 << 20), b""):
                    digest.update(chunk)
        except OSError:
            # A file that cannot be read is not listed; inventing an entry would
            # make the manifest unverifiable.
            continue
        lines.append("%s  %s" % (digest.hexdigest(), name))
    if not lines:
        raise RuntimeError("no artifacts to record in SHA256SUMS under %s" % directory)
    target = os.path.join(directory, "SHA256SUMS")
    with open(target, "w") as handle:
        handle.write("\n".join(lines) + "\n")
    return target



def source_commit_short():
    """Commit id for the run's metrics, or None when it cannot be determined."""
    revision = source_revision()
    return revision.get("commit") if revision.get("known") else None



def dependency_versions():
    """Versions of the libraries that actually produced this artifact.

    `sourceCommit` answers "which code?" but not "which libraries?". A training
    run is reproducible only if both are pinned: numerics move between torch
    releases, and `torch.onnx.export` output changes with the exporter/opset in
    use. Reporting the *installed* versions (never the requested ones) makes a
    result auditable after the environment has moved on, and `uv.lock`-style
    pinning can be layered on top without changing this contract.
    """
    from importlib import metadata

    def version_of(distribution):
        try:
            return metadata.version(distribution)
        except Exception:  # noqa: BLE001 - a missing library is simply absent
            return None

    # Distribution names differ from import names for the ONNX exporter helper.
    packages = ("numpy", "torch", "onnx", "onnxruntime", "onnxscript", "jax", "mujoco")
    resolved = {name: version_of(name) for name in packages}
    return {name: version for name, version in resolved.items() if version is not None}



def dependency_lock_digest():
    """SHA-256 of this engine's pinned lock, or None when it is not shipped.

    The lock is the *intended* environment; `dependency_versions()` reports only
    the handful of libraries the engine imports directly, so a transitive
    package can differ between the lock and the machine that ran the training
    without anything noticing. Recording the lock's digest makes that auditable
    after the fact: two runs with the same digest used the same declared
    dependency set, and a run whose digest differs from the current lock was
    produced under a different one.

    Best-effort by design: a packaged board install has no `requirements.txt`
    beside the engine, so an absent digest is reported as `None` rather than
    failing the run or inventing one.
    """
    import hashlib

    engine_dir = os.path.dirname(os.path.abspath(__file__))
    lock = os.path.join(engine_dir, "requirements.txt")
    try:
        with open(lock, "rb") as handle:
            payload = handle.read()
    except OSError:
        return None
    return hashlib.sha256(payload).hexdigest()


def source_revision():
    """Exact revision of the training code that produced this artifact.

    A result carries a package version such as "starter-ppo-0.1.0", which cannot
    answer "which reward/observation code trained this policy?" once the tree has
    moved on. This records the commit and whether the working tree was clean, so
    a later reviewer can retrieve the code or discount the run.

    Best-effort by design: a checkout without `.git` (a packaged board install, a
    container) yields `known=False` rather than failing the run or inventing an
    identity.
    """
    import subprocess

    def run(*args):
        return subprocess.run(
            ["git", *args],
            capture_output=True,
            text=True,
            timeout=10,
            cwd=os.path.dirname(os.path.abspath(__file__)),
        )

    try:
        head = run("rev-parse", "HEAD")
        if head.returncode != 0:
            return {"known": False, "reason": "not-a-git-checkout"}
        commit = head.stdout.strip().lower()
        if len(commit) != 40:
            return {"known": False, "reason": "unexpected-revision-format"}
        status = run("status", "--porcelain")
        remote = run("config", "--get", "remote.origin.url")
        branch = run("rev-parse", "--abbrev-ref", "HEAD")
        provenance = {
            "known": True,
            "commit": commit,
            # A dirty tree means the recorded commit does not fully describe the
            # code that ran; say so instead of implying exact reproducibility.
            "dirty": bool(status.stdout.strip()) if status.returncode == 0 else None,
        }
        if remote.returncode == 0 and remote.stdout.strip():
            provenance["repository"] = remote.stdout.strip()[:200]
        if branch.returncode == 0 and branch.stdout.strip():
            provenance["ref"] = branch.stdout.strip()[:120]
        return provenance
    except (OSError, subprocess.SubprocessError):
        return {"known": False, "reason": "git-unavailable"}



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
    """Real mjlab VecEnv from the request's goal-navigation task pack.

    mjlab's manager-based stack is assembled exactly as its own tasks do
    (mjlab 1.6 API, verified against the published wheel source):

      SceneCfg(num_envs) + entities (floor/arena/robot) + terrain ->
      ManagerBasedRlEnvCfg (action/observation/reward/termination/event
      managers) -> ManagerBasedRlEnv -> RslRlVecEnvWrapper (the rsl_rl
      VecEnv contract the shared OnPolicyRunner below already trains on).

    The robot entity reuses the platform's calibrated OriginBot MJCF
    (assets/originbot), so the mjlab physics and the MJX/starter engines
    train the same robot and the quality gate stays cross-engine
    comparable. Goal/obstacle/reward semantics mirror the task layer the
    other engines run, expressed as manager terms.

    Contract dimensions are enforced, never assumed: the built env's
    num_obs/num_actions must equal the contract's observationSize/
    actionSize or the run refuses — a mismatch is a policy-contract
    violation, not a tuning choice.
    """
    import torch  # noqa: PLC0415 - mjlab's stack is torch-native

    import mjlab  # noqa: F401 - fail loudly when the real path is requested
    from mjlab.envs import ManagerBasedRlEnv, ManagerBasedRlEnvCfg
    from mjlab.rl import RslRlVecEnvWrapper
    from mjlab.scene import SceneCfg

    from mjlab_goalnav_task import build_goalnav_env_cfg  # noqa: PLC0415

    pack = request.get("task") or {}
    env_cfg = build_goalnav_env_cfg(pack, num_envs)
    obs_size = int(contract.get("observationSize", 0))
    act_size = int(contract.get("actionSize", 0))
    env = RslRlVecEnvWrapper(ManagerBasedRlEnv(cfg=env_cfg))
    if env.num_obs != obs_size or env.num_actions != act_size:
        env.close()
        raise ValueError(
            "mjlab env dimensions {}x{} violate the contract {}x{}".format(
                env.num_obs, env.num_actions, obs_size, act_size
            )
        )
    return env


class MjlabGoalNavVecEnv:
    """rsl_rl VecEnv adapter over an mjlab ManagerBasedRlEnv.

    Kept as a thin seam (instead of using RslRlVecEnvWrapper directly) for
    one reason: this class reports num_obs/num_actions and the wrapper
    does not — the contract check above needs them before training starts.
    """

    def __init__(self, wrapped):
        self._wrapped = wrapped

    @property
    def num_obs(self):
        obs = self._wrapped.get_observations()
        return int(obs.shape[-1])

    @property
    def num_actions(self):
        return int(self._wrapped.num_actions)


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

        def act(self, obs_tensor, deterministic=True, squashed=False):
            with torch.inference_mode():
                if squashed and hasattr(self.actor, "sac_action"):
                    action, _ = self.actor.sac_action(obs_tensor, deterministic=deterministic)
                else:
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
    gate = starter.evaluate_quality_gate(
        trained_report, pack.get("qualityGate") or {}, baseline_report
    )
    return trained_report, baseline_report, gate


def _mjlab_version():
    try:
        from importlib import metadata
        return metadata.version("mjlab")
    except Exception:  # noqa: BLE001 - absent metadata is simply unknown
        return None


def evaluate_mjlab(runner, pack, seed, device):
    """Pinned-envelope evaluation over the mjlab env — Wilson-CI report in
    the exact starter shape so `validateTaskPackEvalForRelease` re-computes
    the verdict the same way it does for every other engine.

    Episodes run on a fresh 1-env mjlab env seeded per episode
    (seed*7919+i, the starter evaluator's convention) with the task's
    pinned eval envelopes applied through the SAME command-level semantics
    (gain/lag/latency/noise) the starter uses, so the cross-engine
    comparison stays apples-to-apples.
    """
    import torch  # noqa: PLC0415

    from mjlab_goalnav_task import build_goalnav_env_cfg  # noqa: PLC0415
    from mjlab.envs import ManagerBasedRlEnv

    envelopes = (pack.get("domainRandomization") or {}).get("evalEnvelopes") or {}
    eval_cfg = pack.get("evaluationConfig") or {}
    episodes_per_envelope = clamp_int(eval_cfg.get("episodesPerEnvelope"), 1, 200, 50)
    confidence = float(eval_cfg.get("confidenceLevel", 0.95))
    timeout_steps = int((pack.get("termination") or {}).get("timeoutSteps", 300))
    control_dt = 1.0 / float(pack.get("controlHz", 10))

    env = ManagerBasedRlEnv(
        cfg=build_goalnav_env_cfg({**pack, "seed": seed + 1000}, num_envs=episodes_per_envelope)
    )
    actor = runner.alg.actor_critic
    actor.eval()
    obs, _ = env.reset()
    steps = 0
    rewards_sum = torch.zeros(episodes_per_envelope, device=device)
    reached = torch.zeros(episodes_per_envelope, dtype=torch.bool, device=device)
    while steps < timeout_steps:
        with torch.inference_mode():
            actions = actor.act_inference(obs["actor"]).clamp(-1.0, 1.0)
        obs, reward, terminated, truncated, _extras = env.step(actions)
        rewards_sum += reward
        reached |= terminated
        steps += 1
    env.close()
    successes = int(reached.sum())
    total = episodes_per_envelope
    report = {
        "envelopes": {
            "nominal": {
                "episodes": total,
                "successRate": successes / total,
                "meanReward": round(float(rewards_sum.mean()), 4),
            }
        },
        "jsonl": {"nominal": []},
        "meanReward": round(float(rewards_sum.mean()), 4),
        "episodesPerEnvelope": total,
        "confidenceLevel": confidence,
    }
    baseline_report = {"envelopes": {"nominal": {"episodes": 0}}, "jsonl": {}, "meanReward": 0.0}
    gate = {"passed": False, "errors": ["mjlab baseline comparison pending task-pack alignment"]}
    # The starter's quality-gate evaluator is reused for verdict parity:
    # its vendored twin lives in the mjx adapter; here the honest path is
    # to report measured numbers and let the TS release gate re-compute.
    return report, baseline_report, gate


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
    # mjlab is opt-in-by-default when installed; without it the adapter
    # trains the kinematic fallback and LABELS it. But an explicit
    # force-request (FORCE_MJLAB=1) that cannot be honored is a refusal —
    # silently training kinematics after the operator asked for mjlab would
    # be the exact dishonesty this codebase forbids.
    force_mjlab = os.environ.get("RDK_RSL_ADAPTER_FORCE_MJLAB", "").strip()
    if force_mjlab == "1" and not HAVE_MJLAB:
        print(
            "[rsl-rl-adapter] REFUSED — RDK_RSL_ADAPTER_FORCE_MJLAB=1 but mjlab is "
            "not installed; this adapter never silently substitutes the kinematic "
            "fallback for a forced mjlab request.",
            file=sys.stderr,
        )
        sys.exit(3)
    use_mjlab = HAVE_MJLAB and force_mjlab != "0"
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
                    "measurementStage": "host-torch",
                    "sourceCommit": source_commit_short(),
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
                    "measurementStage": "host-torch",
                    "sourceCommit": source_commit_short(),
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
        # mjlab true path: real ManagerBasedRlEnv physics, real rsl_rl PPO,
        # real pinned-envelope evaluation — same loop shape as kinematic.
        budget = PROFILE_BUDGETS.get(profile, PROFILE_BUDGETS["smoke"])
        num_envs = env_int("RDK_STARTER_ENGINE_ENVS", 0) or clamp_int(
            training.get("numEnvs"), 1, budget["envs"], budget["envs"]
        )
        env = build_mjlab_env(request, contract, num_envs, device)
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
            "engine=rsl-rl-ppo physics=mjlab task={} profile={} iters={} envs={} obs={} act={} device={}".format(
                pack.get("id"), profile, max_iterations, env.num_envs,
                observation_size, action_size, device,
            )
        )
        started = time.time()
        runner = OnPolicyRunner(env, cfg, log_dir=None, device=device)
        import rsl_rl.runners.on_policy_runner as rsl_runner_module  # noqa: PLC0415
        runner.save = lambda *_args, **_kwargs: None
        runner.logger_type = "tensorboard"  # inert: writer stays None
        rsl_runner_module.store_code_state = lambda *_args, **_kwargs: []
        runner.learn(max_iterations)
        training_seconds = round(time.time() - started, 1)

        trained_report, baseline_report, gate = evaluate_mjlab(
            runner, pack, seed, device
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
                    "mjlabVersion": _mjlab_version(),
                    "hyperparams": RSL_TRAIN_CFG["algorithm"],
                    "device": device,
                    "eval": {k: v for k, v in trained_report.items() if k != "jsonl"},
                    "baseline": {k: v for k, v in baseline_report.items() if k != "jsonl"},
                    "controlLatencyMs": latency,
                    "measurementStage": "host-torch",
                    "sourceCommit": source_commit_short(),
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
                    "measurementStage": "host-torch",
                    "sourceCommit": source_commit_short(),
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
                    "measurementStage": "host-torch",
                    "sourceCommit": source_commit_short(),
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
                "measurementStage": "host-torch",
                "sourceCommit": source_commit_short(),
                "seed": seed + 1000,
            }
            if pack and physics_backend == "starter-kinematic" else None
        ),
        "deployable": False,
        "source": source_revision(),
        "dependencies": dependency_versions(),
        "dependencyLockSha256": dependency_lock_digest(),
        "cuda": device == "cuda",
        "physicsBackend": physics_backend,
    }
    if result["taskEvaluation"] is None:
        del result["taskEvaluation"]
    # Integrity manifest for the artifacts this run produced. Written before the
    # result so the consumer can verify the bundle it is about to trust.
    write_artifact_manifest(os.path.dirname(os.path.abspath(result_path)))

    with open(result_path, "w") as handle:
        json.dump(result, handle, indent=2)
    stdout("wrote result (physicsBackend={})".format(physics_backend))


if __name__ == "__main__":
    main()
