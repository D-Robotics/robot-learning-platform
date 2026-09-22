#!/usr/bin/env python3
"""Action-chunking Transformer (ACT) behavior cloning on trajectory JSONL.

The offline-bc engine answers "one observation -> one action" with an MLP.
That is the imitation-learning baseline, not the state of the art: LeRobot's
flagship imitation algorithm is ACT (Zhao et al., RSS 2023 — "Learning Fine-
Grained Bimanual Manipulation with Low-Cost Hardware"), whose two structural
ideas this engine implements on the platform's tabular observation/action
contract:

* **action chunking** — the policy predicts a window of `--chunk` future
  actions per step instead of a single action, so the actor commits to a
  short plan rather than re-deciding every control tick;
* **temporal ensembling** — overlapping chunk predictions are blended with
  exponential weights at execution time. This engine ships the reference
  (`ensemble_predictions`), the board-side incremental runtime
  (`IncrementalEnsembler`), AND a window-ensembled ONNX export whose graph
  performs the blending itself — the differentiating artifact for the RDK
  edge story (see `export_ensembled_onnx` and `measure_edge_feasibility`).

Plus the CVAE piece of the paper: a latent style variable z is encoded from
(observation, target chunk) during training and regularized toward a unit
prior, so multimodal demonstrations (two teachers, two styles) do not get
averaged into a blend no teacher ever performed. Deterministic decode uses
the prior mean z=0.

Honest deltas from the paper, all forced by the platform contract: tabular
observations instead of camera images (the observation vector is tokenized
into fixed-width patches like a 1D ViT), ReLU instead of GELU, no dropout
(determinism is a platform guarantee and smoke-scale datasets do not need
it), and the decoder queries are learned embeddings as in the original.

Everything the sibling engines guarantee is kept: seeded episode-level
train/validation split (chunks never straddle the split), normalization
estimated on the train side only, fail-closed dataset validation, same
seed -> bit-identical weights, ONNX export of the exact deterministic actor
(observation normalization folded in, action de-normalization folded out,
output clamped to [-1, 1] so a drifted weight can never exceed the board
runtime's normalized speed rails) PROVEN against the torch forward with
onnxruntime before the file is kept, and the full provenance block (source
revision, imported versions, lock digest) asserted by
`npm run verify:training-provenance`.

File protocol (engine mode): with RDK_SIM2REAL_REQUEST_FILE and
RDK_SIM2REAL_RESULT_FILE set, runs a smoke round on a deterministic
SYNTHETIC episode dataset sized by the request's contract. The synthetic
source is labeled in the result — the training is real, the data is not.

Output model format `rdk-act-bc-v1` (JSON): architecture, normalization
constants, every weight as lists (the JSON IS the model — `rebuild_model`
reconstructs a forward-identical torch module from it), metrics, seed and
provenance blocks.
"""

import argparse
import base64
import binascii
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
except ImportError:  # pragma: no cover - exercised on machines without torch
    torch = None

MODEL_FORMAT = "rdk-act-bc-v1"
MODEL_FORMAT_IMAGE = "rdk-act-bc-v2"
# Fixed image-branch encoder, mirroring offline-bc's v3 branch: three
# stride-2 k=4 convolutions (8/16/32 channels) shrink the input 8x per side
# before the features join the transformer tokens. Not configurable on
# purpose - a fixed encoder keeps the ONNX graph and its proof reviewable.
IMAGE_CONV_LAYERS = ((8, 4, 2), (16, 4, 2), (32, 4, 2))
ENGINE_NAME = "act"
ONNX_MISSING_HINT = "python3 -m pip install --user onnx onnxruntime"
# An episode-level split needs enough episodes on both sides for the val
# score to mean anything; fewer is refused, not reported as evidence.
MIN_TRAIN_EPISODES = 4
MIN_VAL_EPISODES = 2
EQUIVALENCE_ATOL = 1e-4
EQUIVALENCE_ROWS = 64
# Temporal-ensembling exponential decay per step of prediction age. The ACT
# paper tunes this per task; this default favors recent predictions mildly.
DEFAULT_ENSEMBLE_M = 0.1


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
# ---------------------------------------------------------------------------

def parse_image_input(spec):
    """`64x64` -> (width, height). Dimensions must survive the fixed
    three-convolution encoder with a strictly positive feature map —
    validated by simulating it, not by a looser divisibility rule that
    16x16 would pass while producing a 0x0 map."""
    parts = spec.lower().split("x")
    if len(parts) != 2:
        raise ValueError("--image-input must look like 64x64 (WIDTHxHEIGHT)")
    try:
        width, height = int(parts[0]), int(parts[1])
    except ValueError:
        raise ValueError("--image-input must be integers, got %r" % spec)
    if width <= 0 or height <= 0:
        raise ValueError("--image-input dimensions must be positive")
    for _, k, stride in IMAGE_CONV_LAYERS:
        width = (width - k) // stride + 1
        height = (height - k) // stride + 1
        if width <= 0 or height <= 0:
            raise ValueError(
                "--image-input %r collapses to a %dx%d feature map in the "
                "fixed conv encoder; use at least 24x24" % (spec, width, height)
            )
    return int(parts[0]), int(parts[1])


