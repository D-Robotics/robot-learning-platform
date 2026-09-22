#!/usr/bin/env python3
"""Contract tests for the ACT (action-chunking Transformer) engine.

Wired into `npm run verify` via verify:act. Runs on the development machine
(no ROS, no board, no GPU) and also works under pytest.

What these tests protect:
- the model is genuinely chunking: the output is (batch, chunk, act) and
  predictions at each horizon track the ground truth (a per-horizon MSE
  test would fail for a single-step policy bolted onto chunk output);
- the episode-level split never lets chunks straddle the split boundary,
  and normalization statistics come from the train side only;
- runs are deterministic: same seed -> bit-identical weights;
- a dataset without episode structure is refused (fail-closed), as are
  non-numeric / NaN / inconsistent-dimension rows, with NO output written;
- ONNX export is byte-honest: verified against the torch forward pass, and
  a forced mismatch deletes the file;
- temporal ensembling is the ACT paper's, not a hand-wave: exact weights on
  a constructed example, and smoothing that beats first-action decoding
  when predictions carry execution noise;
- the window-ensembled ONNX graph matches both the torch wrapper and the
  numpy ensemble reference;
- the board-side IncrementalEnsembler is numerically identical to the
  batch reference in full-rate mode and honest about its amortized mode;
- the exported actor clamps to [-1, 1] (the board's normalized rails);
- edge-feasibility evidence is measured, context-labeled, and internally
  consistent;
- the file-protocol engine mode reports mock:false, labels its synthetic
  smoke dataset as synthetic, and carries the full provenance contract;
- the model JSON is the model: rebuild_model(load(payload)) reproduces the
  torch forward exactly.
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
ENGINE = os.path.join(HERE, "train_act.py")
LOCK_PATH = os.path.join(HERE, "requirements.txt")

sys.path.insert(0, HERE)

try:
    import numpy as np  # noqa: F401
except ImportError:
    print("[act] SKIP — python3 with numpy not found")
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

import train_act  # noqa: E402  (after the sys.path insert and skip guards)


def phase_episodes(num_episodes=12, steps=40, obs=6, act=2, seed=0):
    """Deterministic episodes whose action is a fixed function of the
    current observation phase — chunks are genuinely predictable (the
    h-step action is a phase rotation of sin/cos(phi_t), which the chunk
    head must learn to extrapolate), so a working chunker can drive the
    MSE down and a broken one cannot hide.

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
        chunk=4, d_model=32, heads=4, enc_layers=2, dec_layers=2, z_dim=4,
        token_width=8, kl_weight=10.0, epochs=60, lr=1e-3, batch_size=32,
        seed=0, val_fraction=0.25,
    )
    params.update(overrides)
    return train_act.fit(episodes, **params)


@unittest.skipUnless(TORCH_AVAILABLE, "torch not installed")
class ChunkingFitTest(unittest.TestCase):
    def test_chunks_track_ground_truth_at_every_horizon(self):
        episodes = phase_episodes()
        payload, report, _, _ = tiny_fit(episodes, epochs=120)
        self.assertEqual(payload["chunk"], 4)
        # A real chunker: held-out chunk MSE must be small AND every horizon
        # must track (a single-step policy bolted on chunk output would have
        # a flat/explosive per-horizon tail).
        per_horizon = report["validation"]["perHorizonMse"]
        self.assertEqual(len(per_horizon), 4)
        for mse in per_horizon:
            self.assertLess(
                mse, 0.01,
                "per-horizon MSE %.5f too high — the chunk head is not "
                "predicting future actions" % mse,
            )

    def test_episode_split_never_straddles_and_stats_come_from_train(self):
        episodes = phase_episodes(num_episodes=10, steps=16, obs=3, act=1, seed=1)
        # Make train/val episodes observably different in scale so leaked
        # statistics would be caught by the saved mean.
        for index, (observation, action) in enumerate(episodes):
            if index % 2 == 0:
                episodes[index] = (observation + 5.0, action)
        x, y, episode_of, _ = train_act.build_chunks(episodes, chunk=4)
        train_idx, val_idx = train_act.split_episodes(len(episodes), 0.4, 0)
        train_mask = np.isin(episode_of, train_idx)
        val_mask = np.isin(episode_of, val_idx)
        # Split is by episode: each chunk's episode index maps to exactly one side.
        self.assertTrue(set(episode_of[train_mask].tolist()).isdisjoint(val_idx))
        payload, report, _, _ = tiny_fit(episodes, val_fraction=0.4)
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
        with tempfile.TemporaryDirectory(prefix="act-failclosed-") as workdir:
            dataset = os.path.join(workdir, "no-structure.jsonl")
            write_jsonl(
                dataset,
                [
                    {"observation": [1, 2], "action": [0.1]},
                    {"observation": [2, 3], "action": [0.2]},
                ],
            )
            with self.assertRaises(ValueError) as ctx:
                train_act.load_dataset(dataset)
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
        with tempfile.TemporaryDirectory(prefix="act-badrows-") as workdir:
            out = os.path.join(workdir, "model.json")
            for name, rows in bad.items():
                dataset = os.path.join(workdir, "bad.jsonl")
                write_jsonl(dataset, rows)
                with self.assertRaises(ValueError, msg="case %s" % name):
                    train_act.load_dataset(dataset)
            self.assertFalse(os.path.exists(out))

    def test_all_episodes_shorter_than_chunk_is_refused(self):
        episodes = phase_episodes(num_episodes=4, steps=3, seed=7)
        with self.assertRaises(ValueError) as ctx:
            train_act.build_chunks(episodes, chunk=8)
        self.assertIn("chunk", str(ctx.exception))

    def test_cli_failure_leaves_no_model_file(self):
        with tempfile.TemporaryDirectory(prefix="act-cli-") as workdir:
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


