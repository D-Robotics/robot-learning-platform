#!/usr/bin/env python3
"""Contract tests for the Diffusion Policy (CNN action-chunking DDPM) engine.

Wired into `npm run verify` via the shared engine-test convention (the main
session registers verify:diffusion-policy). Runs on the development machine
(no ROS, no board, no GPU) and also works under pytest.

What these tests protect:
- the model is genuinely a diffusion sampler: the ONNX graph IS the whole
  T-step reverse chain (one observation in, one chunk out) and is proven
  elementwise against the torch sampler (allclose rtol 1e-4 / atol 1e-5);
- the denoiser learns: denoising loss falls, and the sampled chunks track
  the ground truth at EVERY horizon in raw action units;
- the episode-level split never lets chunks straddle the split boundary,
  and normalization statistics come from the train side only;
- runs are deterministic: same seed -> bit-identical weights (EMA included);
- a dataset without episode structure is refused (fail-closed), as are
  non-numeric / NaN / inconsistent-dimension rows, with NO output written;
- illegal hyperparameters (zero/negative dims, T < 2, bad schedule) are
  refused before any training happens;
- the exported graph clamps to [-1, 1] (the board's normalized rails) and
  a forced export mismatch deletes the file;
- the x0-prediction clamp (diffusers' clip_denoised) is part of BOTH the
  torch sampler and the graph — the parity that makes the equivalence
  check meaningful;
- edge feasibility is measured and consistent, and the smoke-profile
  parameter/FLOPs budget stays honest;
- the model JSON is the model: rebuild_model(load(payload)) reproduces the
  torch forward exactly;
- the file-protocol engine mode reports mock:false, labels its synthetic
  smoke dataset as synthetic, carries the full provenance contract, and
  writes the SHA256SUMS bundle manifest the worker verifies.
"""

import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
ENGINE = os.path.join(HERE, "train_dp.py")
LOCK_PATH = os.path.join(HERE, "requirements.txt")

sys.path.insert(0, HERE)

try:
    import numpy as np  # noqa: F401
except ImportError:
    print("[dp] SKIP — python3 with numpy not found")
    sys.exit(0)

try:
    import torch  # noqa: F401

    TORCH_AVAILABLE = True
except ImportError:
    TORCH_AVAILABLE = False

try:
    import onnx  # noqa: F401
    import onnxruntime  # noqa: F401

    ONNX_AVAILABLE = True
except ImportError:
    ONNX_AVAILABLE = False

import train_dp  # noqa: E402  (after the sys.path insert and skip guards)


def phase_episodes(num_episodes=12, steps=40, obs=6, act=2, seed=0):
    """Deterministic episodes whose action is a fixed function of the
    current observation phase — chunks are genuinely predictable (the
    h-step action is a phase rotation of sin/cos(phi_t), which the sampler
    must learn to reconstruct), so a working denoiser drives the chunk MSE
    down and a broken one cannot hide.

    The action must NOT depend on per-episode hidden constants: an action
    unidentifiable from the observation puts a floor on the achievable
    MSE that measures the DATASET's ambiguity, not the model.
    """
    rng = np.random.default_rng(seed)
    episodes = []
    for _ in range(num_episodes):
        start = rng.uniform(0.0, 2.0 * np.pi)
        t = np.arange(steps, dtype=np.float64)
        phi = start + 0.1 * t
        observation = np.zeros((steps, obs), dtype=np.float64)
        observation[:, 0] = np.sin(phi)
        observation[:, 1] = np.cos(phi)
        if obs > 2:
            observation[:, 2:] = rng.normal(0.0, 0.05, (steps, obs - 2))
        action = np.column_stack(
            [np.sin(phi + 0.2 * j) for j in range(act)]
        )
        episodes.append((observation, action))
    return episodes


def write_jsonl(path, rows):
    pathlib.Path(path).write_text(
        "\n".join(json.dumps(row) for row in rows), encoding="utf-8"
    )


def episodes_to_step_rows(episodes):
    """Serialize episodes the way the browser recorder does: header, then
    step rows, with done=true closing each episode."""
    rows = [
        {
            "type": "header",
            "format": "microduck-trajectory-v1",
            "source": "test",
            "note": "episodes",
        }
    ]
    for observation, action in episodes:
        for t in range(observation.shape[0]):
            rows.append(
                {
                    "type": "step",
                    "t": 0.02 * t,
                    "observation": [float(v) for v in observation[t]],
                    "action": [float(v) for v in action[t]],
                    "done": t == observation.shape[0] - 1,
                }
            )
    return rows


