"""End-to-end policy loading against real ONNX graphs (onnx + onnxruntime).

Unlike ``test_policy_contract.py`` (pure fakes), this builds an actual LSTM
graph — dynamic batch dim, hidden state in/out — the way a community export
(e.g. a basketball-balancing LSTM actor) looks, then checks that ``load_policy``
classifies it and that ``act``/``reset`` reproduce what a hand-fed
onnxruntime loop computes. Skipped when onnx/onnxruntime are not installed so
the pure-logic suite stays hermetic.
"""

from __future__ import annotations

import numpy as np
import pytest

onnx = pytest.importorskip("onnx")
onnx.helper = onnx.helper  # keep linters honest; real use below

import onnxruntime as ort  # noqa: E402

from microduck_eval.policy import ACTION_SIZE, OBSERVATION_SIZE, load_policy  # noqa: E402

HIDDEN = 16


def _axes(values: list[int]):
    return onnx.numpy_helper.from_array(np.asarray(values, dtype=np.int64), name=None)


def _tensor(name: str, dims: list, dtype=onnx.TensorProto.FLOAT) -> onnx.ValueInfoProto:
    return onnx.helper.make_tensor_value_info(name, dtype, dims)


def build_lstm_graph() -> onnx.ModelProto:
    """obs[batch,61] + h/c[1,batch,H] -> actions[batch,14] + h/c[1,batch,H]."""
    obs = _tensor("obs", ["batch", OBSERVATION_SIZE])
    # LSTM initial state is rank-3 [directions, batch, hidden] with a symbolic
    # batch dim, exactly what a dynamic-batch community export declares.
    h_in = _tensor("h_in", [1, "batch", HIDDEN])
    c_in = _tensor("c_in", [1, "batch", HIDDEN])
    actions = _tensor("actions", ["batch", ACTION_SIZE])
    h_out = _tensor("h_out", [1, "batch", HIDDEN])
    c_out = _tensor("c_out", [1, "batch", HIDDEN])

    # X must be [seq, batch, input]; our policy feeds one step at a time.
    # opset 13 moved Squeeze/Unsqueeze axes from attributes to a second input.
    unsqueeze = onnx.helper.make_node("Unsqueeze", ["obs", "ax0"], ["x_seq"], name="to_seq")
    lstm = onnx.helper.make_node(
        "LSTM",
        # ONNX orders LSTM inputs X, W, R, B, sequence_lens, initial_h,
        # initial_c. sequence_lens is optional but positional, so it must be
        # present as an empty name — omitting it silently shifts h/c into its
        # slot and onnxruntime rejects the graph with a type error on h_in.
        ["x_seq", "W", "R", "B", "", "h_in", "c_in"],
        ["y_seq", "h_out", "c_out"],
        hidden_size=HIDDEN,
        name="lstm",
    )
    squeeze_out = onnx.helper.make_node(
        "Squeeze", ["y_seq", "ax01"], ["y_frame"], name="from_seq"
    )
    gemm = onnx.helper.make_node("Gemm", ["y_frame", "Wout", "Bout"], ["actions"], name="readout")

    W = onnx.numpy_helper.from_array(
        np.random.default_rng(7).normal(0, 0.1, (1, 4 * HIDDEN, OBSERVATION_SIZE)).astype(np.float32),
        "W",
    )
    R = onnx.numpy_helper.from_array(
        np.random.default_rng(8).normal(0, 0.1, (1, 4 * HIDDEN, HIDDEN)).astype(np.float32),
        "R",
    )
    # LSTM B is [num_directions, 8*hidden]: forget-gate bias 1 helps the state
    # move so the carry check below is meaningful.
    bias = np.zeros((1, 8 * HIDDEN), dtype=np.float32)
    bias[0, HIDDEN : 2 * HIDDEN] = 1.0
    B = onnx.numpy_helper.from_array(bias, "B")
    Wout = onnx.numpy_helper.from_array(
        np.random.default_rng(9).normal(0, 0.2, (HIDDEN, ACTION_SIZE)).astype(np.float32), "Wout"
    )
    Bout = onnx.numpy_helper.from_array(np.zeros(ACTION_SIZE, dtype=np.float32), "Bout")
    ax0 = onnx.numpy_helper.from_array(np.asarray([0], dtype=np.int64), "ax0")
    ax01 = onnx.numpy_helper.from_array(np.asarray([0, 1], dtype=np.int64), "ax01")

    graph = onnx.helper.make_graph(
        [unsqueeze, lstm, squeeze_out, gemm],
        "microduck-lstm-actor",
        [obs, h_in, c_in],
        [actions, h_out, c_out],
        [W, R, B, Wout, Bout, ax0, ax01],
    )
    model = onnx.helper.make_model(
        graph, opset_imports=[onnx.helper.make_opsetid("", 16)]
    )
    model.ir_version = 8
    onnx.checker.check_model(model)
    return model


