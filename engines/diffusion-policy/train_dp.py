#!/usr/bin/env python3
"""Diffusion Policy (CNN action-chunking DDPM) behavior cloning on trajectory JSONL.

The act engine answers "one observation -> a chunk of future actions" with a
deterministic Transformer decode plus a CVAE latent. Diffusion Policy (Chi et
al., RSS 2023 — "Diffusion Policy: Visuomotor Policy Learning via Action
Diffusion") answers the same question with a generative denoiser: the action
chunk is a SAMPLE from a learned distribution rather than the output of a
regression head, which is the property that matters when demonstrations are
multimodal — two teachers taking different routes to the same goal. A
regressor (and, to a lesser degree, ACT's conditional decoder) averages the
modes into a blend nobody demonstrated; a diffusion model keeps them apart.

What this engine implements, mapped onto the platform's tabular contract:

* **action chunking** — same as act: one observation conditions a `--chunk`
  window of future actions, trained from the same episode-bounded JSONL with
  the same fail-closed loader and the same episode-level split;
* **a conditional 1D UNet denoiser** (the paper's CNN variant): temporal
  convolutions over the chunk horizon, two encoder levels + bottleneck +
  two decoder levels with stride-2 down/up sampling, GroupNorm + SiLU
  residual blocks, the observation encoded by an MLP and injected into
  every block via FiLM modulation, and the diffusion step k entering
  through a sinusoidal table + MLP added to the observation embedding;
* **DDPM** (Ho et al. 2020) with `--diffusion-steps` (default 16) and a
  `--schedule` choice of cosine (Nichol & Dhariwal 2021, the default — it
  fully diffuses by step T at ANY horizon) or linear (Ho et al.'s betas,
  tuned for T~1000); the training objective is the noise-prediction MSE;
* **EMA weights** (`--ema-decay`, default 0.995) — evaluation, export, and
  the saved model all use the exponential moving average of the weights,
  the same convention the paper uses for its reported results.

The differentiating artifact: the ONNX export is the ENTIRE sampler. The
T-step reverse diffusion loop is unrolled into one graph whose only input is
the raw observation vector and whose output is the clamped action chunk —
observation normalization folded in, action de-normalization folded out, the
[-1, 1] clamp folded in (the same safety convention as act and starter-ppo:
the board runtime scales policy output by its MAX_LINEAR/MAX_ANGULAR rails,
so a graph that saturates itself can never command beyond the budgeted
speeds, even if the weights drift). The reverse-process noise is a FROZEN
realization drawn once from a dedicated export-seeded stream — the same
convention as act's z=0 prior-mean decode: an exported policy must map one
observation to one action, and the frozen draw is exactly the seeded
stochastic sampler's realization for single-row batches (parity-tested).

Honest deltas from the paper, all forced by the platform contract: tabular
observations instead of camera images, T=16 by default instead of 100
(CPU-training budget; cosine keeps small-T DDPM valid), no DDIM variant, and
scoring done with the float64 sampler arithmetic while the exported graph is
float32 (onnxruntime ships no double Conv kernel) and proven against the same
float32 torch actor — op-for-op arithmetic, so the equivalence check measures
the exporter, not the chain's rounding.

Everything the sibling engines guarantee is kept: seeded episode-level
train/validation split (chunks never straddle the split), normalization
estimated on the train side only, fail-closed dataset validation, same seed
-> bit-identical weights (EMA included), ONNX export PROVEN elementwise
against the torch sampler with onnxruntime before the file is kept, and the
full provenance block (source revision, imported versions, lock digest)
asserted by `npm run verify:training-provenance`.

File protocol (engine mode): with RDK_SIM2REAL_REQUEST_FILE and
RDK_SIM2REAL_RESULT_FILE set, runs a smoke round on a deterministic
SYNTHETIC episode dataset sized by the request's contract, writes
model.json + policy.onnx + SHA256SUMS into the job directory, and a
result.json whose artifactRef is "artifact://policy.onnx". The synthetic
source is labeled in the result — the training is real, the data is not.

Output model format `rdk-dp-bc-v1` (JSON): architecture, diffusion schedule,
normalization constants, every weight as lists (the JSON IS the model —
`rebuild_model` reconstructs a forward-identical torch module from it),
metrics, seed and provenance blocks.
"""

import argparse
import json
import math
import os
import pathlib
import sys
import time

import numpy as np

try:
    import torch
    from torch import nn
    import torch.nn.functional as F
except ImportError:  # pragma: no cover - exercised on machines without torch
    torch = None

MODEL_FORMAT = "rdk-dp-bc-v1"
ENGINE_NAME = "diffusion-policy"
ALGORITHM = "diffusion-policy-ddpm"
ONNX_MISSING_HINT = "python3 -m pip install --user onnx onnxruntime"
# An episode-level split needs enough episodes on both sides for the val
# score to mean anything; fewer is refused, not reported as evidence.
MIN_TRAIN_EPISODES = 4
MIN_VAL_EPISODES = 2
# Elementwise equivalence contract between the torch sampler and the
# exported ONNX graph: np.allclose(expected, actual, rtol, atol).
EQUIVALENCE_RTOL = 1e-4
EQUIVALENCE_ATOL = 1e-5
EQUIVALENCE_ROWS = 64
# Rows per batch when scoring whole datasets with the reverse sampler.
SAMPLER_BATCH = 64
# Temporal convolution kernel of the UNet blocks (odd, symmetric padding).
KERNEL = 5
ONNX_OPSET = 17
SCHEDULES = ("cosine", "linear")
# RNG stream offsets inside one run, so training shuffles, diffusion-step
# draws, noise draws, fixed validation draws, scoring and the export noise
# never consume each other's streams (reproducibility is a platform
# guarantee; a coupled stream would make batch size changes alter val
# membership-like behavior).
SEED_OFFSETS = {
    "shuffle": 2,
    "diffusion_step": 3,
    "training_noise": 4,
    "validation_draws": 5,
    "scoring_sampler": 6,
    "export_noise": 7,
}


def source_revision():
    """Exact revision of the training code that produced this model.

    Mirrors the runner engines: best-effort by design — a checkout without
    `.git` yields `known=False` rather than failing the run or inventing an
    identity. `dirty=True` says the recorded commit does not fully describe
    the code that ran.
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
        provenance = {
            "known": True,
            "commit": commit,
            "dirty": bool(status.stdout.strip()) if status.returncode == 0 else None,
        }
        return provenance
    except (OSError, subprocess.SubprocessError):
        return {"known": False, "reason": "git-unavailable"}


def dependency_lock_digest():
    """SHA-256 of this engine's shipped requirements.txt, or None."""
    import hashlib

    lock = pathlib.Path(__file__).with_name("requirements.txt")
    if not lock.is_file():
        return None
    return hashlib.sha256(lock.read_bytes()).hexdigest()


def dependency_versions(used):
    """Versions of the libraries this run actually imported."""
    import importlib

    recorded = {}
    for name in used:
        try:
            recorded[name] = importlib.import_module(name).__version__
        except (ImportError, AttributeError):
            pass
    return recorded


def provenance_block(used_libraries):
    return {
        "source": source_revision(),
        "dependencies": dependency_versions(used_libraries),
        "dependencyLockSha256": dependency_lock_digest(),
    }


# ---------------------------------------------------------------------------
# Dataset: trajectory JSONL -> episodes -> (obs, chunk) pairs.
# Identical semantics to the act engine (the loaders are contract twins —
# a dataset accepted by one is accepted by the other).
# ---------------------------------------------------------------------------