def tiny_fit(episodes, **overrides):
    """A small-but-real training round with fast defaults for tests."""
    params = dict(
        chunk=4, diffusion_steps=8, schedule="cosine", channels=16,
        d_model=32, epochs=60, lr=1e-3, batch_size=32, seed=0,
        val_fraction=0.25, ema_decay=0.995,
    )
    params.update(overrides)
    return train_dp.fit(episodes, **params)


@unittest.skipUnless(TORCH_AVAILABLE, "torch not installed")
class ChunkingFitTest(unittest.TestCase):
    def test_sampled_chunks_track_ground_truth_at_every_horizon(self):
        episodes = phase_episodes()
        payload, report, model, normalization, schedule = tiny_fit(
            episodes, epochs=120
        )
        self.assertEqual(payload["chunk"], 4)
        # A real diffusion policy: the SAMPLED chunks (full reverse chain,
        # raw action units) must be close to the demonstrated chunks at
        # every horizon — a single-step policy bolted onto chunk output
        # would have a flat/explosive per-horizon tail.
        per_horizon = report["validation"]["perHorizonMse"]
        self.assertEqual(len(per_horizon), 4)
        for mse in per_horizon:
            self.assertLess(
                mse, 0.05,
                "per-horizon MSE %.5f too high — the sampler is not "
                "reconstructing future actions" % mse,
            )

    def test_denoising_loss_falls_from_noise_level(self):
        # The training objective itself must fall: from ~1.0 (predicting
        # noise with an untrained net is unit-variance error) to a small
        # residual on the fixed validation probe.
        episodes = phase_episodes()
        _, report, _, _, _ = tiny_fit(episodes, epochs=40)
        self.assertGreater(report["initialValDenoiseLoss"], 0.9)
        self.assertLess(
            report["validation"]["denoiseLoss"],
            0.5 * report["initialValDenoiseLoss"],
            "fixed-probe denoising loss did not fall — the denoiser is not "
            "learning the noise prediction",
        )

    def test_episode_split_never_straddles_and_stats_come_from_train(self):
        episodes = phase_episodes(num_episodes=10, steps=16, obs=3, act=1, seed=1)
        # Make train/val episodes observably different in scale so leaked
        # statistics would be caught by the saved mean.
        for index, (observation, action) in enumerate(episodes):
            if index % 2 == 0:
                episodes[index] = (observation + 5.0, action)
        x, y, episode_of, _ = train_dp.build_chunks(episodes, chunk=4)
        train_idx, val_idx = train_dp.split_episodes(len(episodes), 0.4, 0)
        train_mask = np.isin(episode_of, train_idx)
        val_mask = np.isin(episode_of, val_idx)
        # Split is by episode: each chunk's episode index maps to exactly one side.
        self.assertTrue(set(episode_of[train_mask].tolist()).isdisjoint(val_idx))
        payload, report, _, _, _ = tiny_fit(episodes, val_fraction=0.4)
        mean = np.asarray(payload["normalization"]["observation"]["mean"])
        expected = x[train_mask].mean(axis=0)
        np.testing.assert_allclose(mean, expected, atol=1e-12)
        self.assertEqual(report["samples"]["train"], int(train_mask.sum()))
        self.assertEqual(report["samples"]["val"], int(val_mask.sum()))

    def test_dataset_too_small_for_split_is_refused(self):
        episodes = phase_episodes(num_episodes=4, steps=12, seed=3)
        with self.assertRaises(ValueError) as ctx:
            tiny_fit(episodes, val_fraction=0.5)
        self.assertIn("val-fraction", str(ctx.exception))