@unittest.skipUnless(TORCH_AVAILABLE, "torch not installed")
class TemporalEnsemblingTest(unittest.TestCase):
    def test_exact_weights_on_a_constructed_example(self):
        # k=2, m=0.0: at t the two opinions are chunk[t-1, 1] and chunk[t, 0],
        # equally weighted.
        chunks = np.array(
            [
                [[1.0], [3.0]],
                [[5.0], [7.0]],
                [[9.0], [11.0]],
            ]
        )
        blended = train_act.ensemble_predictions(chunks, m=0.0)
        # t=0 has only chunk[0,0]; t=1 averages chunk[0,1] and chunk[1,0]; t=2
        # averages chunk[1,1] and chunk[2,0].
        np.testing.assert_allclose(blended[:, 0], [1.0, 4.0, 8.0], atol=1e-12)

    def test_large_m_recovers_first_action_decoding(self):
        # Large m keeps only the freshest chunk's first action.
        chunks = np.array(
            [
                [[1.0], [3.0]],
                [[5.0], [7.0]],
                [[9.0], [11.0]],
            ]
        )
        blended = train_act.ensemble_predictions(chunks, m=50.0)
        np.testing.assert_allclose(blended[:, 0], [1.0, 5.0, 9.0], atol=1e-6)

    def test_ensemble_smooths_execution_noise(self):
        # Each chunk is ground truth plus independent noise; the ensemble
        # averages independent opinions, so its MSE must beat the naive
        # first-action readout.
        rng = np.random.default_rng(0)
        steps, k, act = 400, 8, 2
        truth = np.sin(np.arange(steps)[:, None] * 0.05) * np.ones((1, act))
        chunks = np.zeros((steps, k, act))
        for t in range(steps):
            for h in range(k):
                if t + h < steps:
                    chunks[t, h] = truth[t + h] + rng.normal(0.0, 0.2, act)
        blended = train_act.ensemble_predictions(chunks, m=0.1)
        first = np.array([chunks[t, 0] for t in range(steps)])
        ens_mse = float(np.mean((blended - truth) ** 2))
        first_mse = float(np.mean((first - truth) ** 2))
        self.assertLess(
            ens_mse, first_mse,
            "ensembling (%.4f) must beat first-action decoding (%.4f) under "
            "execution noise" % (ens_mse, first_mse),
        )

    def test_rejects_non_3d_input(self):
        with self.assertRaises(ValueError):
            train_act.ensemble_predictions(np.zeros((4, 2)))