def load_dataset(path):
    """Load a trajectory JSONL file into episodes.

    Chunked imitation needs temporal continuity, which the transition-only
    JSONL of offline-bc does not carry. The accepted row shapes:

    * `{"type": "header", ...}` — the recorder's header line; validated and
      skipped (only `header`/`step` types exist; anything else fails closed
      as a typo, not as a silent skip);
    * `{"type": "step", "observation": [...], "action": [...], "done": bool}`
      — the recorder's step line, exactly what the browser recorder emits;
    * a bare `{"observation": [...], "action": [...], "done": bool}` row —
      the offline-bc shape plus an explicit `done` marker (`state` is
      accepted as an alias of `observation`).

    A file whose rows carry neither a `type` nor a `done` field is refused:
    without episode structure, chunk targets would silently splice together
    unrelated recordings. Episode boundaries are `done: true` and EOF. One
    recorded trajectory file with no `done` anywhere is a single episode —
    that is the recorder's semantics.

    Every v1 strictness rule is kept: numeric values only (booleans are not
    numbers), finite values (NaN/Inf rejected at load), consistent
    dimensions, non-empty dataset.
    """
    episodes = []
    current_obs = []
    current_act = []
    obs_size = None
    act_size = None
    path = pathlib.Path(path)
    for line_no, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        if not isinstance(row, dict):
            raise ValueError("line %d: each row must be a JSON object" % line_no)
        row_type = row.get("type")
        if row_type is not None and row_type not in ("header", "step"):
            raise ValueError(
                "line %d: unknown row type %r (expected 'header' or 'step')"
                % (line_no, row_type)
            )
        if row_type == "header":
            continue
        if row_type is None and "done" not in row:
            raise ValueError(
                "line %d: action chunking needs episode structure — rows must "
                "carry a type ('header'/'step') or a done flag, otherwise chunk "
                "targets would splice unrelated recordings together" % line_no
            )
        obs = row.get("observation", row.get("state"))
        act = row.get("action")
        if not isinstance(obs, list) or not isinstance(act, list):
            raise ValueError(
                "line %d: observation/action required as numeric lists" % line_no
            )
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in obs + act):
            raise ValueError("line %d: values must be numeric" % line_no)
        if any(not math.isfinite(v) for v in obs + act):
            raise ValueError("line %d: values must be finite (no NaN/Inf)" % line_no)
        if obs_size is None:
            obs_size, act_size = len(obs), len(act)
        if len(obs) != obs_size or len(act) != act_size:
            raise ValueError("line %d: inconsistent dimensions" % line_no)
        done = row.get("done", False)
        if not isinstance(done, bool):
            raise ValueError("line %d: done must be a boolean" % line_no)
        current_obs.append(obs)
        current_act.append(act)
        if done:
            episodes.append(
                (np.asarray(current_obs, dtype=np.float64), np.asarray(current_act, dtype=np.float64))
            )
            current_obs, current_act = [], []
    if current_obs:
        episodes.append(
            (np.asarray(current_obs, dtype=np.float64), np.asarray(current_act, dtype=np.float64))
        )
    if not episodes:
        raise ValueError("dataset is empty")
    return episodes, obs_size, act_size


def build_chunks(episodes, chunk):
    """Episodes -> (obs, chunk targets, episode index per chunk).

    Episodes shorter than the chunk length cannot yield a training pair and
    are skipped — counted, not hidden: the report says how many episodes
    were dropped so a dataset of 20 episodes of 3 steps each never looks
    like a working dataset.
    """
    xs, ys, episode_of = [], [], []
    skipped = 0
    for episode_idx, (obs, act) in enumerate(episodes):
        steps = obs.shape[0]
        if steps < chunk:
            skipped += 1
            continue
        for t in range(steps - chunk + 1):
            xs.append(obs[t])
            ys.append(act[t : t + chunk].reshape(-1))
            episode_of.append(episode_idx)
    if not xs:
        raise ValueError(
            "no episode reaches the chunk length (%d): every episode is shorter "
            "than the chunk, so there is not a single (observation -> future "
            "chunk) pair to train on" % chunk
        )
    return (
        np.asarray(xs, dtype=np.float64),
        np.asarray(ys, dtype=np.float64),
        np.asarray(episode_of, dtype=np.int64),
        skipped,
    )


def split_episodes(num_episodes, val_fraction, seed):
    """Seeded train/validation split at EPISODE granularity.

    Chunks overlap in time, so a row-level split (offline-bc's) would leak
    near-identical windows across the boundary and flatter the validation
    score. Splitting by episode keeps the val estimate honest; the
    permutation comes from a dedicated stream so training shuffles cannot
    change val membership.
    """
    rng = np.random.default_rng(seed)
    permutation = rng.permutation(num_episodes)
    n_val = int(round(num_episodes * val_fraction))
    return permutation[n_val:], permutation[:n_val]


def standardize(x_train):
    """Mean/std of the TRAIN side; zero-variance dims map to std 1."""
    mean = x_train.mean(axis=0)
    std = x_train.std(axis=0)
    std = np.where(std < 1e-12, 1.0, std)
    return mean, std


# ---------------------------------------------------------------------------
# The DDPM schedule.
# ---------------------------------------------------------------------------

def beta_schedule(name, steps):
    """Per-step DDPM beta table (numpy, length `steps`).

    Two tables, each honest about what it is:

    * "cosine" — Nichol & Dhariwal (2021). alpha_bar follows a shifted
      cosine to ~0 by step T at ANY horizon, which is what makes small
      diffusion-step counts (the CPU budget here) valid; betas clipped to
      [1e-5, 0.999] exactly as the paper prescribes. This is the default.

      The 0.999 clip is load-bearing, not cosmetic. Uncapped, the shifted
      cosine drives alpha_bar to ~0 and the last beta toward 1.0; in the
      reverse update the last step's x0-prediction coefficient
      sqrt(beta_bar/alpha_bar) then grows toward 1/alpha_bar[T] ~ 3e2 at
      T=16, and any residual epsilon error of the learned denoiser gets
      AMPLIFIED by that factor into the final sample (measured on this
      engine's phase data: eps RMSE 0.10 became x error 3.2 -> raw chunk
      MSE ~30). The clipped terminal alpha_bar ~ 1e-3 keeps the same
      coefficient at ~sqrt(0.999/1e-3) ~ 31 in the beta ratio but the
      posterior-mean amplification bounded, which is exactly the regime
      the paper's own small-T experiments run in.
    * "linear" — Ho et al. (2020): betas linspace(1e-4, 0.02, T), the
      values tuned for T~1000. At the default T=16 it under-diffuses (the
      terminal state retains signal, so sampling from pure noise is
      out-of-distribution for the network); it is offered for schedule
      ablations at large T, and the docs say so.
    """
    steps = int(steps)
    if steps < 2:
        raise ValueError(
            "diffusion steps must be >= 2 (a one-step chain is not a chain), got %d"
            % steps
        )
    if name == "linear":
        return np.clip(np.linspace(1e-4, 0.02, steps), 1e-5, 0.999)
    if name == "cosine":
        offset = 0.008
        ticks = np.arange(steps + 1, dtype=np.float64) / steps
        f = np.cos((ticks + offset) / (1.0 + offset) * np.pi / 2.0) ** 2
        alpha_bar = f / f[0]
        # The paper's own beta clip: [1e-5, 0.999]. The upper bound keeps the
        # terminal alpha_bar strictly positive so the last reverse step's
        # posterior stays proper and the denoiser's epsilon error is not
        # amplified without bound (see the class docstring above).
        betas = 1.0 - alpha_bar[1:] / alpha_bar[:-1]
        return np.clip(betas, 1e-5, 0.999)
    raise ValueError(
        "schedule must be one of %s, got %r" % (", ".join(repr(s) for s in SCHEDULES), name)
    )


if torch is not None:

    class DiffusionSchedule:
        """DDPM coefficient tensors derived once from the beta table.

        Holds everything the training loop, the torch sampler, and the
        exported graph need: sqrt(alpha_bar), sqrt(1 - alpha_bar), the two
        posterior-mean coefficients, and the posterior std (sigma at the
        last reverse step is 0 — the standard convention). float32 tensors
        for the training loop; `sampler_schedule()` casts a float64 copy
        that drives the scoring sampler, whose T-step accumulation should
        be free of rounding noise in the reported metrics.
        """

        def __init__(self, name, steps):
            betas = beta_schedule(name, steps)
            self.name = name
            self.steps = int(steps)
            alpha = 1.0 - betas
            alpha_bar = np.cumprod(alpha)
            # alpha_bar_{k-1} with alpha_bar_{-1} = 1: at k=0 the posterior
            # mean collapses onto the x0 prediction.
            previous = np.concatenate([[1.0], alpha_bar[:-1]])
            one_minus = 1.0 - alpha_bar
            self.sqrt_alpha_bar = torch.from_numpy(
                np.sqrt(alpha_bar).astype(np.float32)
            )
            self.sqrt_one_minus_alpha_bar = torch.from_numpy(
                np.sqrt(one_minus).astype(np.float32)
            )
            self.posterior_mean_coef1 = torch.from_numpy(
                (np.sqrt(previous) * betas / one_minus).astype(np.float32)
            )
            self.posterior_mean_coef2 = torch.from_numpy(
                (np.sqrt(alpha) * (1.0 - previous) / one_minus).astype(np.float32)
            )
            posterior_variance = betas * (1.0 - previous) / one_minus
            posterior_variance[0] = 0.0
            self.posterior_std = torch.from_numpy(
                np.sqrt(posterior_variance).astype(np.float32)
            )
            self.alpha_bar = torch.from_numpy(alpha_bar.astype(np.float32))

        def sampler_schedule(self):
            """Float64 copy of this schedule for inference-side chains.

            The reverse loop's arithmetic is IDENTICAL in float32 and
            float64 except for rounding; a 16-step chain accumulates
            ~3e-5 of it. Scoring and the exported graph use the float64
            copy so the equivalence contract (allclose rtol 1e-4 /
            atol 1e-5) measures the graph, not the accumulation.
            """
            clone = DiffusionSchedule.__new__(DiffusionSchedule)
            clone.name = self.name
            clone.steps = self.steps
            clone.alpha_bar = self.alpha_bar.double()
            for key in ("sqrt_alpha_bar", "sqrt_one_minus_alpha_bar",
                        "posterior_mean_coef1", "posterior_mean_coef2",
                        "posterior_std"):
                setattr(clone, key, getattr(self, key).double())
            return clone