@unittest.skipUnless(TORCH_AVAILABLE, "torch not installed")
class ScheduleTest(unittest.TestCase):
    """The DDPM coefficient tables are the algorithm's load-bearing math."""

    def test_cosine_diffuses_by_terminal_step(self):
        # A valid DDPM chain must destroy the signal by step T (sampling
        # starts from pure noise); the cosine schedule reaches alpha_bar ~ 0.
        schedule = train_dp.DiffusionSchedule("cosine", 16)
        self.assertLess(float(schedule.alpha_bar[-1]), 1e-3)
        self.assertGreater(float(schedule.alpha_bar[0]), 0.9)

    def test_linear_retains_signal_at_small_t(self):
        # The honest counterpart: Ho et al.'s T~1000 betas under-diffuse at
        # small T — documented, not hidden.
        schedule = train_dp.DiffusionSchedule("linear", 16)
        self.assertGreater(float(schedule.alpha_bar[-1]), 0.8)

    def test_posterior_std_of_first_step_is_zero(self):
        # Reverse step 0 has no posterior variance (the standard DDPM
        # convention) — the chain terminates deterministically.
        schedule = train_dp.DiffusionSchedule("cosine", 8)
        self.assertEqual(float(schedule.posterior_std[0]), 0.0)

    def test_steps_below_two_is_refused(self):
        with self.assertRaises(ValueError):
            train_dp.beta_schedule("cosine", 1)

    def test_unknown_schedule_is_refused(self):
        with self.assertRaises(ValueError):
            train_dp.beta_schedule("quadratic", 16)


@unittest.skipUnless(TORCH_AVAILABLE, "torch not installed")
class DeterminismTest(unittest.TestCase):
    def test_same_seed_bit_identical(self):
        episodes = phase_episodes(num_episodes=8, steps=20, seed=5)
        first = tiny_fit(episodes, epochs=6, seed=5)
        second = tiny_fit(episodes, epochs=6, seed=5)
        self.assertEqual(first[0]["state"], second[0]["state"])

    def test_different_seed_different_weights(self):
        episodes = phase_episodes(num_episodes=8, steps=20, seed=5)
        first = tiny_fit(episodes, epochs=6, seed=1)
        second = tiny_fit(episodes, epochs=6, seed=2)
        self.assertNotEqual(first[0]["state"], second[0]["state"])


@unittest.skipUnless(TORCH_AVAILABLE, "torch not installed")
class FailClosedTest(unittest.TestCase):
    def test_rows_without_episode_structure_are_refused(self):
        with tempfile.TemporaryDirectory(prefix="dp-failclosed-") as workdir:
            dataset = os.path.join(workdir, "no-structure.jsonl")
            write_jsonl(
                dataset,
                [
                    {"observation": [1, 2], "action": [0.1]},
                    {"observation": [2, 3], "action": [0.2]},
                ],
            )
            with self.assertRaises(ValueError) as ctx:
                train_dp.load_dataset(dataset)
            self.assertIn("episode structure", str(ctx.exception))

    def test_bad_rows_are_rejected_without_writing_output(self):
        bad = {
            "non-numeric": [{"type": "step", "observation": [1, "a"], "action": [0.1], "done": True}],
            "missing-action": [{"type": "step", "observation": [1, 2], "done": True}],
            "inconsistent-dims": [
                {"type": "step", "observation": [1, 2], "action": [0.1], "done": True},
                {"type": "step", "observation": [1, 2, 3], "action": [0.1], "done": True},
            ],
            "nan": [{"type": "step", "observation": [1, float("nan")], "action": [0.1], "done": True}],
            "empty": [],
            "unknown-type": [{"type": "weird", "observation": [1, 2], "action": [0.1]}],
            "non-bool-done": [{"observation": [1, 2], "action": [0.1], "done": "yes"}],
        }
        with tempfile.TemporaryDirectory(prefix="dp-badrows-") as workdir:
            out = os.path.join(workdir, "model.json")
            for name, rows in bad.items():
                dataset = os.path.join(workdir, "bad.jsonl")
                write_jsonl(dataset, rows)
                with self.assertRaises(ValueError, msg="case %s" % name):
                    train_dp.load_dataset(dataset)
            self.assertFalse(os.path.exists(out))

    def test_all_episodes_shorter_than_chunk_is_refused(self):
        episodes = phase_episodes(num_episodes=4, steps=3, seed=7)
        with self.assertRaises(ValueError) as ctx:
            train_dp.build_chunks(episodes, chunk=8)
        self.assertIn("chunk", str(ctx.exception))

    def test_illegal_hyperparameters_are_refused(self):
        episodes = phase_episodes(num_episodes=6, steps=12, seed=3)
        cases = [
            {"chunk": 0},
            {"diffusion_steps": 1},
            {"diffusion_steps": 0},
            {"diffusion_steps": -4},
            {"schedule": "quadratic"},
            {"channels": 0},
            {"channels": -8},
            {"d_model": 0},
            {"d_model": 33},
            {"epochs": 0},
            {"epochs": -1},
            {"lr": 0.0},
            {"lr": -1e-3},
            {"batch_size": 0},
            {"batch_size": -4},
            {"val_fraction": -0.1},
            {"val_fraction": 1.0},
            {"ema_decay": 0.0},
            {"ema_decay": 1.0},
        ]
        for override in cases:
            params = dict(epochs=1)
            params.update(override)
            with self.assertRaises(
                ValueError, msg="hyperparameter case %r" % override
            ):
                tiny_fit(episodes, **params)

    def test_cli_failure_leaves_no_model_file(self):
        with tempfile.TemporaryDirectory(prefix="dp-cli-") as workdir:
            dataset = os.path.join(workdir, "bad.jsonl")
            write_jsonl(dataset, [{"observation": [1, "x"], "action": [0.1]}])
            out = os.path.join(workdir, "model.json")
            run = subprocess.run(
                [sys.executable, ENGINE, dataset, "--out", out],
                capture_output=True, text=True, timeout=300,
            )
            self.assertEqual(run.returncode, 2, run.stderr)
            self.assertIn("FAIL", run.stderr)
            self.assertNotIn("Traceback", run.stderr)
            self.assertFalse(os.path.exists(out))

    def test_cli_illegal_hyperparameter_fails_closed(self):
        with tempfile.TemporaryDirectory(prefix="dp-cli-hp-") as workdir:
            episodes = phase_episodes(num_episodes=6, steps=12, seed=3)
            dataset = os.path.join(workdir, "ok.jsonl")
            out = os.path.join(workdir, "model.json")
            write_jsonl(dataset, episodes_to_step_rows(episodes))
            run = subprocess.run(
                [
                    sys.executable, ENGINE, dataset, "--out", out,
                    "--diffusion-steps", "1",
                ],
                capture_output=True, text=True, timeout=300,
            )
            self.assertEqual(run.returncode, 2, run.stderr)
            self.assertIn("FAIL", run.stderr)
            self.assertFalse(os.path.exists(out))