@unittest.skipUnless(TORCH_AVAILABLE, "torch not installed")
class IncrementalEnsemblerTest(unittest.TestCase):
    """The board-side runtime must be the reference math, not a re-derivation
    that silently drifted."""

    def test_full_rate_matches_batch_reference_exactly(self):
        rng = np.random.default_rng(3)
        steps, k, act = 60, 4, 3
        chunks = rng.normal(0.0, 1.0, (steps, k, act))
        reference = train_act.ensemble_predictions(chunks, m=0.1)
        ensembler = train_act.IncrementalEnsembler(k, act, m=0.1)
        blended = np.stack([ensembler.push(chunks[t]) or ensembler.step() for t in range(steps)])
        np.testing.assert_allclose(blended, reference, atol=1e-12)

    def test_amortized_mode_is_the_freshest_chunk_open_loop(self):
        # Pushing every k steps: the only live opinion is the chunk issued
        # at the current step, so step() returns its first action — the
        # honest degradation the amortized mode is.
        rng = np.random.default_rng(4)
        k, act = 4, 2
        chunk = rng.normal(0.0, 1.0, (k, act))
        ensembler = train_act.IncrementalEnsembler(k, act, m=0.1)
        ensembler.push(chunk)
        for offset in range(k):
            action = ensembler.step()
            np.testing.assert_allclose(action, chunk[offset], atol=1e-9)

    def test_step_before_push_fails_closed(self):
        ensembler = train_act.IncrementalEnsembler(4, 2)
        with self.assertRaises(RuntimeError):
            ensembler.step()

    def test_wrong_chunk_shape_is_rejected(self):
        ensembler = train_act.IncrementalEnsembler(4, 2)
        with self.assertRaises(ValueError):
            ensembler.push(np.zeros((3, 2)))


