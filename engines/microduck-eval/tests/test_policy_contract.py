"""Policy-graph classification and recurrent state semantics, no onnxruntime.

``classify_graph`` and ``Policy.act``/``reset`` are the pure contract surfaces;
fakes stand in for onnxruntime's session and IO metadata (``.name``/``.shape``
are all the real code touches).
"""

from __future__ import annotations

import numpy as np
import pytest

from microduck_eval.policy import (
    OBSERVATION_SIZE,
    ACTION_SIZE,
    Policy,
    PolicyContractError,
    classify_graph,
)


class IO:
    def __init__(self, name: str, shape: list):
        self.name = name
        self.shape = shape


class FakeSession:
    """Echoes the action, updates state deterministically for assertions."""

    def __init__(self, state_shape=(256,)):
        self.state_shape = state_shape
        self.runs: list[dict] = []

    def run(self, wanted, feeds):
        self.runs.append({"wanted": list(wanted), "feeds": dict(feeds)})
        outputs = [np.full((1, ACTION_SIZE), 0.5, dtype=np.float32)]
        for name in wanted[1:]:
            outputs.append(np.arange(1, np.prod(self.state_shape) + 1,
                                     dtype=np.float32).reshape(self.state_shape))
        return outputs


def _feedforward_fields():
    return classify_graph(
        [IO("obs", ["batch", OBSERVATION_SIZE])],
        [IO("actions", ["batch", ACTION_SIZE])],
    )


def _lstm_fields():
    return classify_graph(
        [
            IO("obs", ["batch", OBSERVATION_SIZE]),
            IO("h_in", ["batch", 256]),
            IO("c_in", ["batch", 256]),
        ],
        [
            IO("actions", ["batch", ACTION_SIZE]),
            IO("h_out", ["batch", 256]),
            IO("c_out", ["batch", 256]),
        ],
    )


def test_feedforward_graph_classifies_with_no_state():
    fields = _feedforward_fields()
    assert fields["input_name"] == "obs"
    assert fields["output_name"] == "actions"
    assert fields["recurrent"] is False
    assert fields["state_input_names"] == ()
    assert fields["state_shapes"] == []


def test_lstm_graph_pairs_state_by_name_and_size():
    fields = _lstm_fields()
    assert fields["input_name"] == "obs"
    assert fields["output_name"] == "actions"
    assert fields["recurrent"] is True
    assert fields["state_input_names"] == ("h_in", "c_in")
    assert fields["state_output_names"] == ("h_out", "c_out")
    assert fields["state_shapes"] == [(1, 256), (1, 256)]


def test_initial_state_suffix_pairs_with_plain_input_name():
    fields = classify_graph(
        [IO("obs", [None, 61]), IO("hidden", [None, 128])],
        [IO("actions", [None, 14]), IO("initial_hidden_out", [None, 128])],
    )
    assert fields["state_input_names"] == ("hidden",)
    assert fields["state_output_names"] == ("initial_hidden_out",)


def test_state_on_one_side_only_is_rejected():
    with pytest.raises(PolicyContractError, match="state on only one side"):
        classify_graph(
            [IO("obs", [1, 61]), IO("h_in", [1, 256])],
            [IO("actions", [1, 14])],
        )
    with pytest.raises(PolicyContractError, match="state on only one side"):
        classify_graph(
            [IO("obs", [1, 61])],
            [IO("actions", [1, 14]), IO("h_out", [1, 256])],
        )


def test_two_observations_is_rejected():
    with pytest.raises(PolicyContractError, match="exactly one input of size 61"):
        classify_graph(
            [IO("obs", [1, 61]), IO("obs2", [1, 61])],
            [IO("actions", [1, 14])],
        )


def test_no_action_output_is_rejected():
    with pytest.raises(PolicyContractError, match="exactly one output of size 14"):
        classify_graph([IO("obs", [1, 61])], [IO("scores", [1, 32])])


def test_ambiguous_size_pairing_is_rejected():
    # Two state outputs of the SAME size but only one matches by name: the
    # leftover cannot be paired unambiguously, so the graph is refused.
    with pytest.raises(PolicyContractError, match="cannot pair state output"):
        classify_graph(
            [IO("obs", [1, 61]), IO("h_in", [1, 256])],
            [
                IO("actions", [1, 14]),
                IO("h_out", [1, 256]),
                IO("mystery", [1, 256]),
            ],
        )


def test_symbolic_batch_dim_is_not_treated_as_a_number():
    # Dynamic axes arrive as strings; they must not be multiplied into the size.
    fields = classify_graph(
        [IO("obs", ["batch", 61]), IO("h_in", ["batch", 256])],
        [IO("actions", ["batch", 14]), IO("h_out", ["batch", 256])],
    )
    assert fields["state_shapes"] == [(1, 256)]


def _lstm_policy(session):
    return Policy(
        session=session,
        input_name="obs",
        output_name="actions",
        observation_size=OBSERVATION_SIZE,
        action_size=ACTION_SIZE,
        path="fake.onnx",
        sha256="0" * 64,
        state_input_names=("h_in", "c_in"),
        state_output_names=("h_out", "c_out"),
        state=[np.zeros((256,), dtype=np.float32), np.zeros((256,), dtype=np.float32)],
        recurrent=True,
    )


def test_act_carries_state_between_calls_and_reset_zeroes_it():
    session = FakeSession()
    policy = _lstm_policy(session)
    observation = np.zeros(OBSERVATION_SIZE, dtype=np.float32)

    first = policy.act(observation)
    second = policy.act(observation)

    assert first.shape == (ACTION_SIZE,)
    # The second call must feed the state the first call produced, not zeros.
    fed_h = session.runs[1]["feeds"]["h_in"]
    assert fed_h[0] == pytest.approx(1.0)
    assert policy.state[0][0] == pytest.approx(1.0)
    assert len(session.runs) == 2
    assert session.runs[0]["wanted"] == ["actions", "h_out", "c_out"]

    policy.reset()
    assert np.all(policy.state[0] == 0.0)
    third = policy.act(observation)
    assert session.runs[2]["feeds"]["h_in"][0] == pytest.approx(0.0)
    assert third.shape == (ACTION_SIZE,)


def test_reset_returns_independent_copies():
    policy = _lstm_policy(FakeSession())
    observation = np.zeros(OBSERVATION_SIZE, dtype=np.float32)
    policy.act(observation)
    stored = policy.state[0]
    policy.reset()
    stored[:] = 9.0  # mutate the old reference: the new state must not see it
    assert policy.state[0][0] == 0.0


class DivergingStateSession(FakeSession):
    def run(self, wanted, feeds):
        outputs = [np.zeros((1, ACTION_SIZE), dtype=np.float32)]
        outputs.append(np.full(self.state_shape, np.nan, dtype=np.float32))
        return outputs


def test_diverging_state_fails_loudly():
    policy = _lstm_policy(DivergingStateSession())
    observation = np.zeros(OBSERVATION_SIZE, dtype=np.float32)
    with pytest.raises(PolicyContractError, match="non-finite"):
        policy.act(observation)
    # The NaN never becomes the carried state: the episode fails instead of
    # continuing from poisoned history.
    assert np.all(np.isfinite(policy.state[0]))


def test_facts_report_the_recurrence():
    assert _lstm_policy(FakeSession()).facts() == {
        "recurrent": True,
        "stateInputs": ["h_in", "c_in"],
        "stateOutputs": ["h_out", "c_out"],
    }