@unittest.skipUnless(TORCH_AVAILABLE, "torch not installed")
@unittest.skipUnless(ONNX_AVAILABLE, "onnx/onnxruntime not installed")
class OnnxExportTest(unittest.TestCase):
    def _trained(self, **overrides):
        episodes = phase_episodes(num_episodes=6, steps=24, seed=9)
        params = dict(epochs=20)
        params.update(overrides)
        return episodes, tiny_fit(episodes, **params)

    def test_export_is_verified_against_the_torch_sampler(self):
        episodes, (payload, report, model, normalization, schedule) = self._trained()
        x_rows = np.concatenate([obs for obs, _ in episodes], axis=0)
        with tempfile.TemporaryDirectory(prefix="dp-onnx-") as workdir:
            target = os.path.join(workdir, "policy.onnx")
            onnx_report = train_dp.export_onnx(
                model, normalization, schedule, target, x_rows
            )
            self.assertTrue(onnx_report["exported"])
            self.assertEqual(onnx_report["equivalence"], "verified")
            self.assertEqual(
                onnx_report["diffusionSteps"], model.diffusion_steps
            )
            self.assertLess(
                onnx_report["maxAbsDiff"], train_dp.EQUIVALENCE_ATOL
            )
            self.assertTrue(os.path.exists(target))

    def test_mismatch_deletes_the_file_and_fails(self):
        episodes, (payload, report, model, normalization, schedule) = self._trained(epochs=5)
        x_rows = np.concatenate([obs for obs, _ in episodes], axis=0)
        with tempfile.TemporaryDirectory(prefix="dp-mismatch-") as workdir:
            target = os.path.join(workdir, "policy.onnx")
            original_rtol = train_dp.EQUIVALENCE_RTOL
            original_atol = train_dp.EQUIVALENCE_ATOL
            train_dp.EQUIVALENCE_RTOL = -1.0  # every export now "mismatches"
            train_dp.EQUIVALENCE_ATOL = -1.0
            try:
                with self.assertRaises(ValueError):
                    train_dp.export_onnx(
                        model, normalization, schedule, target, x_rows
                    )
            finally:
                train_dp.EQUIVALENCE_RTOL = original_rtol
                train_dp.EQUIVALENCE_ATOL = original_atol
            self.assertFalse(
                os.path.exists(target), "an unverified ONNX file was kept"
            )

    def test_exported_graph_clamps_to_normalized_rails(self):
        # The graph itself must saturate at [-1, 1]: the board runtime
        # scales policy output by its physical rails, so a drifted weight
        # must never command beyond the normalized bounds.
        episodes, (payload, report, model, normalization, schedule) = self._trained(epochs=5)
        import onnxruntime as ort

        with tempfile.TemporaryDirectory(prefix="dp-clamp-") as workdir:
            target = os.path.join(workdir, "policy.onnx")
            train_dp.export_onnx(
                model, normalization, schedule, target, episodes[0][0]
            )
            session = ort.InferenceSession(
                target, providers=["CPUExecutionProvider"]
            )
            extreme = np.full((4, model.obs_size), 1e6, dtype=np.float32)
            out = session.run(["chunk_actions"], {"observation": extreme})[0]
            self.assertTrue(np.all(out <= 1.0) and np.all(out >= -1.0))

    def test_torch_sampler_matches_seeded_graph_single_row(self):
        # The exported graph's frozen noise realization IS the seeded
        # stochastic sampler's realization at batch 1: same generator seed
        # -> same draws in the same order. This is the parity that makes
        # "deterministic export of a stochastic policy" honest.
        episodes, (payload, report, model, normalization, schedule) = self._trained(epochs=5)
        obs_mean, obs_std, act_mean, act_std = normalization
        seed = 11
        noise_rng = torch.Generator()
        noise_rng.manual_seed(seed + train_dp.SEED_OFFSETS["export_noise"])
        noise = train_dp._sampler_noise(model, noise_rng)
        row = episodes[0][0][3:4].astype(np.float32)
        # The stochastic sampler seeded identically must produce the same
        # draws (x_T then one z per reverse step), i.e. the same trajectory.
        # NOTE: double() mutates in place, so the f64 sampler runs on a
        # deep copy — the actor below must keep the float32 weights.
        import copy

        gen = torch.Generator()
        gen.manual_seed(seed + train_dp.SEED_OFFSETS["export_noise"])
        schedule64 = schedule.sampler_schedule()
        model64 = copy.deepcopy(model).double()
        obs64 = torch.from_numpy(((row - obs_mean) / obs_std).astype(np.float64))
        sampled = train_dp.sample_chunks(model64, schedule64, obs64, gen)
        act_mean_cube = act_mean.reshape(1, model.horizon, model.act_dim)
        act_std_cube = act_std.reshape(1, model.horizon, model.act_dim)
        raw = sampled.numpy() * act_std_cube + act_mean_cube
        actor = train_dp.DiffusionActor(
            model,
            schedule,
            torch.from_numpy(obs_mean.astype(np.float32)),
            torch.from_numpy(obs_std.astype(np.float32)),
            torch.from_numpy(act_mean.astype(np.float32)),
            torch.from_numpy(act_std.astype(np.float32)),
            noise,
        )
        actor.eval()
        with torch.no_grad():
            exported = actor(torch.from_numpy(row)).numpy()
        np.testing.assert_allclose(
            raw, exported, rtol=train_dp.EQUIVALENCE_RTOL,
            atol=train_dp.EQUIVALENCE_ATOL,
        )

    def test_export_runs_the_whole_chain_inside_the_graph(self):
        # The differentiating artifact: the graph contains T denoiser
        # invocations, not one. Structural assertion — count the UNet input
        # conv node occurrences in the model proto.
        episodes, (payload, report, model, normalization, schedule) = self._trained(epochs=5)
        x_rows = np.concatenate([obs for obs, _ in episodes], axis=0)
        with tempfile.TemporaryDirectory(prefix="dp-struct-") as workdir:
            target = os.path.join(workdir, "policy.onnx")
            train_dp.export_onnx(model, normalization, schedule, target, x_rows)
            import onnx as onnx_lib

            graph = onnx_lib.load(target).graph
            input_conv_nodes = [
                node for node in graph.node
                if node.op_type == "Conv"
                and any(
                    name.startswith("/model/input_conv") for name in node.output
                )
            ]
            self.assertEqual(
                len(input_conv_nodes), model.diffusion_steps,
                "the sampler graph must unroll the full %d-step reverse "
                "chain, found %d denoiser invocations"
                % (model.diffusion_steps, len(input_conv_nodes)),
            )