@unittest.skipUnless(TORCH_AVAILABLE, "torch not installed")
@unittest.skipUnless(ONNX_AVAILABLE, "onnx/onnxruntime not installed")
class OnnxExportTest(unittest.TestCase):
    def test_export_is_verified_against_the_torch_forward(self):
        episodes = phase_episodes(num_episodes=6, steps=24, seed=9)
        payload, report, model, normalization = tiny_fit(episodes, epochs=20)
        x_rows = np.concatenate([obs for obs, _ in episodes], axis=0)
        with tempfile.TemporaryDirectory(prefix="act-onnx-") as workdir:
            target = os.path.join(workdir, "policy.onnx")
            onnx_report = train_act.export_onnx(model, normalization, target, x_rows)
            self.assertTrue(onnx_report["exported"])
            self.assertEqual(onnx_report["equivalence"], "verified")
            self.assertLess(onnx_report["maxAbsDiff"], train_act.EQUIVALENCE_ATOL)
            self.assertTrue(os.path.exists(target))

    def test_mismatch_deletes_the_file_and_fails(self):
        episodes = phase_episodes(num_episodes=6, steps=24, seed=9)
        payload, report, model, normalization = tiny_fit(episodes, epochs=5)
        x_rows = np.concatenate([obs for obs, _ in episodes], axis=0)
        with tempfile.TemporaryDirectory(prefix="act-mismatch-") as workdir:
            target = os.path.join(workdir, "policy.onnx")
            original = train_act.EQUIVALENCE_ATOL
            train_act.EQUIVALENCE_ATOL = -1.0  # every export now "mismatches"
            try:
                with self.assertRaises(ValueError):
                    train_act.export_onnx(model, normalization, target, x_rows)
            finally:
                train_act.EQUIVALENCE_ATOL = original
            self.assertFalse(
                os.path.exists(target), "an unverified ONNX file was kept"
            )

    def test_exported_actor_clamps_to_normalized_rails(self):
        # The graph itself must saturate at [-1, 1]: the board runtime
        # scales policy output by its physical rails, so a drifted weight
        # must never command beyond the normalized bounds.
        episodes = phase_episodes(num_episodes=6, steps=24, seed=9)
        payload, report, model, normalization = tiny_fit(episodes, epochs=5)
        import onnxruntime as ort

        with tempfile.TemporaryDirectory(prefix="act-clamp-") as workdir:
            target = os.path.join(workdir, "policy.onnx")
            train_act.export_onnx(model, normalization, target, episodes[0][0])
            session = ort.InferenceSession(target, providers=["CPUExecutionProvider"])
            extreme = np.full((4, model.obs_size), 1e6, dtype=np.float32)
            out = session.run(["chunk_actions"], {"observation": extreme})[0]
            self.assertTrue(np.all(out <= 1.0) and np.all(out >= -1.0))

    def test_window_ensembled_export_proven_two_ways(self):
        episodes = phase_episodes(num_episodes=6, steps=24, seed=11)
        payload, report, model, normalization = tiny_fit(episodes, epochs=20)
        x_rows = np.concatenate([obs for obs, _ in episodes], axis=0)
        k = model.chunk
        windows = np.lib.stride_tricks.sliding_window_view(
            x_rows, k, axis=0
        ).transpose(0, 2, 1)
        with tempfile.TemporaryDirectory(prefix="act-window-") as workdir:
            target = os.path.join(workdir, "policy-ensembled.onnx")
            report_out = train_act.export_ensembled_onnx(
                model, normalization, target, windows, m=0.1
            )
            self.assertTrue(report_out["exported"])
            self.assertEqual(report_out["equivalence"], "verified")
            self.assertLess(report_out["maxAbsDiff"], train_act.EQUIVALENCE_ATOL)
            self.assertLess(report_out["referenceDrift"], 10 * train_act.EQUIVALENCE_ATOL)
            self.assertTrue(os.path.exists(target))

    def test_window_export_mismatch_deletes_the_file(self):
        episodes = phase_episodes(num_episodes=6, steps=24, seed=11)
        payload, report, model, normalization = tiny_fit(episodes, epochs=5)
        x_rows = np.concatenate([obs for obs, _ in episodes], axis=0)
        k = model.chunk
        windows = np.lib.stride_tricks.sliding_window_view(
            x_rows, k, axis=0
        ).transpose(0, 2, 1)
        with tempfile.TemporaryDirectory(prefix="act-wmm-") as workdir:
            target = os.path.join(workdir, "policy-ensembled.onnx")
            original = train_act.EQUIVALENCE_ATOL
            train_act.EQUIVALENCE_ATOL = -1.0
            try:
                with self.assertRaises(ValueError):
                    train_act.export_ensembled_onnx(
                        model, normalization, target, windows, m=0.1
                    )
            finally:
                train_act.EQUIVALENCE_ATOL = original
            self.assertFalse(
                os.path.exists(target), "an unverified ensembled ONNX file was kept"
            )

    def test_window_actor_matches_torch_reference(self):
        # The torch EnsembledWindowActor itself must agree with decoding
        # each window position and applying the numpy reference — this is
        # the parity that makes "the graph IS the ensembling" true.
        episodes = phase_episodes(num_episodes=6, steps=24, seed=13)
        payload, report, model, normalization = tiny_fit(episodes, epochs=5)
        obs_mean, obs_std, act_mean, act_std = normalization
        actor = train_act.DeterministicActor(
            model,
            torch.from_numpy(obs_mean.astype(np.float32)),
            torch.from_numpy(obs_std.astype(np.float32)),
            torch.from_numpy(act_mean.astype(np.float32)),
            torch.from_numpy(act_std.astype(np.float32)),
        )
        actor.eval()
        wrapped = train_act.EnsembledWindowActor(actor, 0.1)
        wrapped.eval()
        x_rows = np.concatenate([obs for obs, _ in episodes], axis=0)
        k = model.chunk
        windows = np.lib.stride_tricks.sliding_window_view(
            x_rows, k, axis=0
        ).transpose(0, 2, 1).astype(np.float32)
        with torch.no_grad():
            got = wrapped(torch.from_numpy(windows[:16])).numpy()
            decoded = actor(torch.from_numpy(windows[:16].reshape(-1, model.obs_size)))
            decoded = decoded.reshape(16, k, k, model.act_size).numpy()
        expected = np.stack(
            [
                train_act.ensemble_predictions(decoded[b].astype(np.float64), m=0.1)[
                    k - 1
                ]
                for b in range(16)
            ]
        )
        np.testing.assert_allclose(got, expected, atol=1e-6)