def load_dataset(path, image_shape=None):
    """Load a trajectory JSONL file into episodes.

    Chunked imitation needs temporal continuity, which the transition-only
    JSONL of offline-bc does not carry. The accepted row shapes:

    * `{"type": "header", ...}` — the recorder's header line; validated and
      skipped (only `header`/`step` types exist; anything else fails closed
      as a typo, not as a silent skip);
    * `{"type": "step", "observation": [...], "action": [...], "done": bool}`
      — the recorder's step line, exactly what the browser recorder emits;
    * a bare `{"observation": [...], "action": [...], "done": bool}` row —
      the offline-bc shape plus an explicit `done` marker.

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
    current_img = []
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
        img = None
        if image_shape is not None:
            img = row.get("image")
            if not isinstance(img, str):
                raise ValueError(
                    "line %d: image mode requires a base64 mono8 'image' on every row" % line_no
                )
            try:
                decoded = base64.b64decode(img, validate=True)
            except (binascii.Error, ValueError):
                raise ValueError("line %d: image is not valid base64" % line_no)
            if len(decoded) != image_shape[0] * image_shape[1]:
                raise ValueError(
                    "line %d: image decodes to %d bytes, expected %d (%dx%d mono8)"
                    % (
                        line_no,
                        len(decoded),
                        image_shape[0] * image_shape[1],
                        image_shape[0],
                        image_shape[1],
                    )
                )
        if obs_size is None:
            obs_size, act_size = len(obs), len(act)
        if len(obs) != obs_size or len(act) != act_size:
            raise ValueError("line %d: inconsistent dimensions" % line_no)
        done = row.get("done", False)
        if not isinstance(done, bool):
            raise ValueError("line %d: done must be a boolean" % line_no)
        current_obs.append(obs)
        current_act.append(act)
        current_img.append(decoded if image_shape is not None else None)
        if done:
            episodes.append(
                (
                    np.asarray(current_obs, dtype=np.float64),
                    np.asarray(current_act, dtype=np.float64),
                    (
                        np.stack(
                            [np.frombuffer(b, dtype=np.uint8) for b in current_img]
                        ).reshape((-1, image_shape[1], image_shape[0]))
                        if image_shape is not None
                        else None
                    ),
                )
            )
            current_obs, current_act, current_img = [], [], []
    if current_obs:
        episodes.append(
            (
                np.asarray(current_obs, dtype=np.float64),
                np.asarray(current_act, dtype=np.float64),
                (
                    np.stack(
                        [np.frombuffer(b, dtype=np.uint8) for b in current_img]
                    ).reshape((-1, image_shape[1], image_shape[0]))
                    if image_shape is not None
                    else None
                ),
            )
        )
    if not episodes:
        raise ValueError("dataset is empty")
    return episodes, obs_size, act_size, image_shape


def build_chunks(episodes, chunk, image_shape=None):
    """Episodes -> (obs, chunk targets, episode index per chunk[, images]).

    Episodes shorter than the chunk length cannot yield a training pair and
    are skipped — counted, not hidden: the report says how many episodes
    were dropped so a dataset of 20 episodes of 3 steps each never looks
    like a working dataset.
    """
    xs, ys, episode_of, imgs = [], [], [], []
    skipped = 0
    for episode_idx, ep in enumerate(episodes):
        obs, act = ep[0], ep[1]
        ep_imgs = ep[2] if len(ep) > 2 else None
        steps = obs.shape[0]
        if steps < chunk:
            skipped += 1
            continue
        for t in range(steps - chunk + 1):
            xs.append(obs[t])
            ys.append(act[t : t + chunk].reshape(-1))
            episode_of.append(episode_idx)
            if image_shape is not None:
                imgs.append(ep_imgs[t])
    if not xs:
        raise ValueError(
            "no episode reaches the chunk length (%d): every episode is shorter "
            "than the chunk, so there is not a single (observation -> future "
            "chunk) pair to train on" % chunk
        )
    result = [
        np.asarray(xs, dtype=np.float64),
        np.asarray(ys, dtype=np.float64),
        np.asarray(episode_of, dtype=np.int64),
        skipped,
    ]
    if image_shape is not None:
        result.append(np.stack(imgs).astype(np.float64))
    return tuple(result)


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
# The ACT model. Attention is built from primitive ops (matmul + softmax)
# instead of nn.MultiheadAttention so the ONNX graph is a direct mirror of
# the torch forward — no exporter-version-dependent attention fusion.
# ---------------------------------------------------------------------------

if torch is not None:

    def multi_head_attention(query, key, value, heads, key_tokens, scale):
        """(B, Tq, D) x (B, Tk, D) -> (B, Tq, D). No masks: memory is padded
        tokens, which the model learns to weight, not tokens the graph must
        hide. `key_tokens` is the source length (memory tokens differ from
        query tokens in cross-attention). `scale` is a plain float computed
        once at construction — calling math.sqrt inside the forward makes
        torch.onnx tracing emit a TracerWarning per call."""
        batch, tokens, dim = query.shape

        def split(x, length):
            return x.reshape(batch, length, heads, dim // heads).transpose(1, 2)

        q = split(query, tokens)
        k = split(key, key_tokens)
        v = split(value, key_tokens)
        scores = q @ k.transpose(-2, -1) * scale
        weights = torch.softmax(scores, dim=-1)
        mixed = (weights @ v).transpose(1, 2).contiguous()
        return mixed.reshape(batch, tokens, dim)

    class EncoderLayer(nn.Module):
        """Pre-LN transformer encoder layer (self-attention + ReLU FFN)."""

        def __init__(self, d_model, heads, ffn_dim):
            super().__init__()
            self.heads = heads
            self.scale = 1.0 / math.sqrt(d_model // heads)
            self.norm_attn = nn.LayerNorm(d_model)
            self.qkv = nn.Linear(d_model, 3 * d_model)
            self.out = nn.Linear(d_model, d_model)
            self.norm_ffn = nn.LayerNorm(d_model)
            self.ffn_up = nn.Linear(d_model, ffn_dim)
            self.ffn_down = nn.Linear(ffn_dim, d_model)

        def forward(self, x):
            projected = self.qkv(self.norm_attn(x))
            q, k, v = projected.chunk(3, dim=-1)
            x = x + self.out(
                multi_head_attention(q, k, v, self.heads, x.shape[1], self.scale)
            )
            x = x + self.ffn_down(torch.relu(self.ffn_up(self.norm_ffn(x))))
            return x

    class DecoderLayer(nn.Module):
        """Pre-LN transformer decoder layer (self + cross attention)."""

        def __init__(self, d_model, heads, ffn_dim):
            super().__init__()
            self.heads = heads
            self.scale = 1.0 / math.sqrt(d_model // heads)
            self.norm_self = nn.LayerNorm(d_model)
            self.qkv_self = nn.Linear(d_model, 3 * d_model)
            self.out_self = nn.Linear(d_model, d_model)
            self.norm_cross_q = nn.LayerNorm(d_model)
            self.norm_cross_m = nn.LayerNorm(d_model)
            self.q_cross = nn.Linear(d_model, d_model)
            self.kv_cross = nn.Linear(d_model, 2 * d_model)
            self.out_cross = nn.Linear(d_model, d_model)
            self.norm_ffn = nn.LayerNorm(d_model)
            self.ffn_up = nn.Linear(d_model, ffn_dim)
            self.ffn_down = nn.Linear(ffn_dim, d_model)

        def forward(self, x, memory):
            projected = self.qkv_self(self.norm_self(x))
            q, k, v = projected.chunk(3, dim=-1)
            x = x + self.out_self(
                multi_head_attention(q, k, v, self.heads, x.shape[1], self.scale)
            )
            q = self.norm_cross_q(x)
            kv = self.kv_cross(self.norm_cross_m(memory))
            k, v = kv.chunk(2, dim=-1)
            x = x + self.out_cross(
                multi_head_attention(q, k, v, self.heads, memory.shape[1], self.scale)
            )
            x = x + self.ffn_down(torch.relu(self.ffn_up(self.norm_ffn(x))))
            return x

    class ImageEncoder(nn.Module):
        """Fixed mono8 CNN encoder: three stride-2 k=4 convolutions + ReLU,
        then a linear projection to d_model. Pixel normalization is folded in
        as buffers (train-split scalars) so the exported graph is the whole
        preprocessing. Input is NCHW [B,1,H,W]; the NHWC->NCHW transpose for
        the platform vision gate lives in the export wrapper."""

        def __init__(self, height, width, d_model):
            super().__init__()
            channels = 1
            h, w = height, width
            convs = []
            for filters, k, stride in IMAGE_CONV_LAYERS:
                convs.append(nn.Conv2d(channels, filters, k, stride))
                channels = filters
                h = (h - k) // stride + 1
                w = (w - k) // stride + 1
            self.convs = nn.ModuleList(convs)
            # Global average pooling instead of flatten: the fixed encoder
            # targets global appearance (brightness distribution, colors) —
            # GAP keeps those linearly separable at 32 features instead of
            # diluting them across a 1152-dim spatial flatten that trains
            # orders of magnitude slower from scratch.
            self.flat = channels
            self.proj = nn.Linear(self.flat, d_model)
            # Raw conv features come out an order of magnitude below the obs
            # tokens (~0.02 vs ~1), so attention learns to ignore the image
            # token and the branch never trains. Normalizing the projected
            # features puts them on the token-space scale the transformer
            # already operates in.
            self.out_norm = nn.LayerNorm(d_model)
            self.register_buffer("pix_mean", torch.zeros(1))
            self.register_buffer("pix_std", torch.ones(1))

        def forward(self, img_nchw):
            x = (img_nchw - self.pix_mean) / self.pix_std
            for conv in self.convs:
                x = torch.relu(conv(x))
            x = x.mean(dim=(2, 3))
            return self.out_norm(self.proj(x.reshape(x.shape[0], -1)))

    class ActModel(nn.Module):
        """CVAE ACT: obs tokens + style token -> encoder; chunk queries ->
        decoder -> per-horizon actions. Training samples z from the encoder
        posterior; deterministic decode (used for eval/export) uses z=0."""

        def __init__(self, obs_size, act_size, chunk, d_model, heads, enc_layers,
                     dec_layers, z_dim, token_width, image_encoder=None):
            super().__init__()
            if d_model % heads != 0:
                raise ValueError("d_model must be divisible by heads")
            self.obs_size = obs_size
            self.act_size = act_size
            self.chunk = chunk
            self.d_model = d_model
            self.heads = heads
            self.z_dim = z_dim
            self.token_width = token_width
            self.token_count = (obs_size + token_width - 1) // token_width
            padded = self.token_count * token_width
            self.image_encoder = image_encoder

            self.token_embed = nn.Linear(token_width, d_model)
            self.position = nn.Parameter(torch.zeros(self.token_count, d_model))
            self.z_embed = nn.Linear(z_dim, d_model)
            self.expects_image = image_encoder is not None
            self.encoder = nn.ModuleList(
                [EncoderLayer(d_model, heads, 4 * d_model) for _ in range(enc_layers)]
            )
            self.queries = nn.Parameter(torch.zeros(chunk, d_model))
            self.decoder = nn.ModuleList(
                [DecoderLayer(d_model, heads, 4 * d_model) for _ in range(dec_layers)]
            )
            self.head = nn.Linear(d_model, act_size)
            # Direct linear readout from the image features to the action
            # chunk: the transformer route attenuates a weak conv feature by
            # attention softmax before it reaches the head, so image-only
            # signals train orders of magnitude slower through it. This
            # readout gives the conv encoder a gradient path that does not
            # pass through attention at all (a zero-init here would cut the
            # conv encoder's gradient to exactly zero and deadlock it).
            self.img_head = (
                nn.Linear(d_model, act_size) if image_encoder is not None else None
            )
            self._padded = padded
            # Posterior encoder: (obs, target chunk) -> (mu, logvar). Only
            # used while training; deterministic decode never calls it.
            self.posterior = nn.Sequential(
                nn.Linear(
                    obs_size + chunk * act_size + (d_model if image_encoder is not None else 0),
                    2 * d_model,
                ),
                nn.ReLU(),
                nn.Linear(2 * d_model, 2 * z_dim),
            )

        def _tokens(self, obs, img_feat=None):
            batch = obs.shape[0]
            pad = torch.zeros(
                batch, self._padded, dtype=obs.dtype, device=obs.device
            )
            pad[:, : self.obs_size] = obs
            tokens = pad.reshape(batch, self.token_count, self.token_width)
            tokens = self.token_embed(tokens) + self.position
            if img_feat is not None:
                # Broadcast injection: the frame features add into EVERY obs
                # token, so the vision gradient reaches the encoder directly
                # instead of depending on attention learning to route through
                # one token among many.
                tokens = tokens + img_feat.unsqueeze(1)
            return tokens

        def encode_posterior(self, obs, chunk_targets, img_feat=None):
            parts = [obs]
            if img_feat is not None:
                parts.append(img_feat)
            parts.append(chunk_targets.reshape(chunk_targets.shape[0], -1))
            stats = self.posterior(torch.cat(parts, dim=1))
            mu, logvar = stats.chunk(2, dim=-1)
            return mu, logvar

        def decode(self, obs, z, img_feat=None):
            """Deterministic path: obs (+image) -> chunk of actions (normalized)."""
            memory = torch.cat(
                [self._tokens(obs, img_feat), self.z_embed(z).unsqueeze(1)], dim=1
            )
            for layer in self.encoder:
                memory = layer(memory)
            x = self.queries.unsqueeze(0).expand(obs.shape[0], -1, -1)
            for layer in self.decoder:
                x = layer(x, memory)
            out = self.head(x)
            if img_feat is not None:
                # Same image contribution at every horizon (the frame is the
                # one this step was issued with).
                out = out + self.img_head(img_feat).unsqueeze(1)
            return out

        def forward(self, obs, chunk_targets=None, z=None, z_noise=None, img_feat=None):
            """Training path: sample z from the posterior when a target is
            given (reparameterized with caller-supplied noise so the sample
            stream is reproducible); otherwise decode with the provided z."""
            if chunk_targets is not None:
                mu, logvar = self.encode_posterior(obs, chunk_targets, img_feat)
                std = torch.exp(0.5 * logvar)
                eps = (
                    z_noise
                    if z_noise is not None
                    else torch.randn(mu.shape, dtype=mu.dtype, device=mu.device)
                )
                z = mu + std * eps
                chunk_pred = self.decode(obs, z, img_feat)
                kl = -0.5 * torch.mean(
                    torch.sum(1.0 + logvar - mu * mu - torch.exp(logvar), dim=-1)
                )
                return chunk_pred, kl
            return self.decode(obs, z if z is not None else torch.zeros(
                obs.shape[0], self.z_dim, dtype=obs.dtype, device=obs.device
            ), img_feat)

    class DeterministicActor(nn.Module):
        """Export/eval wrapper: normalization folded in at the observation,
        de-normalization folded out at the chunk, z fixed at the prior mean,
        and the output clamped to the normalized action space [-1, 1].

        The clamp is the platform's safety convention (starter-ppo's export
        does the same): the board runtime treats policy output as normalized
        commands and scales them by its MAX_LINEAR/MAX_ANGULAR rails, so an
        artifact whose graph itself saturates at [-1, 1] can never command a
        speed the runtime did not budget for — even if the weights drift.

        Mirrors offline-bc's "the graph is the forward" rule: the exported
        ONNX runs the same arithmetic this wrapper runs, so the onnxruntime
        equivalence check measures exporter correctness, not an algebraic
        rearrangement.
        """

        def __init__(self, model, obs_mean, obs_std, act_mean, act_std):
            super().__init__()
            self.model = model
            self.expects_image = model.image_encoder is not None
            # Chunk normalization statistics are estimated on the flattened
            # (chunk*act) target; the prediction is (batch, chunk, act), so
            # the buffers are reshaped once here to broadcast correctly.
            self.register_buffer("obs_mean", obs_mean)
            self.register_buffer("obs_std", obs_std)
            self.register_buffer(
                "act_mean", act_mean.reshape(1, model.chunk, model.act_size)
            )
            self.register_buffer(
                "act_std", act_std.reshape(1, model.chunk, model.act_size)
            )

        def forward(self, observation, image=None):
            normalized = (observation - self.obs_mean) / self.obs_std
            img_feat = None
            if self.expects_image:
                if image is None:
                    raise ValueError("this policy was trained with images; the image input is required")
                # The platform vision gate expects an NHWC rank-4 image input;
                # the conv stack itself runs NCHW.
                img_nchw = image.permute(0, 3, 1, 2).contiguous()
                img_feat = self.model.image_encoder(img_nchw)
            elif image is not None:
                raise ValueError("this policy has no image branch; pass vector observations only")
            chunk = self.model.decode(
                normalized,
                torch.zeros(observation.shape[0], self.model.z_dim,
                            dtype=observation.dtype, device=observation.device),
                img_feat,
            )
            return (chunk * self.act_std + self.act_mean).clamp(-1.0, 1.0)

    class EnsembledWindowActor(nn.Module):
        """Last-k observation window -> temporally ensembled action.

        The differentiating export: the ACT paper's temporal ensembling
        blended at run time by Python code becomes part of the VERIFIED
        graph. A board runtime feeds the observation ring buffer and gets
        the blended action — nothing to re-implement, nothing to get
        subtly wrong on the robot.

        Window position p holds the observation of step t-k+1+p; decoding
        it yields the chunk issued at that step, whose contribution to the
        current step (the last window position) is its (k-1-p)-th action,
        weighted exp(-m * (k-1-p)) — exactly `ensemble_predictions`' math,
        parity-tested at the torch level. k and m are construction
        constants, so the normalized weight schedule is precomputed into a
        buffer: the traced forward stays pure-tensor (no Python float math,
        no TracerWarnings) and the weights land in the graph as the
        constants they are.
        """

        def __init__(self, actor, m):
            super().__init__()
            self.actor = actor
            self.m = float(m)
            k = actor.model.chunk
            ages = np.arange(k - 1, -1, -1, dtype=np.float64)
            weights = np.exp(-self.m * ages)
            weights = weights / weights.sum()
            self.register_buffer(
                "blend_weights", torch.from_numpy(weights.astype(np.float32))
            )

        def forward(self, window):
            model = self.actor.model
            k, act_size = model.chunk, model.act_size
            chunks = self.actor(window.reshape(-1, model.obs_size))
            chunks = chunks.reshape(-1, k, k, act_size)
            # Position p's chunk contributes its (k-1-p)-th action at the
            # current step (the last window position).
            contributions = torch.stack(
                [chunks[:, p, k - 1 - p, :] for p in range(k)], dim=1
            )
            return (contributions * self.blend_weights.view(1, k, 1)).sum(dim=1)

    def _state_to_lists(module):
        return {
            name: value.detach().cpu().numpy().tolist()
            for name, value in module.state_dict().items()
        }

    def rebuild_model(payload):
        """Reconstruct a forward-identical torch module from the model JSON.

        This is what makes the JSON payload auditable: the saved file is the
        model, not a summary of it. Buffers (positions, queries) come back as
        parameters of the rebuilt graph via load_state_dict.
        """
        arch = payload["architecture"]
        image_encoder = None
        image_block = payload.get("imageInput")
        if image_block:
            image_encoder = ImageEncoder(
                image_block["height"], image_block["width"], arch["dModel"]
            )
        model = ActModel(
            payload["observation_size"], payload["action_size"], payload["chunk"],
            arch["dModel"], arch["heads"], arch["encLayers"], arch["decLayers"],
            arch["zDim"], arch["tokenWidth"], image_encoder,
        )
        state = {
            name: torch.as_tensor(np.asarray(value), dtype=torch.float32)
            for name, value in payload["state"].items()
        }
        model.load_state_dict(state)
        model.eval()
        return model


# ---------------------------------------------------------------------------
# Temporal ensembling (the execution-time half of ACT).
# ---------------------------------------------------------------------------

def ensemble_predictions(chunks, m=DEFAULT_ENSEMBLE_M):
    """Blend overlapping chunk predictions into per-step actions.

    `chunks` is (T, k, act): the chunk predicted at step s covers steps
    s..s+k-1. At execution step t the available opinions are the chunks
    issued at s = max(0, t-k+1)..t, each contributing its (t-s)-th action,
    weighted exp(-m * age). NumPy, stateless, no torch dependency — the
    board-side runtime can copy this function verbatim.
    """
    chunks = np.asarray(chunks, dtype=np.float64)
    if chunks.ndim != 3:
        raise ValueError("chunks must be (steps, chunk, action)")
    steps, k, act = chunks.shape
    out = np.zeros((steps, act), dtype=np.float64)
    for t in range(steps):
        first = max(0, t - k + 1)
        weights = np.exp(-m * (t - np.arange(first, t + 1)))
        weights = weights / weights.sum()
        for offset, s in enumerate(range(first, t + 1)):
            out[t] += weights[offset] * chunks[s, t - s]
    return out


class IncrementalEnsembler:
    """Board-side temporal ensembler: the execution half of ACT on the robot.

    `push(chunk)` whenever the policy re-decides; `step()` once per control
    step to consume the blended action. Two execution modes, same class:

    * full-rate (push every step) — parity-tested numerically identical to
      `ensemble_predictions` on the same chunk sequence;
    * amortized (push every k steps) — degrades to executing the freshest
      chunk open-loop, the mode that makes 50 Hz control feasible on an
      edge CPU/BPU: one inference per k control steps.

    Pure NumPy, no torch: the board runtime copies this class verbatim
    together with `ensemble_predictions`.
    """

    def __init__(self, chunk, act_size, m=DEFAULT_ENSEMBLE_M):
        chunk = int(chunk)
        if chunk <= 0:
            raise ValueError("chunk must be positive")
        self.chunk = chunk
        self.act_size = int(act_size)
        self.m = float(m)
        self._ring = []  # (step_issued, chunk) — at most `chunk` entries
        self._t = 0

    def push(self, chunk_actions):
        """Accept a freshly decoded chunk for the CURRENT step."""
        chunk = np.asarray(chunk_actions, dtype=np.float64)
        if chunk.shape != (self.chunk, self.act_size):
            raise ValueError(
                "chunk must be (%d, %d), got %r" % (self.chunk, self.act_size, chunk.shape)
            )
        self._ring.append((self._t, chunk))
        if len(self._ring) > self.chunk:
            self._ring.pop(0)

    def step(self):
        """Blend the overlapping contributions and advance one control step."""
        # Chunks older than the horizon no longer cover this step.
        self._ring = [
            (s, c) for (s, c) in self._ring if 0 <= self._t - s < self.chunk
        ]
        if not self._ring:
            raise RuntimeError("step() before any push() — no chunk covers this step")
        blended = np.zeros(self.act_size, dtype=np.float64)
        weight_sum = 0.0
        for issued, chunk in self._ring:
            age = self._t - issued
            weight = math.exp(-self.m * age)
            blended += weight * chunk[age]
            weight_sum += weight
        self._t += 1
        return blended / weight_sum


# ---------------------------------------------------------------------------
# Training.
# ---------------------------------------------------------------------------

def fit(episodes, chunk, d_model, heads, enc_layers, dec_layers, z_dim,
        token_width, kl_weight, epochs, lr, batch_size, seed, val_fraction,
        image_shape=None):
    """Split by episode, standardize on the train side, train, score.

    Returns (payload, report, model, normalization). The payload's `state`
    block carries every weight; `rebuild_model` turns it back into the same
    network.
    """
    if torch is None:
        raise RuntimeError("torch is not installed")
    obs_size = episodes[0][0].shape[1]
    act_size = episodes[0][1].shape[1]
    if image_shape is not None:
        chunks = build_chunks(episodes, chunk, image_shape)
        x, y, episode_of, skipped, imgs = chunks
    else:
        x, y, episode_of, skipped = build_chunks(episodes, chunk)
        imgs = None
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

    img_train_n = None
    img_val = None
    img_all = None
    pixel_norm = None
    if image_shape is not None:
        # Pixel statistics on the TRAIN split only - same honesty rule as the
        # vector standardization above.
        pix_mean = float(imgs[train_mask].mean())
        pix_std = float(imgs[train_mask].std())
        if pix_std < 1e-12:
            pix_std = 1.0
        pixel_norm = (pix_mean, pix_std)
        img_train_n = torch.from_numpy(
            ((imgs[train_mask] - pix_mean) / pix_std).astype(np.float32)
        ).unsqueeze(1)  # NCHW for the conv stack
        img_val = torch.from_numpy(
            ((imgs[val_mask] - pix_mean) / pix_std).astype(np.float32)
        ).unsqueeze(1)
        img_all = torch.from_numpy(
            ((imgs - pix_mean) / pix_std).astype(np.float32)
        ).unsqueeze(1)

    torch.set_num_threads(1)
    torch.manual_seed(seed)
    image_encoder = (
        ImageEncoder(image_shape[1], image_shape[0], d_model)
        if image_shape is not None
        else None
    )
    if image_encoder is not None:
        image_encoder.pix_mean.fill_(pixel_norm[0])
        image_encoder.pix_std.fill_(pixel_norm[1])
    model = ActModel(obs_size, act_size, chunk, d_model, heads, enc_layers,
                     dec_layers, z_dim, token_width, image_encoder)
    model.float()
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)

    x_train_n = torch.from_numpy(((x_train - obs_mean) / obs_std).astype(np.float32))
    y_train_n = torch.from_numpy(((y_train - act_mean) / act_std).astype(np.float32))

    shuffle_rng = torch.Generator()
    shuffle_rng.manual_seed(seed + 2)
    z_rng = torch.Generator()
    z_rng.manual_seed(seed + 3)
    rows = x_train_n.shape[0]
    batch_size = min(batch_size, rows)
    kl_last = 0.0
    decode_only_step = True
    model.train()
    for _ in range(epochs):
        order = torch.randperm(rows, generator=shuffle_rng)
        for start in range(0, rows, batch_size):
            batch = order[start : start + batch_size]
            xb, yb = x_train_n[batch], y_train_n[batch]
            ib = img_train_n[batch] if img_train_n is not None else None
            img_feat = model.image_encoder(ib) if ib is not None else None
            # The z-sampling noise is drawn from a dedicated stream so
            # posterior sampling is reproducible independent of shuffling.
            z_noise = torch.randn(xb.shape[0], z_dim, generator=z_rng)
            if img_feat is not None and decode_only_step:
                # Alternating decode-only steps close the CVAE z-smuggling
                # loophole: through the posterior, z can copy image (and
                # target) information into training, so the shared decode
                # path never has to learn to read the image tokens — while
                # deterministic z=0 decode is the exact path deployment
                # runs. Every other step trains the decode path with z=0.
                chunk_pred = model.decode(xb, torch.zeros_like(z_noise), img_feat)
                kl = torch.zeros(())
            else:
                chunk_pred, kl = model(
                    xb, chunk_targets=yb, z_noise=z_noise, img_feat=img_feat
                )
            loss = torch.mean((chunk_pred - yb.reshape(chunk_pred.shape)) ** 2)
            loss = loss + kl_weight * kl
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            kl_last = float(kl.detach())
        decode_only_step = not decode_only_step

    # ---- Scoring, in RAW action units (what a robot would execute). ----
    # Chunk statistics live on the flattened (chunk*act) target, so
    # de-normalizing a (rows, chunk, act) prediction needs them reshaped.
    act_mean_cube = act_mean.reshape(1, chunk, act_size)
    act_std_cube = act_std.reshape(1, chunk, act_size)
    model.eval()
    with torch.no_grad():
        def raw_chunk_mse(xs, ys, imgs=None):
            """Prediction in (rows, chunk, act) RAW action units plus the
            flat MSE over every element."""
            if xs.shape[0] == 0:
                return None, None
            xn = torch.from_numpy(((xs - obs_mean) / obs_std).astype(np.float32))
            if imgs is not None:
                img_feat = model.image_encoder(imgs)
                pred = model.decode(xn, torch.zeros(xn.shape[0], model.z_dim), img_feat)
            else:
                pred = model(xn)
            pred = pred.numpy() * act_std_cube + act_mean_cube
            flat = pred.reshape(pred.shape[0], -1)
            return float(np.mean((flat - ys) ** 2)), pred

        train_mse, _ = raw_chunk_mse(x_train, y_train, img_train_n)
        if val_mask.any():
            val_mse, val_pred = raw_chunk_mse(x_val, y_val, img_val)
            y_val_cube = y_val.reshape(-1, chunk, act_size)
            per_horizon = [
                float(np.mean((val_pred[:, h, :] - y_val_cube[:, h, :]) ** 2))
                for h in range(chunk)
            ]
        else:
            val_mse, per_horizon = None, None

        # Temporal-ensembling evidence: decode along every validation
        # episode and compare ensembled actions against the first-action
        # policy. On clean deterministic data they tie; under execution
        # noise the ensemble wins — both numbers are reported, neither is
        # cherry-picked.
        ensemble_mse = first_action_mse = None
        if len(val_episodes):
            sq_ens, sq_first, total = 0.0, 0.0, 0
            for ep in val_episodes:
                obs_e, act_e = episodes[ep][0], episodes[ep][1]
                imgs_e = episodes[ep][2] if len(episodes[ep]) > 2 else None
                if obs_e.shape[0] < chunk:
                    continue
                steps = obs_e.shape[0] - chunk + 1
                xn = torch.from_numpy(((obs_e[:steps] - obs_mean) / obs_std).astype(np.float32))
                if imgs_e is not None:
                    img_n = torch.from_numpy(
                        ((imgs_e[:steps] - pixel_norm[0]) / pixel_norm[1]).astype(np.float32)
                    ).unsqueeze(1)
                    img_feat = model.image_encoder(img_n)
                    pred = model.decode(xn, torch.zeros(xn.shape[0], model.z_dim), img_feat)
                else:
                    pred = model(xn)
                pred = pred.numpy() * act_std_cube + act_mean_cube  # (steps, k, act)
                truth = act_e[:steps]  # action at step t is chunk[t, 0]
                ens = ensemble_predictions(pred)
                sq_ens += float(np.sum((ens - truth) ** 2))
                sq_first += float(np.sum((pred[:, 0, :] - truth) ** 2))
                total += truth.size
            if total:
                ensemble_mse = sq_ens / total
                first_action_mse = sq_first / total

    payload = {
        "format": MODEL_FORMAT_IMAGE if image_shape is not None else MODEL_FORMAT,
        "modality": "image+vector" if image_shape is not None else "vector",
        "observation_size": int(obs_size),
        "action_size": int(act_size),
        "chunk": int(chunk),
        "architecture": {
            "dModel": int(d_model), "heads": int(heads),
            "encLayers": int(enc_layers), "decLayers": int(dec_layers),
            "zDim": int(z_dim), "tokenWidth": int(token_width),
            "tokenCount": int((obs_size + token_width - 1) // token_width),
        },
        "normalization": {
            "observation": {"mean": obs_mean.tolist(), "std": obs_std.tolist()},
            "action": {"mean": act_mean.tolist(), "std": act_std.tolist()},
        },
        "state": _state_to_lists(model),
    }
    if image_shape is not None:
        payload["imageInput"] = {
            "width": int(image_shape[0]),
            "height": int(image_shape[1]),
            "channels": 1,
            "encoding": "mono8",
            "sourceRange": [0, 255],
        }
    report = {
        "trainChunkMse": train_mse,
        "validation": {
            "enabled": bool(val_fraction > 0),
            "chunkMse": val_mse,
            "perHorizonMse": per_horizon,
            "ensembleMse": ensemble_mse,
            "firstActionMse": first_action_mse,
        },
        "kl": kl_last,
        "klWeight": float(kl_weight),
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
    }
    return payload, report, model, (obs_mean, obs_std, act_mean, act_std)


# ---------------------------------------------------------------------------
# ONNX export with proof.
# ---------------------------------------------------------------------------

def export_onnx(model, normalization, path, x_check, image_shape=None, images_check=None):
    """Export the deterministic actor and PROVE it against the torch forward.

    onnxruntime runs the exported graph on real dataset rows and compares
    against `DeterministicActor` (both float32). A mismatch deletes the
    file and fails the run — an unverified export is never kept.

    Image mode exports a two-input graph: the vector observation plus an
    NHWC rank-4 image input [N,H,W,1] (the platform vision gate's shape
    convention); the NHWC->NCHW transpose is part of the traced graph.
    """
    if torch is None:
        raise RuntimeError("torch is not installed")
    try:
        import onnx  # noqa: F401 - presence check
    except ImportError:
        return {"exported": False, "equivalence": "skipped-no-onnx"}

    obs_mean, obs_std, act_mean, act_std = normalization
    actor = DeterministicActor(
        model,
        torch.from_numpy(obs_mean.astype(np.float32)),
        torch.from_numpy(obs_std.astype(np.float32)),
        torch.from_numpy(act_mean.astype(np.float32)),
        torch.from_numpy(act_std.astype(np.float32)),
    )
    actor.eval()
    dummy = torch.zeros(1, model.obs_size, dtype=torch.float32)
    width, height = image_shape if image_shape is not None else (0, 0)
    if image_shape is not None:
        dummy_image = torch.zeros(1, height, width, 1, dtype=torch.float32)
        export_inputs = (dummy, dummy_image)
        input_names = ["observation", "image"]
        dynamic = {
            "observation": {0: "batch"},
            "image": {0: "batch"},
            "chunk_actions": {0: "batch"},
        }
    else:
        export_inputs = (dummy,)
        input_names = ["observation"]
        dynamic = {
            "observation": {0: "batch"},
            "chunk_actions": {0: "batch"},
        }
    import warnings

    with warnings.catch_warnings():
        # The legacy TorchScript exporter emits a migration DeprecationWarning
        # on torch>=2.9; keep it out of the worker-captured stderr.
        warnings.filterwarnings("ignore", category=DeprecationWarning)
        torch.onnx.export(
            actor,
            export_inputs,
            path,
            input_names=input_names,
            output_names=["chunk_actions"],
            dynamic_axes=dynamic,
            opset_version=17,
        )
    data = pathlib.Path(path).read_bytes()

    try:
        import onnxruntime as ort
    except ImportError:
        return {"exported": True, "equivalence": "skipped-no-onnxruntime", "sizeBytes": len(data)}

    session = ort.InferenceSession(
        pathlib.Path(path).as_posix(), providers=["CPUExecutionProvider"]
    )
    rows = x_check[:EQUIVALENCE_ROWS].astype(np.float32)
    row_count = rows.shape[0]
    with torch.no_grad():
        if image_shape is not None:
            img_rows = images_check[:row_count].astype(np.float32)
            feeds_image = img_rows.reshape(img_rows.shape[0], height, width, 1)
            expected = actor(
                torch.from_numpy(rows), torch.from_numpy(feeds_image)
            ).numpy()
            feeds = {"observation": rows, "image": feeds_image}
        else:
            expected = actor(torch.from_numpy(rows)).numpy()
            feeds = {"observation": rows}
    actual = session.run(["chunk_actions"], feeds)[0]
    worst = float(np.max(np.abs(expected - actual)))
    if worst >= EQUIVALENCE_ATOL:
        pathlib.Path(path).unlink()
        raise ValueError(
            "ONNX export disagrees with the torch forward pass (max |diff| %.3g >= %.3g); "
            "the unverified file was not kept" % (worst, EQUIVALENCE_ATOL)
        )
    return {
        "exported": True,
        "equivalence": "verified",
        "maxAbsDiff": worst,
        "checkedRows": int(rows.shape[0]),
        "sizeBytes": len(data),
    }


# ---------------------------------------------------------------------------
# Edge-feasibility export: window-ensembled actor + measured evidence.
# ---------------------------------------------------------------------------

def export_ensembled_onnx(model, normalization, path, windows_check, m=DEFAULT_ENSEMBLE_M):
    """Export the WINDOW-ENSEMBLED actor and prove it two ways.

    The graph maps the last k observations to the temporally ensembled
    action — the ACT paper's runtime Python blended inside the VERIFIED
    artifact itself. Proven against (a) the torch `EnsembledWindowActor`
    forward and (b) the numpy `ensemble_predictions` reference on the same
    decoded chunks: if the graph's window math drifted from the reference
    math, the second check catches it even when the exporter is faithful.

    The chunk decoder inside the graph is the clamped DeterministicActor,
    so ensembled output is a convex blend of [-1, 1]-clamped actions —
    it can never exceed the runtime's normalized action rails.
    """
    if torch is None:
        raise RuntimeError("torch is not installed")
    try:
        import onnx  # noqa: F401 - presence check
    except ImportError:
        return {"exported": False, "equivalence": "skipped-no-onnx"}

    obs_mean, obs_std, act_mean, act_std = normalization
    actor = DeterministicActor(
        model,
        torch.from_numpy(obs_mean.astype(np.float32)),
        torch.from_numpy(obs_std.astype(np.float32)),
        torch.from_numpy(act_mean.astype(np.float32)),
        torch.from_numpy(act_std.astype(np.float32)),
    )
    actor.eval()
    wrapped = EnsembledWindowActor(actor, m)
    wrapped.eval()
    dummy = torch.zeros(1, model.chunk, model.obs_size, dtype=torch.float32)
    import warnings

    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=DeprecationWarning)
        torch.onnx.export(
            wrapped,
            (dummy,),
            path,
            input_names=["observation_window"],
            output_names=["action"],
            dynamic_axes={
                "observation_window": {0: "batch"},
                "action": {0: "batch"},
            },
            opset_version=17,
        )
    data = pathlib.Path(path).read_bytes()

    try:
        import onnxruntime as ort
    except ImportError:
        return {"exported": True, "equivalence": "skipped-no-onnxruntime", "sizeBytes": len(data)}

    session = ort.InferenceSession(
        pathlib.Path(path).as_posix(), providers=["CPUExecutionProvider"]
    )
    windows = windows_check[: max(1, EQUIVALENCE_ROWS // model.chunk)].astype(np.float32)
    with torch.no_grad():
        expected = wrapped(torch.from_numpy(windows)).numpy()
    actual = session.run(["action"], {"observation_window": windows})[0]
    worst = float(np.max(np.abs(expected - actual)))
    if worst >= EQUIVALENCE_ATOL:
        pathlib.Path(path).unlink()
        raise ValueError(
            "ensembled ONNX export disagrees with the torch forward pass "
            "(max |diff| %.3g >= %.3g); the unverified file was not kept"
            % (worst, EQUIVALENCE_ATOL)
        )

    # Second proof: the graph's window math vs the numpy reference on the
    # same decoded (clamped) chunks. windows (B, k, obs): position p is the
    # observation of step p, so the reference ensembles chunk[p, k-1-p].
    with torch.no_grad():
        decoded = actor(torch.from_numpy(windows.reshape(-1, model.obs_size)))
        decoded = decoded.reshape(windows.shape[0], model.chunk, model.chunk, model.act_size)
    reference = np.stack(
        [ensemble_predictions(decoded[b].numpy(), m=m)[-1] for b in range(windows.shape[0])]
    )
    # The graph's chunk[p] contributes its (k-1-p)-th action at the last
    # window position — the same convention as the reference, which runs
    # over the full window history; the current step is its last row.
    reference = reference.astype(np.float32)
    drift = float(np.max(np.abs(expected - reference)))
    if drift >= 10.0 * EQUIVALENCE_ATOL:
        pathlib.Path(path).unlink()
        raise ValueError(
            "ensembled graph drifted from the numpy ensemble reference "
            "(max |diff| %.3g); the unverified file was not kept" % drift
        )
    return {
        "exported": True,
        "equivalence": "verified",
        "maxAbsDiff": worst,
        "referenceDrift": drift,
        "checkedWindows": int(windows.shape[0]),
        "ensembleM": float(m),
        "sizeBytes": len(data),
    }


def measure_edge_feasibility(model, normalization, x_rows, m=DEFAULT_ENSEMBLE_M,
                             decision_hz=None, iterations=64):
    """Edge-execution evidence, measured not asserted.

    Times the deterministic decode (the per-inference cost a board runtime
    pays), then derives what the chunk amortization means: at control rate
    R with chunk k, open-loop execution needs one inference per k control
    steps, so the affordable control rate from THIS measurement is
    k / t_infer. Both numbers land in the result's `edgeFeasibility` block
    with the measured context (iterations, host) — a deployment can check
    them against its own board-latency receipt instead of trusting a claim.

    Uses onnxruntime when available (the artifact the board actually runs)
    and falls back to timed torch decode otherwise, labeled honestly.
    """
    if torch is None:
        raise RuntimeError("torch is not installed")
    obs_mean, obs_std, act_mean, act_std = normalization
    batch = np.asarray(x_rows[:1], dtype=np.float32)

    engine = "torch"
    measured = None
    try:
        import onnxruntime as ort

        scratch = pathlib.Path(os.environ.get("RDK_ACT_EDGE_SCRATCH", "."))
        probe = scratch / "edge-feasibility-probe.onnx"
        actor = DeterministicActor(
            model,
            torch.from_numpy(obs_mean.astype(np.float32)),
            torch.from_numpy(obs_std.astype(np.float32)),
            torch.from_numpy(act_mean.astype(np.float32)),
            torch.from_numpy(act_std.astype(np.float32)),
        )
        actor.eval()
        dummy = torch.zeros(1, model.obs_size, dtype=torch.float32)
        import warnings

        with warnings.catch_warnings():
            warnings.filterwarnings("ignore", category=DeprecationWarning)
            torch.onnx.export(actor, (dummy,), probe.as_posix(),
                              input_names=["observation"],
                              output_names=["chunk_actions"],
                              dynamic_axes={"observation": {0: "batch"},
                                            "chunk_actions": {0: "batch"}},
                              opset_version=17)
        session = ort.InferenceSession(probe.as_posix(), providers=["CPUExecutionProvider"])
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
        actor = DeterministicActor(
            model,
            torch.from_numpy(obs_mean.astype(np.float32)),
            torch.from_numpy(obs_std.astype(np.float32)),
            torch.from_numpy(act_mean.astype(np.float32)),
            torch.from_numpy(act_std.astype(np.float32)),
        )
        actor.eval()
        with torch.no_grad():
            actor(batch)  # warmup
        start = time.perf_counter()
        for _ in range(iterations):
            with torch.no_grad():
                actor(batch)
        measured = (time.perf_counter() - start) / iterations

    per_inference_ms = measured * 1000.0
    amortized_ms = per_inference_ms / max(1, model.chunk)
    affordable_control_hz = model.chunk / measured if measured > 0 else float("inf")
    budget = decision_hz
    if budget is None:
        budget = affordable_control_hz
    report = {
        "engine": engine,
        "iterations": int(iterations),
        "decodeMsPerInference": round(per_inference_ms, 4),
        "decodeMsAmortizedPerControlStep": round(amortized_ms, 4),
        "chunk": int(model.chunk),
        "affordableControlHz": round(affordable_control_hz, 1),
        "decisionHz": float(budget),
        "budgetMet": bool(per_inference_ms <= 1000.0 / budget) if budget > 0 else True,
        # Host context: this measurement describes THIS machine, not the
        # board; a deployment gates on its own board-latency receipt.
        "hostContext": platform_label(),
    }
    return report


def platform_label():
    """Short host label for measured-evidence blocks (context, not proof)."""
    import platform

    return "%s/%s" % (platform.system(), platform.machine())


def save_model(payload, report, onnx_report, path):
    """Write the model JSON. Runs only after every failure mode is past —
    a failed run leaves no output file."""
    output = dict(payload)
    output["metrics"] = report
    used = {"numpy", "torch"}
    if onnx_report is not None:
        output["onnx"] = onnx_report
        blocks = [onnx_report]
        ensembled = onnx_report.get("ensembled")
        if isinstance(ensembled, dict):
            blocks.append(ensembled)
        for block in blocks:
            if block.get("equivalence") == "verified":
                used |= {"onnx", "onnxruntime"}
            elif block.get("exported"):
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


def run_engine_mode():
    """File-protocol smoke round for the provenance gate."""
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
    payload, report, model, normalization = fit(
        episodes, chunk=4, d_model=32, heads=4, enc_layers=2, dec_layers=2,
        z_dim=4, token_width=8, kl_weight=10.0, epochs=epochs, lr=1e-3,
        batch_size=32, seed=0, val_fraction=0.25,
    )
    x_rows = np.concatenate([ep[0] for ep in episodes], axis=0)
    model_path = pathlib.Path("model.json")
    onnx_report = export_onnx(model, normalization, "policy.onnx", x_rows)
    # The differentiating artifacts: window-ensembled ONNX + measured edge
    # evidence. Both are labeled honestly when their toolchain is absent.
    window_rows = int(max(1, EQUIVALENCE_ROWS // model.chunk))
    windows = np.lib.stride_tricks.sliding_window_view(
        x_rows[: window_rows + model.chunk - 1], model.chunk, axis=0
    ).transpose(0, 2, 1) if len(x_rows) >= model.chunk else None
    ensembled_report = None
    if windows is not None:
        ensembled_report = export_ensembled_onnx(
            model, normalization, "policy-ensembled.onnx", windows
        )
    edge = measure_edge_feasibility(model, normalization, x_rows)
    if onnx_report is not None:
        onnx_report["ensembled"] = ensembled_report
        onnx_report["edgeFeasibility"] = edge
    save_model(payload, report, onnx_report, model_path)

    result = {
        "schemaVersion": 1,
        "status": "completed",
        "mock": False,
        "engine": ENGINE_NAME,
        "algorithm": "act-chunking-bc",
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
        "metrics": report,
        "artifact": {
            "format": MODEL_FORMAT,
            "path": model_path.name,
            "sizeBytes": model_path.stat().st_size,
            "onnxExported": bool(onnx_report and onnx_report.get("exported")),
            "ensembledOnnxExported": bool(
                ensembled_report and ensembled_report.get("exported")
            ),
        },
    }
    used = {"numpy", "torch"}
    if onnx_report is not None:
        if onnx_report.get("equivalence") == "verified":
            used |= {"onnx", "onnxruntime"}
        elif onnx_report.get("exported"):
            used |= {"onnx"}
    result.update(provenance_block(used))
    pathlib.Path(os.environ["RDK_SIM2REAL_RESULT_FILE"]).write_text(
        json.dumps(result, ensure_ascii=False), encoding="utf-8"
    )
    print(json.dumps({"status": "completed", "engine": ENGINE_NAME}))


def _positive(text, name):
    try:
        value = int(text)
    except ValueError:
        raise ValueError("%s must be an integer, got %r" % (name, text))
    if value <= 0:
        raise ValueError("%s must be positive, got %d" % (name, value))
    return value


def main():
    if os.environ.get("RDK_SIM2REAL_REQUEST_FILE") and os.environ.get(
        "RDK_SIM2REAL_RESULT_FILE"
    ):
        run_engine_mode()
        return

    parser = argparse.ArgumentParser(
        description="Train an ACT (action-chunking Transformer) policy on trajectory JSONL."
    )
    parser.add_argument("dataset", help="trajectory JSONL (step rows with episode markers)")
    parser.add_argument("--out", required=True, help="output model JSON path")
    parser.add_argument("--epochs", type=int, default=200)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--batch", type=int, default=32)
    parser.add_argument("--chunk", type=int, default=8, help="actions predicted per step")
    parser.add_argument("--d-model", type=int, default=64)
    parser.add_argument("--heads", type=int, default=4)
    parser.add_argument("--enc-layers", type=int, default=2)
    parser.add_argument("--dec-layers", type=int, default=2)
    parser.add_argument("--z-dim", type=int, default=8, help="CVAE style latent size")
    parser.add_argument("--token-width", type=int, default=8)
    parser.add_argument(
        "--kl-weight", type=float, default=10.0,
        help="CVAE KL weight (the ACT paper's default is 10; too small lets "
             "the posterior smuggle the whole chunk into z, which the "
             "deterministic z=0 decode cannot recover)",
    )
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument(
        "--val-fraction", type=float, default=0.2,
        help="episode-level validation split fraction; 0 disables validation explicitly",
    )
    parser.add_argument("--onnx", default=None, help="optional ONNX export path")
    parser.add_argument(
        "--image-input",
        default=None,
        help="enable the image branch: WIDTHxHEIGHT (e.g. 64x64) mono8 frames "
        'in every step row\'s "image" field (base64), fused as an extra '
        "encoder token next to the vector observation. Mutually exclusive "
        "with --ensembled-onnx",
    )
    parser.add_argument(
        "--ensembled-onnx", default=None,
        help="optional window-ensembled ONNX export path (last-k observations "
             "-> blended action; the graph IS the temporal ensembling)",
    )
    parser.add_argument(
        "--ensemble-m", type=float, default=DEFAULT_ENSEMBLE_M,
        help="temporal-ensembling exponential decay (prediction age weighting)",
    )
    parser.add_argument(
        "--edge-evidence", action="store_true",
        help="measure decode latency + chunk amortization and record it in the "
             "result (context for deployments; the hard gate stays the "
             "board-latency receipt)",
    )
    parser.add_argument(
        "--decision-hz", type=float, default=None,
        help="control rate to check the measured decode against (with "
             "--edge-evidence; default: the affordable rate from the chunk)",
    )
    args = parser.parse_args()

    if args.epochs <= 0:
        raise ValueError("epochs must be positive")
    if args.batch <= 0:
        raise ValueError("batch must be positive")
    if not (0.0 <= args.val_fraction < 1.0):
        raise ValueError("val-fraction must be in [0, 1)")
    if args.kl_weight < 0.0:
        raise ValueError("kl-weight must be >= 0")
    _positive(args.chunk, "chunk")
    _positive(args.d_model, "d-model")
    _positive(args.heads, "heads")
    _positive(args.enc_layers, "enc-layers")
    _positive(args.dec_layers, "dec-layers")
    _positive(args.z_dim, "z-dim")
    _positive(args.token_width, "token-width")

    episodes, obs_size, act_size, image_shape = load_dataset(
        args.dataset, parse_image_input(args.image_input) if args.image_input else None
    )
    if image_shape is not None and args.ensembled_onnx:
        raise ValueError(
            "--ensembled-onnx is not available for image policies yet: the "
            "window actor would need per-step image windows. Refusing rather "
            "than exporting a partially-specified graph"
        )
    payload, report, model, normalization = fit(
        episodes, args.chunk, args.d_model, args.heads, args.enc_layers,
        args.dec_layers, args.z_dim, args.token_width, args.kl_weight,
        args.epochs, args.lr, args.batch, args.seed, args.val_fraction,
        image_shape,
    )

    onnx_report = None
    x_rows = None
    img_rows = None
    if args.onnx or args.ensembled_onnx or args.edge_evidence:
        x_rows = np.concatenate([ep[0] for ep in episodes], axis=0)
        if image_shape is not None:
            img_rows = np.concatenate([ep[2] for ep in episodes], axis=0)
    if args.onnx:
        onnx_report = export_onnx(
            model, normalization, args.onnx, x_rows,
            image_shape=image_shape, images_check=img_rows,
        )
        state = onnx_report.get("equivalence")
        if state == "skipped-no-onnx":
            print("[act] ONNX export skipped: onnx not installed (%s)" % ONNX_MISSING_HINT)
        elif state == "skipped-no-onnxruntime":
            print(
                "[act] ONNX written but equivalence unverified: "
                "onnxruntime not installed (%s)" % ONNX_MISSING_HINT
            )
    if args.ensembled_onnx:
        if len(x_rows) < model.chunk:
            raise ValueError(
                "dataset has fewer rows (%d) than the chunk (%d): no window to "
                "export" % (len(x_rows), model.chunk)
            )
        windows = np.lib.stride_tricks.sliding_window_view(
            x_rows, model.chunk, axis=0
        ).transpose(0, 2, 1)
        ensembled_report = export_ensembled_onnx(
            model, normalization, args.ensembled_onnx, windows, m=args.ensemble_m
        )
        state = ensembled_report.get("equivalence")
        if state == "skipped-no-onnx":
            print(
                "[act] ensembled ONNX export skipped: onnx not installed (%s)"
                % ONNX_MISSING_HINT
            )
        elif state == "skipped-no-onnxruntime":
            print(
                "[act] ensembled ONNX written but equivalence unverified: "
                "onnxruntime not installed (%s)" % ONNX_MISSING_HINT
            )
        if onnx_report is None:
            onnx_report = {}
        onnx_report["ensembled"] = ensembled_report
    if args.edge_evidence:
        edge = measure_edge_feasibility(
            model, normalization, x_rows,
            decision_hz=args.decision_hz,
        )
        if onnx_report is None:
            onnx_report = {}
        onnx_report["edgeFeasibility"] = edge
        print(
            "[act] edge evidence (%s): decode %.4f ms/inference, amortized "
            "%.4f ms/control-step at chunk %d -> affordable %.1f Hz"
            % (
                edge["engine"], edge["decodeMsPerInference"],
                edge["decodeMsAmortizedPerControlStep"], edge["chunk"],
                edge["affordableControlHz"],
            )
        )
    save_model(payload, report, onnx_report, args.out)
    print(
        json.dumps(
            {
                "format": payload["format"],
                "modality": payload["modality"],
                "train_chunk_mse": report["trainChunkMse"],
                "val_chunk_mse": report["validation"]["chunkMse"],
                "validation": report["validation"]["enabled"],
                "val_per_horizon_mse": report["validation"]["perHorizonMse"],
                "ensemble_mse": report["validation"]["ensembleMse"],
                "first_action_mse": report["validation"]["firstActionMse"],
                "epochs": report["epochs"],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    try:
        if torch is None:
            print(
                "[act] FAIL — torch is not installed "
                "(python3 -m pip install --user torch)",
                file=sys.stderr,
            )
            sys.exit(2)
        main()
    except (ValueError, OSError, RuntimeError) as error:
        print("[act] FAIL — %s" % error, file=sys.stderr)
        sys.exit(2)