@unittest.skipUnless(TORCH_AVAILABLE, "torch not installed")
class EdgeFeasibilityTest(unittest.TestCase):
    def test_cost_estimate_is_analytic_and_bounded(self):
        # The smoke profile's budget: exact parameter count and the
        # hook-instrumented per-denoise-step FLOPs must stay under the
        # smoke-profile thresholds (same order as act's transformer at
        # smoke scale: < 1e6 parameters, < 1e8 per-decision FLOPs).
        episodes = phase_episodes(num_episodes=4, steps=16, seed=15)
        payload, report, model, normalization, schedule = tiny_fit(
            episodes, epochs=1, channels=16, d_model=32, val_fraction=0.0
        )
        estimate = report["edgeEstimate"]
        self.assertGreater(estimate["parameterCount"], 0)
        self.assertLess(estimate["parameterCount"], 1_000_000)
        self.assertGreater(estimate["denoiseFlopsPerStep"], 0)
        self.assertLess(estimate["denoiseFlopsPerStep"], 50_000_000)
        self.assertEqual(
            estimate["samplingFlopsPerDecision"],
            estimate["denoiseFlopsPerStep"] * estimate["diffusionSteps"],
        )

    def test_evidence_block_is_measured_and_consistent(self):
        episodes = phase_episodes(num_episodes=6, steps=20, seed=15)
        _, _, model, normalization, schedule = tiny_fit(episodes, epochs=3)
        x_rows = np.concatenate([obs for obs, _ in episodes], axis=0)
        with tempfile.TemporaryDirectory(prefix="dp-edge-") as workdir:
            os.environ["RDK_DP_EDGE_SCRATCH"] = workdir
            try:
                edge = train_dp.measure_edge_feasibility(
                    model, normalization, schedule, x_rows, iterations=4
                )
            finally:
                del os.environ["RDK_DP_EDGE_SCRATCH"]
        self.assertIn(edge["engine"], ("onnxruntime", "torch"))
        self.assertGreater(edge["decodeMsPerDecision"], 0.0)
        self.assertEqual(edge["chunk"], model.horizon)
        self.assertEqual(edge["diffusionSteps"], model.diffusion_steps)
        # Amortization is the per-control-step share: one full sampling
        # decision per chunk's worth of control steps.
        self.assertAlmostEqual(
            edge["decodeMsAmortizedPerControlStep"],
            edge["decodeMsPerDecision"] / model.horizon,
            places=2,
        )
        # affordableControlHz is chunk / per-decision seconds.
        self.assertAlmostEqual(
            edge["affordableControlHz"],
            model.horizon / (edge["decodeMsPerDecision"] / 1000.0),
            delta=max(1.0, edge["affordableControlHz"] * 0.02),
        )
        self.assertIn("hostContext", edge)
        self.assertIn("/", edge["hostContext"])

    def test_budget_check_against_explicit_decision_hz(self):
        episodes = phase_episodes(num_episodes=6, steps=20, seed=15)
        _, _, model, normalization, schedule = tiny_fit(episodes, epochs=3)
        x_rows = np.concatenate([obs for obs, _ in episodes], axis=0)
        with tempfile.TemporaryDirectory(prefix="dp-edge2-") as workdir:
            os.environ["RDK_DP_EDGE_SCRATCH"] = workdir
            try:
                # An absurd 1e-6 Hz budget is trivially met; an absurd
                # 1e9 Hz budget is trivially not — both must be honest.
                met = train_dp.measure_edge_feasibility(
                    model, normalization, schedule, x_rows,
                    decision_hz=1e-6, iterations=2,
                )
                not_met = train_dp.measure_edge_feasibility(
                    model, normalization, schedule, x_rows,
                    decision_hz=1e9, iterations=2,
                )
            finally:
                del os.environ["RDK_DP_EDGE_SCRATCH"]
        self.assertTrue(met["budgetMet"])
        self.assertFalse(not_met["budgetMet"])