@unittest.skipUnless(TORCH_AVAILABLE, "torch not installed")
class EdgeFeasibilityTest(unittest.TestCase):
    def test_evidence_block_is_measured_and_consistent(self):
        episodes = phase_episodes(num_episodes=6, steps=20, seed=15)
        payload, report, model, normalization = tiny_fit(episodes, epochs=3)
        x_rows = np.concatenate([obs for obs, _ in episodes], axis=0)
        with tempfile.TemporaryDirectory(prefix="act-edge-") as workdir:
            os.environ["RDK_ACT_EDGE_SCRATCH"] = workdir
            try:
                edge = train_act.measure_edge_feasibility(
                    model, normalization, x_rows, iterations=8
                )
            finally:
                del os.environ["RDK_ACT_EDGE_SCRATCH"]
        self.assertIn(edge["engine"], ("onnxruntime", "torch"))
        self.assertGreater(edge["decodeMsPerInference"], 0.0)
        self.assertEqual(edge["chunk"], model.chunk)
        # Amortization is the per-control-step share: one inference per
        # chunk's worth of control steps.
        self.assertAlmostEqual(
            edge["decodeMsAmortizedPerControlStep"],
            edge["decodeMsPerInference"] / model.chunk,
            places=2,
        )
        # affordableControlHz is chunk / per-inference seconds.
        self.assertAlmostEqual(
            edge["affordableControlHz"],
            model.chunk / (edge["decodeMsPerInference"] / 1000.0),
            delta=max(1.0, edge["affordableControlHz"] * 0.02),
        )
        self.assertIn("hostContext", edge)
        self.assertIn("/", edge["hostContext"])

    def test_budget_check_against_explicit_decision_hz(self):
        episodes = phase_episodes(num_episodes=6, steps=20, seed=15)
        payload, report, model, normalization = tiny_fit(episodes, epochs=3)
        x_rows = np.concatenate([obs for obs, _ in episodes], axis=0)
        with tempfile.TemporaryDirectory(prefix="act-edge2-") as workdir:
            os.environ["RDK_ACT_EDGE_SCRATCH"] = workdir
            try:
                # An absurd 1 Hz budget is trivially met; an absurd
                # 1e9 Hz budget is trivially not — both must be honest.
                met = train_act.measure_edge_feasibility(
                    model, normalization, x_rows, decision_hz=1.0, iterations=4
                )
                not_met = train_act.measure_edge_feasibility(
                    model, normalization, x_rows, decision_hz=1e9, iterations=4
                )
            finally:
                del os.environ["RDK_ACT_EDGE_SCRATCH"]
        self.assertTrue(met["budgetMet"])
        self.assertFalse(not_met["budgetMet"])


@unittest.skipUnless(TORCH_AVAILABLE, "torch not installed")
class ModelRoundTripTest(unittest.TestCase):
    def test_rebuild_reproduces_the_forward_exactly(self):
        episodes = phase_episodes(num_episodes=6, steps=20, seed=11)
        payload, report, model, normalization = tiny_fit(episodes, epochs=8)
        rebuilt = train_act.rebuild_model(payload)
        x_rows = np.concatenate([obs for obs, _ in episodes], axis=0)
        obs_mean = np.asarray(payload["normalization"]["observation"]["mean"])
        obs_std = np.asarray(payload["normalization"]["observation"]["std"])
        normalized = ((x_rows - obs_mean) / obs_std).astype(np.float32)
        with torch.no_grad():
            original = model(torch.from_numpy(normalized)).numpy()
            restored = rebuilt(torch.from_numpy(normalized)).numpy()
        np.testing.assert_allclose(original, restored, atol=0.0)
        self.assertEqual(original.shape, (x_rows.shape[0], payload["chunk"], payload["action_size"]))