def build_feedforward_graph() -> onnx.ModelProto:
    obs = _tensor("obs", ["batch", OBSERVATION_SIZE])
    actions = _tensor("actions", ["batch", ACTION_SIZE])
    # Non-zero weights so the graph is sensitive to its input (an all-zero
    # readout legitimately fails any input-sensitivity gate).
    W = onnx.numpy_helper.from_array(
        np.full((OBSERVATION_SIZE, ACTION_SIZE), 0.01, dtype=np.float32), "W"
    )
    B = onnx.numpy_helper.from_array(np.zeros(ACTION_SIZE, dtype=np.float32), "B")
    gemm = onnx.helper.make_node("Gemm", ["obs", "W", "B"], ["actions"], name="readout")
    graph = onnx.helper.make_graph([gemm], "microduck-ff-actor", [obs], [actions], [W, B])
    model = onnx.helper.make_model(
        graph, opset_imports=[onnx.helper.make_opsetid("", 16)]
    )
    model.ir_version = 8
    onnx.checker.check_model(model)
    return model


def _reference_sequence(model_path, observations: list[np.ndarray]):
    """Hand-fed onnxruntime loop: the ground truth for state carry-over."""
    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    h = np.zeros((1, 1, HIDDEN), dtype=np.float32)
    c = np.zeros((1, 1, HIDDEN), dtype=np.float32)
    actions = []
    for obs in observations:
        out = session.run(
            ["actions", "h_out", "c_out"],
            {"obs": obs.reshape(1, -1).astype(np.float32), "h_in": h, "c_in": c},
        )
        actions.append(out[0].reshape(-1))
        h, c = out[1], out[2]
    return actions, h, c


def test_lstm_policy_matches_reference_and_reset(tmp_path):
    model_path = tmp_path / "lstm.onnx"
    onnx.save(build_lstm_graph(), model_path)
    policy = load_policy(model_path)

    assert policy.recurrent is True
    assert policy.facts() == {
        "recurrent": True,
        "stateInputs": ["h_in", "c_in"],
        "stateOutputs": ["h_out", "c_out"],
    }

    rng = np.random.default_rng(42)
    observations = [rng.normal(0, 0.3, OBSERVATION_SIZE).astype(np.float32) for _ in range(5)]
    # Episode 1: act step by step; must equal the hand-fed reference loop.
    ours = [policy.act(obs) for obs in observations]
    reference, h_ref, _ = _reference_sequence(model_path, observations)
    for ours_step, ref_step in zip(ours, reference):
        np.testing.assert_allclose(ours_step, ref_step, atol=1e-6)

    # reset() then one more step must match a fresh reference sequence.
    policy.reset()
    tail = rng.normal(0, 0.3, OBSERVATION_SIZE).astype(np.float32)
    after_reset = policy.act(tail)
    fresh, _, _ = _reference_sequence(model_path, [tail])
    np.testing.assert_allclose(after_reset, fresh[0], atol=1e-6)


def test_lstm_state_actually_carries(tmp_path):
    """Same observation, different history -> different action.

    Guards against a classification that pairs state names correctly but feeds
    zeros every step (the failure mode this whole module exists to prevent).
    """
    model_path = tmp_path / "lstm.onnx"
    onnx.save(build_lstm_graph(), model_path)
    policy = load_policy(model_path)
    obs = np.full(OBSERVATION_SIZE, 0.5, dtype=np.float32)

    first = policy.act(obs)
    second = policy.act(obs)  # fed with the state the first call produced
    reference, _, _ = _reference_sequence(model_path, [obs, obs])
    np.testing.assert_allclose(first, reference[0], atol=1e-6)
    np.testing.assert_allclose(second, reference[1], atol=1e-6)
    assert not np.allclose(first, second, atol=1e-6)


def test_feedforward_policy_still_loads(tmp_path):
    model_path = tmp_path / "ff.onnx"
    onnx.save(build_feedforward_graph(), model_path)
    policy = load_policy(model_path)
    assert policy.recurrent is False
    action = policy.act(np.zeros(OBSERVATION_SIZE, dtype=np.float32))
    assert action.shape == (ACTION_SIZE,)
    policy.reset()  # no-op for feed-forward, must not raise