@unittest.skipUnless(TORCH_AVAILABLE, "torch not installed")
class ModelRoundTripTest(unittest.TestCase):
    def test_rebuild_reproduces_the_forward_exactly(self):
        episodes = phase_episodes(num_episodes=6, steps=20, seed=11)
        payload, report, model, normalization, schedule = tiny_fit(
            episodes, epochs=8
        )
        rebuilt = train_dp.rebuild_model(payload)
        x_rows = np.concatenate([obs for obs, _ in episodes], axis=0)
        obs_mean = np.asarray(payload["normalization"]["observation"]["mean"])
        obs_std = np.asarray(payload["normalization"]["observation"]["std"])
        normalized = ((x_rows - obs_mean) / obs_std).astype(np.float32)
        block = torch.from_numpy(normalized[:16])
        padded = train_dp.pad_horizon(
            torch.zeros(16, model.act_dim, model.horizon), model.padded_horizon
        )
        with torch.no_grad():
            original = model(padded, 3, model.embed_observation(block))
            restored = rebuilt(padded, 3, rebuilt.embed_observation(block))
        np.testing.assert_allclose(
            original.numpy(), restored.numpy(), atol=0.0
        )

    def test_payload_describes_the_architecture_it_ran(self):
        episodes = phase_episodes(num_episodes=6, steps=20, seed=11)
        payload, _, model, _, _ = tiny_fit(episodes, epochs=2)
        self.assertEqual(payload["format"], "rdk-dp-bc-v1")
        arch = payload["architecture"]
        self.assertEqual(arch["channels"], [16, 32, 64])
        self.assertEqual(arch["condDim"], 32)
        self.assertEqual(arch["diffusionSteps"], 8)
        self.assertEqual(arch["schedule"], "cosine")
        self.assertEqual(
            arch["paddedHorizon"], ((payload["chunk"] + 3) // 4) * 4
        )
        self.assertEqual(payload["ema"]["decay"], 0.995)


@unittest.skipUnless(TORCH_AVAILABLE, "torch not installed")
class EngineModeTest(unittest.TestCase):
    """The file protocol the provenance gate drives."""

    def test_smoke_run_is_real_training_on_labeled_synthetic_data(self):
        with tempfile.TemporaryDirectory(prefix="dp-engine-") as workdir:
            request = {
                "schemaVersion": 1,
                "contract": {
                    "id": "dp-smoke",
                    "observationSize": 9,
                    "actionSize": 3,
                },
                "model": {"modelId": "dp-smoke", "version": "0.1.0"},
                "training": {"profile": "smoke", "maxIterations": 3},
            }
            request_path = os.path.join(workdir, "request.json")
            result_path = os.path.join(workdir, "result.json")
            pathlib.Path(request_path).write_text(json.dumps(request))
            run = subprocess.run(
                [sys.executable, ENGINE],
                capture_output=True, text=True, timeout=900, cwd=workdir,
                env={
                    **os.environ,
                    "RDK_SIM2REAL_REQUEST_FILE": request_path,
                    "RDK_SIM2REAL_RESULT_FILE": result_path,
                },
            )
            self.assertEqual(run.returncode, 0, run.stderr)
            result = json.loads(pathlib.Path(result_path).read_text())
            self.assertEqual(result["schemaVersion"], 1)
            self.assertEqual(result["status"], "completed")
            self.assertIs(result["mock"], False)
            self.assertEqual(result["engine"], "diffusion-policy")
            self.assertEqual(result["algorithm"], "diffusion-policy-ddpm")
            self.assertTrue(result["dataset"]["synthetic"])
            self.assertEqual(result["contract"]["observationSize"], 9)
            self.assertEqual(result["contract"]["actionSize"], 3)
            self.assertTrue(result["metrics"]["validation"]["enabled"])
            # The bundle contract the worker verifies.
            self.assertEqual(result["artifactRef"], "artifact://policy.onnx")
            self.assertEqual(
                result["artifact"]["artifactRef"], "artifact://policy.onnx"
            )
            self.assertEqual(result["artifact"]["format"], "onnx")
            self.assertEqual(result["artifact"]["path"], "policy.onnx")
            self.assertGreater(result["artifact"]["sizeBytes"], 0)
            manifest_path = os.path.join(workdir, "SHA256SUMS")
            self.assertTrue(os.path.exists(manifest_path))
            manifest = pathlib.Path(manifest_path).read_text().splitlines()
            self.assertTrue(
                any(line.endswith(" policy.onnx") for line in manifest),
                "SHA256SUMS must cover policy.onnx",
            )
            self.assertTrue(
                any(line.endswith(" model.json") for line in manifest),
                "SHA256SUMS must cover model.json",
            )
            for line in manifest:
                digest, name = line.split("  ", 1)
                actual = hashlib.sha256(
                    pathlib.Path(os.path.join(workdir, name)).read_bytes()
                ).hexdigest()
                self.assertEqual(digest, actual, "manifest drift on %s" % name)
            self.assertEqual(
                result["artifact"]["sha256"],
                hashlib.sha256(
                    pathlib.Path(os.path.join(workdir, "policy.onnx")).read_bytes()
                ).hexdigest(),
            )
            # A CPU trainer never claims cuda; a source artifact never
            # claims deployable.
            self.assertIs(result["cuda"], False)
            self.assertIs(result["deployable"], False)
            # Provenance: source three-field block, measured imports, lock.
            source = result["source"]
            self.assertIn(source.get("known"), (True, False))
            self.assertIn("numpy", result["dependencies"])
            self.assertIn("torch", result["dependencies"])
            self.assertIn("onnx", result["dependencies"])
            if os.path.exists(LOCK_PATH):
                expected = hashlib.sha256(
                    pathlib.Path(LOCK_PATH).read_bytes()
                ).hexdigest()
                self.assertEqual(result["dependencyLockSha256"], expected)
            # The stdout summary is one JSON line.
            summary = json.loads(run.stdout.strip().splitlines()[-1])
            self.assertEqual(summary["status"], "completed")
            self.assertEqual(summary["engine"], "diffusion-policy")

    def test_engine_mode_without_onnx_toolchain_fails_closed(self):
        # The engine's deliverable IS the verified sampler graph: without
        # the onnx toolchain the run must fail closed (exit 2) and leave
        # NO result.json, rather than publish an unverified artifact.
        if ONNX_AVAILABLE:
            self.skipTest("onnx toolchain present; fail-closed path needs it absent")
        with tempfile.TemporaryDirectory(prefix="dp-engine-noonnx-") as workdir:
            request = {
                "schemaVersion": 1,
                "contract": {"id": "dp-x", "observationSize": 4, "actionSize": 2},
                "training": {"profile": "smoke", "maxIterations": 1},
            }
            request_path = os.path.join(workdir, "request.json")
            result_path = os.path.join(workdir, "result.json")
            pathlib.Path(request_path).write_text(json.dumps(request))
            run = subprocess.run(
                [sys.executable, ENGINE],
                capture_output=True, text=True, timeout=600, cwd=workdir,
                env={
                    **os.environ,
                    "RDK_SIM2REAL_REQUEST_FILE": request_path,
                    "RDK_SIM2REAL_RESULT_FILE": result_path,
                },
            )
            self.assertEqual(run.returncode, 2)
            self.assertIn("FAIL", run.stderr)
            self.assertFalse(os.path.exists(result_path))

    def test_cli_end_to_end_on_recorder_format(self):
        episodes = phase_episodes(num_episodes=10, steps=20, seed=13)
        with tempfile.TemporaryDirectory(prefix="dp-cli-e2e-") as workdir:
            dataset = os.path.join(workdir, "traj.jsonl")
            out = os.path.join(workdir, "model.json")
            onnx_target = os.path.join(workdir, "policy.onnx")
            write_jsonl(dataset, episodes_to_step_rows(episodes))
            run = subprocess.run(
                [
                    sys.executable, ENGINE, dataset, "--out", out,
                    "--onnx", onnx_target,
                    "--edge-evidence",
                    "--epochs", "40", "--chunk", "4",
                    "--diffusion-steps", "8",
                    "--channels", "16", "--d-model", "32",
                ],
                capture_output=True, text=True, timeout=900,
            )
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertIn("edge evidence", run.stdout)
            payload = json.loads(pathlib.Path(out).read_text())
            self.assertEqual(payload["format"], "rdk-dp-bc-v1")
            self.assertEqual(payload["chunk"], 4)
            self.assertEqual(payload["observation_size"], 6)
            self.assertEqual(payload["action_size"], 2)
            self.assertEqual(
                payload["architecture"]["diffusionSteps"], 8
            )
            self.assertEqual(
                payload["onnx"]["equivalence"],
                "verified" if ONNX_AVAILABLE else "skipped-no-onnx",
            )
            if ONNX_AVAILABLE:
                self.assertTrue(os.path.exists(onnx_target))
            summary = json.loads(run.stdout.strip().splitlines()[-1])
            self.assertIn("val_chunk_mse", summary)
            self.assertIn("diffusion_steps", summary)
            # Progress lines are honest: no fabricated reward/success.
            for line in run.stdout.splitlines():
                if line.startswith("iter "):
                    self.assertIn("denoiseLoss=", line)
                    self.assertIn("valLoss=", line)
                    self.assertNotIn("meanReward", line)
                    self.assertNotIn("successRate", line)


if __name__ == "__main__":
    unittest.main(verbosity=2)