# ---------------------------------------------------------------------------
# The denoiser: conditional 1D UNet over the action-chunk horizon.
# ---------------------------------------------------------------------------

if torch is not None:

    def _norm_groups(channels):
        """GroupNorm group count that divides `channels` (8 preferred)."""
        for groups in (8, 4, 2):
            if channels % groups == 0:
                return groups
        return 1

    def sinusoidal_table(steps, dim):
        """(steps, dim) sinusoidal step embedding table (dim must be even).

        Row k encodes the reverse-step index through sin/cos of geometrically
        spaced frequencies — the standard DDPM time embedding. Registered as
        a buffer so it lands in the state dict (and therefore in the model
        JSON) and becomes a graph constant at export.
        """
        half = dim // 2
        positions = np.arange(steps, dtype=np.float64)
        frequencies = np.exp(
            -np.log(10000.0) * np.arange(half, dtype=np.float64) / max(half - 1, 1)
        )
        angles = positions[:, None] * frequencies[None, :]
        return np.concatenate([np.sin(angles), np.cos(angles)], axis=1)

    class FiLM(nn.Module):
        """Feature-wise linear modulation from the conditioning vector.

        The Diffusion Policy conditioning mechanism: a per-block linear map
        of (time embedding + observation embedding) to per-channel scale and
        shift, applied across the time axis. The observation reaches every
        denoising layer through this path; the diffusion step k modulates
        each layer's response alongside it.
        """

        def __init__(self, cond_dim, channels):
            super().__init__()
            self.proj = nn.Linear(cond_dim, 2 * channels)

        def forward(self, x, cond):
            gamma, beta = self.proj(cond).chunk(2, dim=-1)
            return x * (1.0 + gamma.unsqueeze(-1)) + beta.unsqueeze(-1)

    class ResidualBlock1d(nn.Module):
        """Pre-norm residual block over the time axis.

        GroupNorm + SiLU, temporal convolution, FiLM conditioning,
        GroupNorm + SiLU, temporal convolution, and an identity (or 1x1)
        shortcut when the channel count changes.
        """

        def __init__(self, in_channels, out_channels, cond_dim, kernel=KERNEL):
            super().__init__()
            self.norm1 = nn.GroupNorm(_norm_groups(in_channels), in_channels)
            self.conv1 = nn.Conv1d(in_channels, out_channels, kernel, padding=kernel // 2)
            self.film = FiLM(cond_dim, out_channels)
            self.norm2 = nn.GroupNorm(_norm_groups(out_channels), out_channels)
            self.conv2 = nn.Conv1d(out_channels, out_channels, kernel, padding=kernel // 2)
            if in_channels == out_channels:
                self.shortcut = nn.Identity()
            else:
                self.shortcut = nn.Conv1d(in_channels, out_channels, 1)

        def forward(self, x, cond):
            hidden = self.conv1(F.silu(self.norm1(x)))
            hidden = self.film(hidden, cond)
            hidden = self.conv2(F.silu(self.norm2(hidden)))
            return hidden + self.shortcut(x)

    class UNet1D(nn.Module):
        """Conditional 1D UNet denoiser (Diffusion Policy's CNN backbone).

        Input: the noisy action block (batch, act_dim, horizon) in
        normalized action space. Conditioning: the observation, encoded by a
        two-layer MLP into `cond_dim`, plus the diffusion step k, embedded
        by a sinusoidal table + MLP; their sum FiLM-modulates every residual
        block. Encoder: two residual-block levels at channels[0] and
        channels[1] with stride-2 temporal downsampling; a bottleneck at
        channels[2]; a decoder mirroring the path with transposed
        convolutions and channel-concatenation skip connections; a
        GroupNorm + SiLU + temporal-conv head predicting the added noise.

        The horizon is zero-padded to a multiple of 4 (two downsampling
        levels) so every skip connection meets its mirror exactly; the
        padding is part of the diffusion state itself (train targets and
        sampler noise live at the padded length, the padded tail is cropped
        only after the final reverse step), which keeps training and
        sampling consistent about what the tail positions contain.
        """

        def __init__(self, act_dim, horizon, obs_size, channels, cond_dim,
                     kernel=KERNEL, diffusion_steps=16):
            super().__init__()
            if cond_dim % 2 != 0:
                raise ValueError(
                    "cond dim (d-model) must be even for the sinusoidal step "
                    "embedding, got %d" % cond_dim
                )
            if len(channels) != 3:
                raise ValueError("channels must list exactly 3 level widths")
            self.act_dim = int(act_dim)
            self.horizon = int(horizon)
            self.obs_size = int(obs_size)
            self.channels = [int(c) for c in channels]
            self.cond_dim = int(cond_dim)
            self.kernel = int(kernel)
            self.diffusion_steps = int(diffusion_steps)
            self.padded_horizon = ((self.horizon + 3) // 4) * 4

            table = sinusoidal_table(self.diffusion_steps, self.cond_dim)
            self.register_buffer("time_table", torch.from_numpy(table.astype(np.float32)))
            self.time_mlp = nn.Sequential(
                nn.Linear(self.cond_dim, self.cond_dim),
                nn.SiLU(),
                nn.Linear(self.cond_dim, self.cond_dim),
            )
            self.obs_mlp = nn.Sequential(
                nn.Linear(self.obs_size, self.cond_dim),
                nn.SiLU(),
                nn.Linear(self.cond_dim, self.cond_dim),
            )

            c0, c1, c2 = self.channels
            self.input_conv = nn.Conv1d(self.act_dim, c0, self.kernel, padding=self.kernel // 2)
            self.enc1 = nn.ModuleList(
                [ResidualBlock1d(c0, c0, self.cond_dim, self.kernel) for _ in range(2)]
            )
            self.down1 = nn.Conv1d(c0, c1, 4, stride=2, padding=1)
            self.enc2 = nn.ModuleList(
                [ResidualBlock1d(c1, c1, self.cond_dim, self.kernel) for _ in range(2)]
            )
            self.down2 = nn.Conv1d(c1, c2, 4, stride=2, padding=1)
            self.mid = nn.ModuleList(
                [ResidualBlock1d(c2, c2, self.cond_dim, self.kernel) for _ in range(2)]
            )
            self.up2 = nn.ConvTranspose1d(c2, c1, 4, stride=2, padding=1)
            self.dec2 = nn.ModuleList(
                [
                    ResidualBlock1d(2 * c1, c1, self.cond_dim, self.kernel),
                    ResidualBlock1d(c1, c1, self.cond_dim, self.kernel),
                ]
            )
            self.up1 = nn.ConvTranspose1d(c1, c0, 4, stride=2, padding=1)
            self.dec1 = nn.ModuleList(
                [
                    ResidualBlock1d(2 * c0, c0, self.cond_dim, self.kernel),
                    ResidualBlock1d(c0, c0, self.cond_dim, self.kernel),
                ]
            )
            self.out_norm = nn.GroupNorm(_norm_groups(c0), c0)
            self.out_conv = nn.Conv1d(c0, self.act_dim, self.kernel, padding=self.kernel // 2)

        def embed_observation(self, obs_normalized):
            """Observation conditioning vector (B, cond_dim)."""
            return self.obs_mlp(obs_normalized)

        def forward(self, noisy_actions, steps, obs_cond):
            """Predict the noise in `noisy_actions` (B, act, padded).

            `steps` is either a (B,) long tensor (training: one diffusion
            step per row) or a plain int (sampling loops: the step of this
            reverse iteration). `obs_cond` comes from `embed_observation`.
            """
            step_embedding = self.time_mlp(self.time_table[steps])
            cond = step_embedding + obs_cond
            x = self.input_conv(noisy_actions)
            x = self.enc1[0](x, cond)
            x = self.enc1[1](x, cond)
            skip1 = x
            x = self.down1(x)
            x = self.enc2[0](x, cond)
            x = self.enc2[1](x, cond)
            skip2 = x
            x = self.down2(x)
            x = self.mid[0](x, cond)
            x = self.mid[1](x, cond)
            x = self.up2(x)
            x = torch.cat([x, skip2], dim=1)
            x = self.dec2[0](x, cond)
            x = self.dec2[1](x, cond)
            x = self.up1(x)
            x = torch.cat([x, skip1], dim=1)
            x = self.dec1[0](x, cond)
            x = self.dec1[1](x, cond)
            return self.out_conv(F.silu(self.out_norm(x)))

    class ExponentialMovingAverage:
        """Lightweight EMA shadow over the model's PARAMETERS.

        Buffers (the sinusoidal table) are constant during training and stay
        untouched — the average is over the learned weights only. The
        exported, rebuilt and scored model all use the EMA state, which is
        the paper's own evaluation convention and damps the last few
        optimizer steps' jitter out of the shipped artifact.
        """

        def __init__(self, model, decay):
            if not (0.0 < decay < 1.0):
                raise ValueError("ema-decay must be in (0, 1), got %r" % (decay,))
            self.decay = float(decay)
            self.shadow = {
                name: parameter.detach().clone()
                for name, parameter in model.named_parameters()
            }

        def update(self, model):
            with torch.no_grad():
                for name, parameter in model.named_parameters():
                    self.shadow[name].mul_(self.decay).add_(
                        parameter.detach(), alpha=1.0 - self.decay
                    )

        def copy_into(self, model):
            model.load_state_dict(self.shadow, strict=False)

    def pad_horizon(x, padded_horizon):
        """Zero-pad the time axis (last dim) up to `padded_horizon`."""
        deficit = padded_horizon - x.shape[-1]
        if deficit <= 0:
            return x
        return F.pad(x, (0, deficit))

    def crop_horizon(x, horizon):
        """Crop the time axis (last dim) down to `horizon`."""
        if x.shape[-1] <= horizon:
            return x
        return x[..., :horizon]

    def sample_chunks(model, schedule, obs_normalized, generator):
        """Seeded reverse diffusion: pure noise -> chunks, normalized space.

        The z draws come from the caller's generator, so sampling is exactly
        as reproducible as training. The model and schedule must already be
        float64 (the caller casts): a T-step chain in float32 accumulates
        rounding the equivalence contract would then misread as drift.
        Returns (batch, chunk, act_dim) in normalized action units; the
        caller de-normalizes.

        The x0 prediction is clamped to [-1, 1] at every reverse step —
        diffusers' `clip_denoised=True`, the DDPM convention. It is not a
        cosmetic guard: near the end of the cosine chain sqrt(alpha_bar)
        shrinks to ~6e-3, so the (x - s*eps)/sqrt(ab) reconstruction
        divides the denoiser's residual epsilon error by that number —
        an amplification of ~1.6e2 that turns a 0.1-rad epsilon error into
        a sample tens of units outside the data support. Clamping the x0
        hypothesis to the normalized action space bounds the damage every
        step does; the posterior mean then mixes a SUPPORTED x0 hypothesis
        with the current state instead of an amplified fantasy.
        """
        batch = obs_normalized.shape[0]
        act_dim = model.act_dim
        padded = model.padded_horizon
        with torch.no_grad():
            x = torch.randn(batch, act_dim, padded, generator=generator,
                            dtype=torch.float64, device=obs_normalized.device)
            cond = model.embed_observation(obs_normalized)
            for k in range(schedule.steps - 1, -1, -1):
                noise_hat = model(x, k, cond)
                x0 = (
                    x - schedule.sqrt_one_minus_alpha_bar[k] * noise_hat
                ) / schedule.sqrt_alpha_bar[k]
                x0 = x0.clamp(-1.0, 1.0)
                mean = (
                    schedule.posterior_mean_coef1[k] * x0
                    + schedule.posterior_mean_coef2[k] * x
                )
                if k > 0:
                    z = torch.randn(batch, act_dim, padded, generator=generator,
                                    dtype=torch.float64, device=obs_normalized.device)
                    x = mean + schedule.posterior_std[k] * z
                else:
                    x = mean
            x = crop_horizon(x, model.horizon)
            return x.transpose(1, 2).contiguous()

    def _sampler_noise(model, generator):
        """Frozen reverse-process realization for the exported graph.

        Row 0 is the x_T draw; row (T - k) is the z draw of reverse step k.
        Rows are drawn in exactly the order `sample_chunks` consumes them at
        batch 1, so with the same generator seed the frozen artifact IS the
        seeded stochastic sampler's realization for single-row batches —
        the parity the export test proves.
        """
        act_dim = model.act_dim
        padded = model.padded_horizon
        steps = model.diffusion_steps
        noise = torch.empty(steps, act_dim, padded, dtype=torch.float32)
        noise[0] = torch.randn(1, act_dim, padded, generator=generator)
        for k in range(steps - 1, 0, -1):
            noise[steps - k] = torch.randn(1, act_dim, padded, generator=generator)
        return noise

    class DiffusionActor(nn.Module):
        """Export/eval wrapper: the WHOLE T-step reverse sampler in forward.

        Observation normalization is folded in at the input, action
        de-normalization is folded out at the chunk, and the output is
        clamped to the normalized action space [-1, 1] — the platform's
        safety convention (act's DeterministicActor and starter-ppo's export
        do the same): the board runtime treats policy output as normalized
        commands and scales them by its MAX_LINEAR/MAX_ANGULAR rails, so an
        artifact whose graph itself saturates at [-1, 1] can never command a
        speed the runtime did not budget for — even if the weights drift.

        The reverse-process noise is the FROZEN realization supplied at
        construction (registered buffers, one row per draw). Freezing the
        draw makes the artifact deterministic — one observation maps to one
        action chunk, the deployable-policy contract — while remaining the
        seeded sampler's own realization (see `_sampler_noise`).
        """

        def __init__(self, model, schedule, obs_mean, obs_std, act_mean, act_std, noise):
            super().__init__()
            self.model = model
            self.register_buffer("obs_mean", obs_mean)
            self.register_buffer("obs_std", obs_std)
            # Chunk statistics are estimated on the flattened (chunk*act)
            # target; the prediction is (batch, chunk, act), so the buffers
            # are reshaped once here to broadcast correctly.
            self.register_buffer("act_mean", act_mean.reshape(1, model.horizon, model.act_dim))
            self.register_buffer("act_std", act_std.reshape(1, model.horizon, model.act_dim))
            self.register_buffer("sqrt_alpha_bar", schedule.sqrt_alpha_bar)
            self.register_buffer("sqrt_one_minus_alpha_bar", schedule.sqrt_one_minus_alpha_bar)
            self.register_buffer("posterior_mean_coef1", schedule.posterior_mean_coef1)
            self.register_buffer("posterior_mean_coef2", schedule.posterior_mean_coef2)
            self.register_buffer("posterior_std", schedule.posterior_std)
            self.register_buffer("sampler_noise", noise)

        def forward(self, observation):
            # Arithmetic mirrors `sample_chunks` op for op (including the
            # x0 clamp — see its docstring) so the exported graph and the
            # torch sampler are the same function up to float rounding.
            normalized = (observation - self.obs_mean) / self.obs_std
            cond = self.model.embed_observation(normalized)
            x = self.sampler_noise[0].expand(observation.shape[0], -1, -1)
            steps = self.model.diffusion_steps
            for k in range(steps - 1, -1, -1):
                noise_hat = self.model(x, k, cond)
                x0 = (
                    x - self.sqrt_one_minus_alpha_bar[k] * noise_hat
                ) / self.sqrt_alpha_bar[k]
                x0 = x0.clamp(-1.0, 1.0)
                mean = self.posterior_mean_coef1[k] * x0 + self.posterior_mean_coef2[k] * x
                if k > 0:
                    x = mean + self.posterior_std[k] * self.sampler_noise[steps - k]
                else:
                    x = mean
            x = x[..., : self.model.horizon]
            chunk = x.transpose(1, 2) * self.act_std + self.act_mean
            return chunk.clamp(-1.0, 1.0)

    def _state_to_lists(module):
        return {
            name: value.detach().cpu().numpy().tolist()
            for name, value in module.state_dict().items()
        }

    def rebuild_model(payload):
        """Reconstruct a forward-identical torch module from the model JSON.

        This is what makes the JSON payload auditable: the saved file is the
        model, not a summary of it. Buffers (the sinusoidal step table) come
        back via load_state_dict, so even the embedding constants are the
        ones that ran.
        """
        arch = payload["architecture"]
        model = UNet1D(
            payload["action_size"],
            payload["chunk"],
            payload["observation_size"],
            channels=tuple(arch["channels"]),
            cond_dim=arch["condDim"],
            kernel=arch["kernel"],
            diffusion_steps=arch["diffusionSteps"],
        )
        state = {
            name: torch.as_tensor(np.asarray(value), dtype=torch.float32)
            for name, value in payload["state"].items()
        }
        model.load_state_dict(state)
        model.eval()
        return model


# ---------------------------------------------------------------------------
# Training.
# ---------------------------------------------------------------------------

def validate_hyperparameters(chunk, diffusion_steps, schedule, channels, d_model,
                             epochs, lr, batch_size, val_fraction, ema_decay):
    """Fail-closed hyperparameter contract shared by CLI and programmatic use."""
    if int(chunk) <= 0:
        raise ValueError("chunk must be positive, got %r" % (chunk,))
    if int(diffusion_steps) < 2:
        raise ValueError(
            "diffusion-steps must be >= 2 (a one-step chain is not a chain), got %r"
            % (diffusion_steps,)
        )
    if schedule not in SCHEDULES:
        raise ValueError(
            "schedule must be one of %s, got %r" % (", ".join(repr(s) for s in SCHEDULES), schedule)
        )
    if int(channels) <= 0:
        raise ValueError("channels must be positive, got %r" % (channels,))
    if int(d_model) <= 0 or int(d_model) % 2 != 0:
        raise ValueError(
            "d-model must be a positive even integer (sinusoidal step embedding), got %r"
            % (d_model,)
        )
    if int(epochs) <= 0:
        raise ValueError("epochs must be positive, got %r" % (epochs,))
    if float(lr) <= 0.0:
        raise ValueError("lr must be positive, got %r" % (lr,))
    if int(batch_size) <= 0:
        raise ValueError("batch must be positive, got %r" % (batch_size,))
    if not (0.0 <= float(val_fraction) < 1.0):
        raise ValueError("val-fraction must be in [0, 1), got %r" % (val_fraction,))
    if not (0.0 < float(ema_decay) < 1.0):
        raise ValueError("ema-decay must be in (0, 1), got %r" % (ema_decay,))


def fit(episodes, chunk=8, diffusion_steps=16, schedule="cosine", channels=32,
        d_model=64, epochs=200, lr=1e-3, batch_size=32, seed=0,
        val_fraction=0.2, ema_decay=0.995):
    """Split by episode, standardize on the train side, train the denoiser
    with the DDPM noise-prediction MSE, EMA the weights, then score with the
    REAL reverse sampler in raw action units.

    Progress lines are honest and unprefixed: `iter N/M denoiseLoss=...
    valLoss=...`. This is an imitation engine — there is no reward or
    success rate to report, so none is invented; the two numbers are the
    training-batch denoising loss and a fixed-draw validation denoising
    loss (the validation (k, eps) draws are generated once from a dedicated
    stream, so the curve moves because the model learns, not because the
    probe was resampled).

    Returns (payload, report, model, normalization, schedule). The payload
    carries every EMA weight; `rebuild_model` turns it back into the same
    network.
    """
    if torch is None:
        raise RuntimeError("torch is not installed")
    validate_hyperparameters(
        chunk, diffusion_steps, schedule, channels, d_model, epochs, lr,
        batch_size, val_fraction, ema_decay,
    )
    obs_size = episodes[0][0].shape[1]
    act_size = episodes[0][1].shape[1]
    x, y, episode_of, skipped = build_chunks(episodes, chunk)
    num_episodes = len(episodes)

    if val_fraction > 0:
        train_episodes, val_episodes = split_episodes(num_episodes, val_fraction, seed)
        if len(train_episodes) < MIN_TRAIN_EPISODES or len(val_episodes) < MIN_VAL_EPISODES:
            raise ValueError(
                "dataset too small for a %.0f%% episode-level validation split "
                "(%d episodes); pass --val-fraction 0 to disable validation "
                "explicitly" % (val_fraction * 100, num_episodes)
            )
        train_mask = np.isin(episode_of, train_episodes)
        val_mask = np.isin(episode_of, val_episodes)
    else:
        train_episodes = np.arange(num_episodes)
        val_episodes = np.array([], dtype=np.int64)
        train_mask = np.ones(len(x), dtype=bool)
        val_mask = np.zeros(len(x), dtype=bool)
    x_train, y_train = x[train_mask], y[train_mask]
    x_val, y_val = x[val_mask], y[val_mask]

    obs_mean, obs_std = standardize(x_train)
    act_mean, act_std = standardize(y_train)

    torch.set_num_threads(1)
    torch.manual_seed(seed)
    channel_list = [int(channels), int(channels) * 2, int(channels) * 4]
    model = UNet1D(
        act_size, chunk, obs_size, channels=channel_list, cond_dim=int(d_model),
        kernel=KERNEL, diffusion_steps=int(diffusion_steps),
    )
    model.float()
    ddpm = DiffusionSchedule(schedule, diffusion_steps)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    ema = ExponentialMovingAverage(model, ema_decay)

    x_train_n = torch.from_numpy(((x_train - obs_mean) / obs_std).astype(np.float32))
    y_train_n = torch.from_numpy(((y_train - act_mean) / act_std).astype(np.float32))
    x_val_n = torch.from_numpy(((x_val - obs_mean) / obs_std).astype(np.float32))
    y_val_n = torch.from_numpy(((y_val - act_mean) / act_std).astype(np.float32))
    padded = model.padded_horizon

    def action_block(flat):
        """(rows, chunk*act) normalized flat target -> (rows, act, padded)."""
        cube = flat.reshape(flat.shape[0], chunk, act_size).permute(0, 2, 1)
        return pad_horizon(cube, padded)

    shuffle_rng = torch.Generator()
    shuffle_rng.manual_seed(seed + SEED_OFFSETS["shuffle"])
    step_rng = torch.Generator()
    step_rng.manual_seed(seed + SEED_OFFSETS["diffusion_step"])
    noise_rng = torch.Generator()
    noise_rng.manual_seed(seed + SEED_OFFSETS["training_noise"])

    # Fixed validation probe: (k, eps) drawn once so every valLoss on the
    # progress curve measures the same quantity.
    val_rows = int(x_val_n.shape[0])
    if val_rows > 0:
        val_rng = torch.Generator()
        val_rng.manual_seed(seed + SEED_OFFSETS["validation_draws"])
        val_k = torch.randint(0, int(diffusion_steps), (val_rows,), generator=val_rng)
        val_eps = torch.randn(val_rows, act_size, padded, generator=val_rng)
        val_blocks = action_block(y_val_n)

        def fixed_val_denoise_loss():
            with torch.no_grad():
                coeff = ddpm.sqrt_alpha_bar[val_k].view(-1, 1, 1)
                noise_coeff = ddpm.sqrt_one_minus_alpha_bar[val_k].view(-1, 1, 1)
                noisy = coeff * val_blocks + noise_coeff * val_eps
                cond = model.embed_observation(x_val_n)
                predicted = model(noisy, val_k, cond)
                return float(torch.mean((predicted - val_eps) ** 2))
    else:

        def fixed_val_denoise_loss():
            return float("nan")

    rows = x_train_n.shape[0]
    batch_size = min(batch_size, rows)
    total_iterations = epochs * math.ceil(rows / batch_size)
    # Progress cadence: bounded line count (the worker tails stdout), the
    # honest numbers unchanged.
    log_every = max(1, total_iterations // 100)
    val_every = max(1, total_iterations // 10)
    current_val = fixed_val_denoise_loss()
    initial_val = current_val
    last_batch_loss = float("nan")

    model.train()
    iteration = 0
    for _ in range(epochs):
        order = torch.randperm(rows, generator=shuffle_rng)
        for start in range(0, rows, batch_size):
            batch = order[start : start + batch_size]
            xb, yb = x_train_n[batch], y_train_n[batch]
            block = action_block(yb)
            k = torch.randint(0, int(diffusion_steps), (block.shape[0],), generator=step_rng)
            eps = torch.randn(block.shape, generator=noise_rng)
            coeff = ddpm.sqrt_alpha_bar[k].view(-1, 1, 1)
            noise_coeff = ddpm.sqrt_one_minus_alpha_bar[k].view(-1, 1, 1)
            noisy = coeff * block + noise_coeff * eps
            cond = model.embed_observation(xb)
            predicted = model(noisy, k, cond)
            loss = torch.mean((predicted - eps) ** 2)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            ema.update(model)
            iteration += 1
            last_batch_loss = float(loss.detach())
            if val_rows > 0 and (iteration % val_every == 0 or iteration == total_iterations):
                current_val = fixed_val_denoise_loss()
            if iteration % log_every == 0 or iteration == total_iterations:
                print(
                    "iter %d/%d denoiseLoss=%.6f valLoss=%.6f"
                    % (iteration, total_iterations, last_batch_loss, current_val),
                    flush=True,
                )

    # From here on the model IS the EMA model: scoring, export, and the
    # saved state all use the averaged weights.
    ema.copy_into(model)
    model.eval()
    final_val = fixed_val_denoise_loss()

    # ---- Scoring in RAW action units with the real sampler. ----
    # The sampler runs in float64 (same arithmetic as the exported graph):
    # a T-step reverse chain accumulates ~3e-5 of float32 rounding, which
    # would land in the reported metrics as noise. The float32 model is
    # saved; a float64 cast of the same weights does the inference.
    act_mean_cube = act_mean.reshape(1, chunk, act_size)
    act_std_cube = act_std.reshape(1, chunk, act_size)
    sampler_generator = torch.Generator()
    sampler_generator.manual_seed(seed + SEED_OFFSETS["scoring_sampler"])
    model64 = model.double()
    schedule64 = ddpm.sampler_schedule()

    def sampled_chunks_raw(xs):
        normalized = torch.from_numpy(((xs - obs_mean) / obs_std).astype(np.float64))
        pieces = []
        for start in range(0, normalized.shape[0], SAMPLER_BATCH):
            pieces.append(
                sample_chunks(
                    model64, schedule64, normalized[start : start + SAMPLER_BATCH],
                    sampler_generator,
                )
            )
        if not pieces:
            return None
        return torch.cat(pieces, dim=0).numpy() * act_std_cube + act_mean_cube

    train_pred = sampled_chunks_raw(x_train)
    train_mse = None
    if train_pred is not None:
        train_mse = float(np.mean((train_pred.reshape(train_pred.shape[0], -1) - y_train) ** 2))

    val_mse, per_horizon = None, None
    val_pred = sampled_chunks_raw(x_val)
    if val_pred is not None:
        val_mse = float(np.mean((val_pred.reshape(val_pred.shape[0], -1) - y_val) ** 2))
        y_val_cube = y_val.reshape(-1, chunk, act_size)
        per_horizon = [
            float(np.mean((val_pred[:, h, :] - y_val_cube[:, h, :]) ** 2))
            for h in range(chunk)
        ]
    model = model.float()

    payload = {
        "format": MODEL_FORMAT,
        "observation_size": int(obs_size),
        "action_size": int(act_size),
        "chunk": int(chunk),
        "architecture": {
            "channels": channel_list,
            "condDim": int(d_model),
            "kernel": int(KERNEL),
            "diffusionSteps": int(diffusion_steps),
            "schedule": schedule,
            "paddedHorizon": int(padded),
        },
        "normalization": {
            "observation": {"mean": obs_mean.tolist(), "std": obs_std.tolist()},
            "action": {"mean": act_mean.tolist(), "std": act_std.tolist()},
        },
        "ema": {"decay": float(ema_decay)},
        "state": _state_to_lists(model),
    }
    report = {
        "trainChunkMse": train_mse,
        "validation": {
            "enabled": bool(val_fraction > 0),
            "chunkMse": val_mse,
            "perHorizonMse": per_horizon,
            "denoiseLoss": final_val,
        },
        "initialValDenoiseLoss": initial_val,
        "lastBatchDenoiseLoss": last_batch_loss,
        "diffusion": {"steps": int(diffusion_steps), "schedule": schedule},
        "emaDecay": float(ema_decay),
        "epochs": int(epochs),
        "learningRate": float(lr),
        "batchSize": int(batch_size),
        "seed": int(seed),
        "chunk": int(chunk),
        "samples": {
            "train": int(train_mask.sum()),
            "val": int(val_mask.sum()),
            "episodes": int(num_episodes),
            "trainEpisodes": int(len(train_episodes)),
            "valEpisodes": int(len(val_episodes)),
            "skippedShortEpisodes": int(skipped),
        },
        "edgeEstimate": estimate_denoise_cost(model),
    }
    return payload, report, model, (obs_mean, obs_std, act_mean, act_std), ddpm


# ---------------------------------------------------------------------------
# ONNX export with proof.
# ---------------------------------------------------------------------------

def export_onnx(model, normalization, schedule, path, x_check, seed=0):
    """Export the full sampler graph and PROVE it against the torch forward.

    The exported graph is the entire T-step reverse diffusion loop: one
    observation in, one clamped action chunk out. onnxruntime runs the
    graph on real dataset rows and compares elementwise against the torch
    `DiffusionActor` (both float32, allclose rtol 1e-4 / atol 1e-5). A
    mismatch deletes the file and fails the run — an unverified export is
    never kept.
    """
    if torch is None:
        raise RuntimeError("torch is not installed")
    try:
        import onnx  # noqa: F401 - presence check
    except ImportError:
        return {"exported": False, "equivalence": "skipped-no-onnx"}

    obs_mean, obs_std, act_mean, act_std = normalization
    noise_rng = torch.Generator()
    noise_rng.manual_seed(seed + SEED_OFFSETS["export_noise"])
    noise = _sampler_noise(model, noise_rng)
    # The graph is exported in float32 (onnxruntime ships no double Conv
    # kernel), and the equivalence reference is the SAME float32 torch
    # actor — arithmetic-identical to the graph, op for op. A float64
    # reference would fail on the chain's f32 rounding (~3e-5) and measure
    # nothing about the exporter; the honest check is graph-vs-torch under
    # the same precision, against allclose rtol 1e-4 / atol 1e-5.
    actor = DiffusionActor(
        model,
        schedule,
        torch.from_numpy(obs_mean.astype(np.float32)),
        torch.from_numpy(obs_std.astype(np.float32)),
        torch.from_numpy(act_mean.astype(np.float32)),
        torch.from_numpy(act_std.astype(np.float32)),
        noise,
    )
    actor.eval()
    dummy = torch.zeros(1, model.obs_size, dtype=torch.float32)
    import warnings

    with warnings.catch_warnings():
        # The legacy TorchScript exporter emits a migration DeprecationWarning
        # on torch>=2.9; keep it out of the worker-captured stderr.
        warnings.filterwarnings("ignore", category=DeprecationWarning)
        torch.onnx.export(
            actor,
            (dummy,),
            path,
            input_names=["observation"],
            output_names=["chunk_actions"],
            dynamic_axes={
                "observation": {0: "batch"},
                "chunk_actions": {0: "batch"},
            },
            opset_version=ONNX_OPSET,
        )
    data = pathlib.Path(path).read_bytes()

    try:
        import onnxruntime as ort
    except ImportError:
        return {
            "exported": True,
            "equivalence": "skipped-no-onnxruntime",
            "sizeBytes": len(data),
            "diffusionSteps": int(model.diffusion_steps),
        }

    session = ort.InferenceSession(
        pathlib.Path(path).as_posix(), providers=["CPUExecutionProvider"]
    )
    rows = x_check[:EQUIVALENCE_ROWS].astype(np.float32)
    with torch.no_grad():
        expected = actor(torch.from_numpy(rows)).numpy()
    actual = session.run(["chunk_actions"], {"observation": rows})[0]
    worst = float(np.max(np.abs(expected - actual)))
    matched = bool(
        np.allclose(expected, actual, rtol=EQUIVALENCE_RTOL, atol=EQUIVALENCE_ATOL)
    )
    if not matched:
        pathlib.Path(path).unlink()
        raise ValueError(
            "ONNX sampler disagrees with the torch sampler (max |diff| %.3g, "
            "allclose rtol %.0e atol %.0e); the unverified file was not kept"
            % (worst, EQUIVALENCE_RTOL, EQUIVALENCE_ATOL)
        )
    return {
        "exported": True,
        "equivalence": "verified",
        "maxAbsDiff": worst,
        "checkedRows": int(rows.shape[0]),
        "sizeBytes": len(data),
        "diffusionSteps": int(model.diffusion_steps),
    }


# ---------------------------------------------------------------------------
# Edge feasibility: analytic cost estimate + measured sampler latency.
# ---------------------------------------------------------------------------

def estimate_denoise_cost(model):
    """Parameter count (exact) and estimated FLOPs of ONE denoise step.

    The FLOPs estimate comes from shape instrumentation of a real forward
    pass (forward hooks over the convolutions and linears: 2 x weights x
    output elements), so it tracks the architecture even when the layer
    widths are edited. GroupNorm/SiLU elementwise cost is excluded — it is
    two orders below the convolutions at this scale. One DECISION costs
    `samplingFlopsPerDecision` = steps x per-step, because the whole
    reverse chain runs per chunk prediction.
    """
    if torch is None:
        raise RuntimeError("torch is not installed")
    parameter_count = sum(parameter.numel() for parameter in model.parameters())
    flops = [0]
    handles = []

    def conv_hook(module, inputs, output):
        kernel = module.kernel_size[0]
        batch = output.shape[0]
        if isinstance(module, nn.ConvTranspose1d):
            in_length = inputs[0].shape[-1]
            flops[0] += (
                2 * module.in_channels * module.out_channels * kernel * in_length * batch
            )
        else:
            out_length = output.shape[-1]
            flops[0] += (
                2
                * module.out_channels
                * (module.in_channels // module.groups)
                * kernel
                * out_length
                * batch
            )

    def linear_hook(module, inputs, output):
        rows = output.numel() // module.out_features if module.out_features else 0
        flops[0] += 2 * module.in_features * module.out_features * rows

    for module in model.modules():
        if isinstance(module, (nn.Conv1d, nn.ConvTranspose1d)):
            handles.append(module.register_forward_hook(conv_hook))
        elif isinstance(module, nn.Linear):
            handles.append(module.register_forward_hook(linear_hook))
    try:
        with torch.no_grad():
            dummy_x = torch.zeros(1, model.act_dim, model.padded_horizon)
            dummy_cond = torch.zeros(1, model.cond_dim)
            model(dummy_x, 0, dummy_cond)
    finally:
        for handle in handles:
            handle.remove()
    return {
        "parameterCount": int(parameter_count),
        "denoiseFlopsPerStep": int(flops[0]),
        "diffusionSteps": int(model.diffusion_steps),
        "samplingFlopsPerDecision": int(flops[0] * model.diffusion_steps),
        "horizon": int(model.horizon),
        "actionDim": int(model.act_dim),
    }


def platform_label():
    """Short host label for measured-evidence blocks (context, not proof)."""
    import platform

    return "%s/%s" % (platform.system(), platform.machine())


def measure_edge_feasibility(model, normalization, schedule, x_rows, seed=0,
                             decision_hz=None, iterations=8):
    """Edge-execution evidence, measured not asserted.

    Times the FULL T-step sampling graph (the per-decision cost a board
    runtime pays — one inference per chunk of k control steps, so the
    affordable control rate is k / t_decision). Both numbers land in the
    result with the measured context (iterations, host) — a deployment
    checks them against its own board-latency receipt instead of trusting
    a claim. Uses onnxruntime when available (the artifact the board
    actually runs) and falls back to timed torch sampling otherwise,
    labeled honestly.
    """
    if torch is None:
        raise RuntimeError("torch is not installed")
    obs_mean, obs_std, act_mean, act_std = normalization
    noise_rng = torch.Generator()
    noise_rng.manual_seed(seed + SEED_OFFSETS["export_noise"])
    noise = _sampler_noise(model, noise_rng)
    # The measurement runs the SAME float32 sampler construction that is
    # exported and verified, so the number a deployment reads describes the
    # artifact it would run, not a cheaper stand-in.
    actor = DiffusionActor(
        model,
        schedule,
        torch.from_numpy(obs_mean.astype(np.float32)),
        torch.from_numpy(obs_std.astype(np.float32)),
        torch.from_numpy(act_mean.astype(np.float32)),
        torch.from_numpy(act_std.astype(np.float32)),
        noise,
    )
    actor.eval()
    batch = np.asarray(x_rows[:1], dtype=np.float32)
    import warnings

    engine = "torch"
    measured = None
    try:
        import onnxruntime as ort

        scratch = pathlib.Path(os.environ.get("RDK_DP_EDGE_SCRATCH", "."))
        probe = scratch / "edge-feasibility-probe.onnx"
        with warnings.catch_warnings():
            warnings.filterwarnings("ignore", category=DeprecationWarning)
            torch.onnx.export(
                actor,
                (torch.zeros(1, model.obs_size, dtype=torch.float32),),
                probe.as_posix(),
                input_names=["observation"],
                output_names=["chunk_actions"],
                dynamic_axes={
                    "observation": {0: "batch"},
                    "chunk_actions": {0: "batch"},
                },
                opset_version=ONNX_OPSET,
            )
        session = ort.InferenceSession(
            probe.as_posix(), providers=["CPUExecutionProvider"]
        )
        session.run(["chunk_actions"], {"observation": batch})  # warmup
        start = time.perf_counter()
        for _ in range(iterations):
            session.run(["chunk_actions"], {"observation": batch})
        measured = (time.perf_counter() - start) / iterations
        engine = "onnxruntime"
        probe.unlink(missing_ok=True)
    except ImportError:
        pass

    if measured is None:
        with torch.no_grad():
            actor(torch.from_numpy(batch))  # warmup
        start = time.perf_counter()
        for _ in range(iterations):
            with torch.no_grad():
                actor(torch.from_numpy(batch))
        measured = (time.perf_counter() - start) / iterations

    per_decision_ms = measured * 1000.0
    amortized_ms = per_decision_ms / max(1, model.horizon)
    affordable_control_hz = model.horizon / measured if measured > 0 else float("inf")
    budget = decision_hz if decision_hz is not None else affordable_control_hz
    return {
        "engine": engine,
        "iterations": int(iterations),
        "decodeMsPerDecision": round(per_decision_ms, 4),
        "decodeMsAmortizedPerControlStep": round(amortized_ms, 4),
        "chunk": int(model.horizon),
        "diffusionSteps": int(model.diffusion_steps),
        "affordableControlHz": round(affordable_control_hz, 1),
        "decisionHz": float(budget),
        "budgetMet": bool(per_decision_ms <= 1000.0 / budget) if budget > 0 else True,
        # Host context: this measurement describes THIS machine, not the
        # board; a deployment gates on its own board-latency receipt.
        "hostContext": platform_label(),
    }


def save_model(payload, report, onnx_report, path):
    """Write the model JSON. Runs only after every failure mode is past —
    a failed run leaves no output file."""
    output = dict(payload)
    output["metrics"] = report
    used = {"numpy", "torch"}
    if onnx_report is not None:
        output["onnx"] = onnx_report
        if onnx_report.get("equivalence") == "verified":
            used |= {"onnx", "onnxruntime"}
        elif onnx_report.get("exported"):
            used |= {"onnx"}
    output.update(provenance_block(used))
    pathlib.Path(path).write_text(
        json.dumps(output, ensure_ascii=False), encoding="utf-8"
    )


# ---------------------------------------------------------------------------
# Engine mode (file protocol) and CLI.
# ---------------------------------------------------------------------------

def synthetic_episodes(obs_size, act_size, episodes, steps, seed=0):
    """Deterministic synthetic demonstration set sized by the contract.

    The observation carries the episode phase (sin/cos); the action at
    step t is a fixed function of that phase, so chunks are genuinely
    predictable from the current observation — the smoke round trains on
    structure, not noise. The action must not depend on per-episode
    hidden constants: an action unidentifiable from the observation would
    floor the MSE at the DATASET's ambiguity, not the model's error.
    """
    rng = np.random.default_rng(seed)
    out = []
    for _ in range(episodes):
        phase = rng.uniform(0.0, 2.0 * np.pi)
        obs = np.zeros((steps, obs_size), dtype=np.float64)
        act = np.zeros((steps, act_size), dtype=np.float64)
        for t in range(steps):
            phi = phase + 0.1 * t
            obs[t, 0] = np.sin(phi)
            if obs_size > 1:
                obs[t, 1] = np.cos(phi)
            if obs_size > 2:
                obs[t, 2:] = rng.normal(0.0, 0.05, obs_size - 2)
            for j in range(act_size):
                act[t, j] = np.sin(phi + 0.2 * j)
        out.append((obs, act))
    return out


def write_artifact_manifest(job_dir):
    """Write SHA256SUMS covering every file this run produced.

    A run's outputs travel together (the model JSON and the exported
    graph), and a digest for one file does not show that the rest are the
    ones that were produced. The worker hashes every listed file and
    refuses the bundle on any mismatch, so a partially copied or
    later-edited job directory cannot be read as intact. Only the two
    protocol files are excluded: `result.json` is written after the
    manifest, and `request.json` is an input, not an output.
    """
    import hashlib

    directory = os.path.abspath(job_dir)
    lines = []
    for name in sorted(os.listdir(directory)):
        if name in ("SHA256SUMS", "result.json", "request.json") or name.startswith("."):
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
            # A file that cannot be read is not listed; inventing an entry
            # would make the manifest unverifiable.
            continue
        lines.append("%s  %s" % (digest.hexdigest(), name))
    if not lines:
        raise RuntimeError("no artifacts to record in SHA256SUMS under %s" % directory)
    with open(os.path.join(directory, "SHA256SUMS"), "w") as handle:
        handle.write("\n".join(lines) + "\n")


def _sha256_of(path):
    import hashlib

    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_engine_mode():
    """File-protocol smoke round for the provenance gate.

    Writes model.json, policy.onnx and SHA256SUMS into the job directory
    (the process cwd), then result.json with the full bundle contract:
    artifactRef "artifact://policy.onnx", the artifact's actual sha256 and
    size, metrics, provenance, cuda=false (CPU trainer), deployable=false
    (board deployment always goes through the release chain). The engine
    requires the onnx toolchain here: this engine's deliverable IS the
    verified sampler graph, and a run that cannot produce it must fail
    closed rather than publish an unverified or missing artifact.
    """
    request = json.loads(pathlib.Path(os.environ["RDK_SIM2REAL_REQUEST_FILE"]).read_text())
    if request.get("schemaVersion") != 1:
        raise ValueError("unsupported request schemaVersion %r" % request.get("schemaVersion"))
    contract = request.get("contract") or {}
    obs_size = int(contract.get("observationSize", 0))
    act_size = int(contract.get("actionSize", 0))
    if obs_size <= 0 or act_size <= 0:
        raise ValueError("request contract must define observationSize and actionSize")
    training = request.get("training") or {}
    epochs = max(1, int(training.get("maxIterations", 3)))

    episodes = synthetic_episodes(obs_size, act_size, episodes=8, steps=48, seed=0)
    payload, report, model, normalization, schedule = fit(
        episodes, chunk=4, diffusion_steps=16, schedule="cosine", channels=16,
        d_model=32, epochs=epochs, lr=1e-3, batch_size=32, seed=0,
        val_fraction=0.25, ema_decay=0.995,
    )
    x_rows = np.concatenate([obs for obs, _ in episodes], axis=0)
    onnx_report = export_onnx(model, normalization, schedule, "policy.onnx", x_rows, seed=0)
    if not onnx_report.get("exported") or onnx_report.get("equivalence") != "verified":
        raise RuntimeError(
            "engine mode requires a VERIFIED onnx export (%s); install the "
            "toolchain (%s) — an unverified sampler artifact is never published"
            % (onnx_report.get("equivalence"), ONNX_MISSING_HINT)
        )
    edge = measure_edge_feasibility(model, normalization, schedule, x_rows, seed=0)
    onnx_report["edgeFeasibility"] = edge
    save_model(payload, report, onnx_report, "model.json")

    onnx_path = pathlib.Path("policy.onnx")
    onnx_sha256 = _sha256_of(onnx_path)
    write_artifact_manifest(".")

    result = {
        "schemaVersion": 1,
        "status": "completed",
        "mock": False,
        "engine": ENGINE_NAME,
        "algorithm": ALGORITHM,
        "contract": {
            "id": contract.get("id"),
            "observationSize": obs_size,
            "actionSize": act_size,
        },
        "dataset": {
            "source": "synthetic-smoke",
            "synthetic": True,
            "episodes": len(episodes),
            "rows": int(x_rows.shape[0]),
        },
        "training": {
            "profile": training.get("profile"),
            "epochs": int(epochs),
        },
        "artifactRef": "artifact://policy.onnx",
        "artifact": {
            "artifactRef": "artifact://policy.onnx",
            "format": "onnx",
            "path": onnx_path.name,
            "sha256": onnx_sha256,
            "sizeBytes": onnx_path.stat().st_size,
            "onnxExported": True,
        },
        "metrics": report,
        # CPU trainer: cuda is reported as used, not requested. deployable
        # stays false — the artifact is a source policy; board deployment
        # goes through compile + preflight + rehearsal like every engine.
        "cuda": False,
        "deployable": False,
    }
    used = {"numpy", "torch", "onnx", "onnxruntime"}
    result.update(provenance_block(used))
    pathlib.Path(os.environ["RDK_SIM2REAL_RESULT_FILE"]).write_text(
        json.dumps(result, ensure_ascii=False), encoding="utf-8"
    )
    print(
        json.dumps(
            {"status": "completed", "engine": ENGINE_NAME, "algorithm": ALGORITHM},
            ensure_ascii=False,
        ),
        flush=True,
    )


def main():
    if os.environ.get("RDK_SIM2REAL_REQUEST_FILE") and os.environ.get(
        "RDK_SIM2REAL_RESULT_FILE"
    ):
        run_engine_mode()
        return

    parser = argparse.ArgumentParser(
        description=(
            "Train a Diffusion Policy (CNN action-chunking DDPM, Chi et al. 2023) "
            "on trajectory JSONL."
        )
    )
    parser.add_argument("dataset", help="trajectory JSONL (step rows with episode markers)")
    parser.add_argument("--out", required=True, help="output model JSON path")
    parser.add_argument("--epochs", type=int, default=200)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--batch", type=int, default=32)
    parser.add_argument("--chunk", type=int, default=8, help="actions sampled per step")
    parser.add_argument(
        "--diffusion-steps", type=int, default=16,
        help="DDPM reverse-chain length T",
    )
    parser.add_argument(
        "--schedule", default="cosine", choices=list(SCHEDULES),
        help="beta table: cosine (valid at any T, the default) or linear "
             "(Ho et al.'s T~1000 betas — under-diffuses at small T)",
    )
    parser.add_argument(
        "--channels", type=int, default=32,
        help="base UNet channel width; levels run base, 2x, 4x (default 32 -> 32/64/128)",
    )
    parser.add_argument(
        "--d-model", type=int, default=64,
        help="conditioning width (observation MLP + step embedding; must be even)",
    )
    parser.add_argument(
        "--ema-decay", type=float, default=0.995,
        help="EMA decay for the exported/saved weights",
    )
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument(
        "--val-fraction", type=float, default=0.2,
        help="episode-level validation split fraction; 0 disables validation explicitly",
    )
    parser.add_argument("--onnx", default=None, help="optional ONNX export path")
    parser.add_argument(
        "--edge-evidence", action="store_true",
        help="measure full-sampler latency + chunk amortization and record it in "
             "the result (context for deployments; the hard gate stays the "
             "board-latency receipt)",
    )
    parser.add_argument(
        "--decision-hz", type=float, default=None,
        help="control rate to check the measured sampler against (with "
             "--edge-evidence; default: the affordable rate from the chunk)",
    )
    args = parser.parse_args()

    episodes, obs_size, act_size = load_dataset(args.dataset)
    payload, report, model, normalization, schedule = fit(
        episodes,
        chunk=args.chunk,
        diffusion_steps=args.diffusion_steps,
        schedule=args.schedule,
        channels=args.channels,
        d_model=args.d_model,
        epochs=args.epochs,
        lr=args.lr,
        batch_size=args.batch,
        seed=args.seed,
        val_fraction=args.val_fraction,
        ema_decay=args.ema_decay,
    )

    onnx_report = None
    x_rows = None
    if args.onnx or args.edge_evidence:
        x_rows = np.concatenate([obs for obs, _ in episodes], axis=0)
    if args.onnx:
        onnx_report = export_onnx(
            model, normalization, schedule, args.onnx, x_rows, seed=args.seed
        )
        state = onnx_report.get("equivalence")
        if state == "skipped-no-onnx":
            print("[dp] ONNX export skipped: onnx not installed (%s)" % ONNX_MISSING_HINT)
        elif state == "skipped-no-onnxruntime":
            print(
                "[dp] ONNX written but equivalence unverified: "
                "onnxruntime not installed (%s)" % ONNX_MISSING_HINT
            )
    if args.edge_evidence:
        edge = measure_edge_feasibility(
            model, normalization, schedule, x_rows, seed=args.seed,
            decision_hz=args.decision_hz,
        )
        if onnx_report is None:
            onnx_report = {}
        onnx_report["edgeFeasibility"] = edge
        print(
            "[dp] edge evidence (%s): full sampler %.4f ms/decision, amortized "
            "%.4f ms/control-step at chunk %d over %d steps -> affordable %.1f Hz"
            % (
                edge["engine"], edge["decodeMsPerDecision"],
                edge["decodeMsAmortizedPerControlStep"], edge["chunk"],
                edge["diffusionSteps"], edge["affordableControlHz"],
            )
        )
    save_model(payload, report, onnx_report, args.out)
    print(
        json.dumps(
            {
                "format": MODEL_FORMAT,
                "train_chunk_mse": report["trainChunkMse"],
                "val_chunk_mse": report["validation"]["chunkMse"],
                "validation": report["validation"]["enabled"],
                "val_per_horizon_mse": report["validation"]["perHorizonMse"],
                "val_denoise_loss": report["validation"]["denoiseLoss"],
                "diffusion_steps": report["diffusion"]["steps"],
                "schedule": report["diffusion"]["schedule"],
                "epochs": report["epochs"],
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


if __name__ == "__main__":
    try:
        if torch is None:
            print(
                "[dp] FAIL — torch is not installed "
                "(python3 -m pip install --user torch)",
                file=sys.stderr,
            )
            sys.exit(2)
        main()
    except (ValueError, OSError, RuntimeError) as error:
        print("[dp] FAIL — %s" % error, file=sys.stderr)
        sys.exit(2)