@unittest.skipUnless(TORCH_AVAILABLE, "torch not installed")
class EngineModeTest(unittest.TestCase):
    """The file protocol the provenance gate drives."""

    def test_smoke_run_is_real_training_on_labeled_synthetic_data(self):
        with tempfile.TemporaryDirectory(prefix="act-engine-") as workdir:
            request = {
                "schemaVersion": 1,
                "contract": {
                    "id": "act-smoke",
                    "observationSize": 9,
                    "actionSize": 3,
                },
                "model": {"modelId": "act-smoke", "version": "0.1.0"},
                "training": {"profile": "smoke", "maxIterations": 3},
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
            self.assertEqual(run.returncode, 0, run.stderr)
            result = json.loads(pathlib.Path(result_path).read_text())
            self.assertEqual(result["schemaVersion"], 1)
            self.assertEqual(result["status"], "completed")
            self.assertIs(result["mock"], False)
            self.assertEqual(result["engine"], "act")
            self.assertEqual(result["algorithm"], "act-chunking-bc")
            self.assertTrue(result["dataset"]["synthetic"])
            self.assertEqual(result["contract"]["observationSize"], 9)
            self.assertEqual(result["contract"]["actionSize"], 3)
            self.assertTrue(result["metrics"]["validation"]["enabled"])
            self.assertTrue(os.path.exists(os.path.join(workdir, "model.json")))
            # The differentiating artifacts must be reported honestly.
            self.assertIn("ensembledOnnxExported", result["artifact"])
            onnx_block = result.get("onnx") or json.loads(
                pathlib.Path(os.path.join(workdir, "model.json")).read_text()
            )["onnx"]
            self.assertIn("edgeFeasibility", onnx_block)
            self.assertIn("ensembled", onnx_block)
            source = result["source"]
            self.assertIn(source.get("known"), (True, False))
            self.assertIn("numpy", result["dependencies"])
            self.assertIn("torch", result["dependencies"])
            if os.path.exists(LOCK_PATH):
                expected = hashlib.sha256(
                    pathlib.Path(LOCK_PATH).read_bytes()
                ).hexdigest()
                self.assertEqual(result["dependencyLockSha256"], expected)

    def test_cli_end_to_end_on_recorder_format(self):
        episodes = phase_episodes(num_episodes=10, steps=20, seed=13)
        with tempfile.TemporaryDirectory(prefix="act-cli-e2e-") as workdir:
            dataset = os.path.join(workdir, "traj.jsonl")
            out = os.path.join(workdir, "model.json")
            onnx_target = os.path.join(workdir, "policy.onnx")
            ensembled_target = os.path.join(workdir, "policy-ensembled.onnx")
            write_jsonl(dataset, episodes_to_step_rows(episodes))
            run = subprocess.run(
                [
                    sys.executable, ENGINE, dataset, "--out", out,
                    "--onnx", onnx_target,
                    "--ensembled-onnx", ensembled_target,
                    "--edge-evidence",
                    "--epochs", "40", "--chunk", "4",
                    "--d-model", "32", "--heads", "4",
                    "--enc-layers", "1", "--dec-layers", "1",
                ],
                capture_output=True, text=True, timeout=600,
            )
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertIn("edge evidence", run.stdout)
            payload = json.loads(pathlib.Path(out).read_text())
            self.assertEqual(payload["format"], "rdk-act-bc-v1")
            self.assertEqual(payload["chunk"], 4)
            self.assertEqual(payload["observation_size"], 6)
            self.assertEqual(payload["action_size"], 2)
            self.assertEqual(payload["onnx"]["equivalence"], "verified")
            self.assertEqual(payload["onnx"]["ensembled"]["equivalence"], "verified")
            self.assertIn("edgeFeasibility", payload["onnx"])
            self.assertTrue(os.path.exists(ensembled_target))
            summary = json.loads(run.stdout.strip().splitlines()[-1])
            self.assertIn("val_chunk_mse", summary)


def quadrant_image_rows(num_episodes=8, steps=24, size=32, seed=0):
    """Image-mode step rows: black frames drive one action, white frames the
    opposite — the maximum-contrast pixel task. Low-contrast spatial tasks
    (quadrant-only differences) need a pretrained backbone or a much longer
    schedule; this task exists to prove the conv branch drives the output
    end to end."""
    import base64

    rng = np.random.default_rng(seed)
    rows = [{"type": "header", "format": "microduck-trajectory-v1", "source": "test"}]
    for i in range(num_episodes):
        bright = i % 2 == 0
        img = np.full((size, size), 255 if bright else 0, dtype=np.uint8)
        img = np.clip(
            img.astype(np.int64) + rng.integers(0, 8, img.shape), 0, 255
        ).astype(np.uint8)
        action = [0.8, 0.3] if bright else [-0.8, -0.3]
        for t in range(steps):
            rows.append(
                {
                    "type": "step",
                    "t": 0.02 * t,
                    "observation": [float(t) / steps, 0.5],
                    "action": action,
                    "image": base64.b64encode(img.tobytes()).decode(),
                    "done": t == steps - 1,
                }
            )
    return rows


@unittest.skipUnless(TORCH_AVAILABLE, "torch not installed")
class ImageActTest(unittest.TestCase):
    def test_parse_image_input_rejects_collapsing_dims(self):
        self.assertEqual(train_act.parse_image_input("64x64"), (64, 64))
        for bad in ("16x16", "8x8", "0x64", "abc", "64"):
            with self.assertRaises(ValueError):
                train_act.parse_image_input(bad)

    def _load(self, rows):
        import tempfile as _tempfile

        handle = _tempfile.NamedTemporaryFile(
            "w", suffix=".jsonl", delete=False
        )
        handle.write("\n".join(json.dumps(r) for r in rows) + "\n")
        handle.close()
        try:
            return train_act.load_dataset(handle.name, (32, 32))
        finally:
            os.unlink(handle.name)

    def test_image_dataset_rules_fail_closed(self):
        import base64

        good = base64.b64encode(np.zeros((32, 32), dtype=np.uint8).tobytes()).decode()
        cases = {
            "missing image": {"type": "step", "observation": [0.0], "action": [0.1], "done": True},
            "not base64": {"type": "step", "observation": [0.0], "action": [0.1], "image": "!!!", "done": True},
            "wrong bytes": {"type": "step", "observation": [0.0], "action": [0.1], "image": base64.b64encode(b"\x00" * 9).decode(), "done": True},
        }
        for label, row in cases.items():
            with self.assertRaises(ValueError, msg=label):
                self._load([row])

    def test_image_act_learns_a_pixel_task(self):
        episodes, obs_size, act_size, image_shape = self._load(
            quadrant_image_rows(num_episodes=8)
        )
        self.assertEqual(image_shape, (32, 32))
        payload, report, model, _ = tiny_fit(
            episodes, image_shape=image_shape, epochs=2000
        )
        self.assertEqual(payload["format"], train_act.MODEL_FORMAT_IMAGE)
        self.assertEqual(payload["modality"], "image+vector")
        self.assertIsNotNone(model.image_encoder)
        self.assertTrue(report["validation"]["enabled"])
        self.assertLess(
            report["validation"]["chunkMse"], 0.05,
            "val chunk MSE %.4f on the quadrant task - the conv branch did not learn"
            % report["validation"]["chunkMse"],
        )

    @unittest.skipUnless(ONNX_AVAILABLE, "onnx/onnxruntime not installed")
    def test_image_onnx_export_is_nhwc_and_verified(self):
        import onnx

        episodes, _, _, image_shape = self._load(quadrant_image_rows())
        payload, _, model, normalization = tiny_fit(
            episodes, image_shape=image_shape, epochs=3
        )
        x_rows = np.concatenate([ep[0] for ep in episodes], axis=0)
        imgs = np.concatenate([ep[2] for ep in episodes], axis=0)
        out = pathlib.Path(tempfile.gettempdir()) / "act-image-equivalence.onnx"
        try:
            report = train_act.export_onnx(
                model, normalization, out.as_posix(), x_rows,
                image_shape=image_shape, images_check=imgs,
            )
            self.assertEqual(report.get("equivalence"), "verified")
            graph = onnx.load(out.as_posix()).graph
            names = [i.name for i in graph.input]
            self.assertIn("image", names)
            image_input = next(i for i in graph.input if i.name == "image")
            shape = [d.dim_param or d.dim_value for d in image_input.type.tensor_type.shape.dim]
            self.assertEqual(len(shape), 4, "image input must be rank-4")
            self.assertEqual(shape[3], 1, "platform vision gate expects NHWC with fixed channels")
            self.assertEqual(shape[1], 32)
            self.assertEqual(shape[2], 32)
        finally:
            if out.exists():
                out.unlink()

    def test_image_mode_refuses_the_ensembled_export(self):
        with tempfile.TemporaryDirectory() as tmp:
            ds = pathlib.Path(tmp) / "ds.jsonl"
            write_jsonl(ds.as_posix(), quadrant_image_rows())
            run = subprocess.run(
                [sys.executable, ENGINE, ds.as_posix(), "--image-input", "32x32",
                 "--out", pathlib.Path(tmp).joinpath("m.json").as_posix(),
                 "--epochs", "2", "--ensembled-onnx",
                 pathlib.Path(tmp).joinpath("e.onnx").as_posix()],
                capture_output=True, text=True,
            )
            self.assertNotEqual(run.returncode, 0)
            self.assertIn("ensembled", run.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
