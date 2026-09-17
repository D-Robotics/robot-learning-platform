"""ONNX policy loading and the observation contract it expects.

Two graph shapes are accepted, and nothing else:

* **feed-forward** — exactly one input (``[*, 61]``) and one output
  (``[*, 14]``). The upstream exporter (``export.py``) bakes the observation
  normalizer into the graph, so the 14 joint offsets are final.
* **recurrent** (e.g. an LSTM actor) — one observation input plus one or more
  *state inputs*, and one action output plus matching *state outputs*. State
  is carried between ``act`` calls within an episode and zeroed by ``reset()``
  at the start of each episode; a rollout that forgets to reset turns the
  state into history from the previous episode and silently measures the
  wrong thing, so :func:`microduck_eval.sim.rollout` calls ``reset()`` itself.

Everything ambiguous fails closed with a message that names the graph, because
a mis-fed recurrent policy produces plausible-looking actions, not errors.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

OBSERVATION_SIZE = 61
ACTION_SIZE = 14


class PolicyContractError(RuntimeError):
    """Raised when a policy's graph does not match the MicroDuck contract."""


def _dim_of(shape: object) -> int | None:
    """Product of the non-batch dims, or None when a dim is symbolic.

    onnxruntime reports dynamic axes as strings (``'batch'``, ``'seq'``); those
    count as "unknown size", not as a number to multiply.
    """
    total = 1
    for dim in shape[1:]:
        try:
            value = int(dim)
        except (TypeError, ValueError):
            return None
        total *= value
    return total


def _last_dim(shape: object) -> int | None:
    try:
        return int(shape[-1])
    except (TypeError, ValueError, IndexError):
        return None


def _state_shape(shape: object) -> tuple[int, ...]:
    """The full declared shape of a state tensor, symbolic dims as 1.

    Recurrent state is not always rank-2: an ONNX LSTM initial state is
    ``[num_directions, batch, hidden]``, which is what mjlab/rsl-rl exports
    declare. Collapsing it to a flat product would feed a wrong-shaped tensor
    and fail at inference time. Evaluation runs one environment, so every
    symbolic dimension is 1.
    """
    dims: list[int] = []
    for dim in shape:
        try:
            dims.append(int(dim))
        except (TypeError, ValueError):
            dims.append(1)
    return tuple(dims)


def _describe(entries: list) -> str:
    return ", ".join(
        "{}{}".format(entry.name, tuple(entry.shape) if hasattr(entry, "shape") else "?")
        for entry in entries
    )


@dataclass
class Policy:
    """A loaded policy. Feed-forward and recurrent share this interface."""

    session: object
    input_name: str
    output_name: str
    observation_size: int
    action_size: int
    path: str
    sha256: str
    #: State input names in feed order, paired 1:1 with ``state_output_names``.
    state_input_names: tuple[str, ...] = ()
    state_output_names: tuple[str, ...] = ()
    #: One zero-filled array per state input; reused across ``act`` calls.
    state: list[np.ndarray] = field(default_factory=list, repr=False)
    recurrent: bool = False

    # ---- episode-scoped state -------------------------------------------
    def reset(self) -> None:
        """Zero the recurrent state. Called once per episode by ``rollout``."""
        self.state = [np.zeros_like(value) for value in self.state]

    # ---- inference -------------------------------------------------------
    def act(self, observation: np.ndarray) -> np.ndarray:
        if observation.shape != (self.observation_size,):
            raise PolicyContractError(
                f"observation must be ({self.observation_size},), got {observation.shape}"
            )
        batch = observation.reshape(1, -1).astype(np.float32)
        feeds: dict[str, np.ndarray] = {self.input_name: batch}
        for name, value in zip(self.state_input_names, self.state):
            feeds[name] = np.asarray(value, dtype=np.float32)
        wanted = [self.output_name, *self.state_output_names]
        outputs = self.session.run(wanted, feeds)  # type: ignore[attr-defined]
        action = np.asarray(outputs[0], dtype=np.float32).reshape(-1)
        if action.shape != (self.action_size,):
            raise PolicyContractError(
                f"policy returned {action.shape}, expected ({self.action_size},)"
            )
        if not np.all(np.isfinite(action)):
            raise PolicyContractError("policy returned a non-finite action")
        # The carried state is only replaced once every state output has the
        # expected shape and finite values: a diverging recurrent state must
        # fail this episode loudly, not silently continue from stale history.
        new_state: list[np.ndarray] = []
        for index, name in enumerate(self.state_output_names):
            value = np.asarray(outputs[1 + index], dtype=np.float32)
            if value.shape != self.state[index].shape:
                raise PolicyContractError(
                    f"state output {name!r} returned {value.shape}, expected "
                    f"{self.state[index].shape}"
                )
            if not np.all(np.isfinite(value)):
                raise PolicyContractError(
                    f"state output {name!r} became non-finite during the episode; "
                    "the recurrent state diverged"
                )
            new_state.append(value.astype(np.float32, copy=True))
        if new_state:
            self.state = new_state
        return action

    def facts(self) -> dict[str, object]:
        """What the report must state for the policy to be reproducible."""
        return {
            "recurrent": self.recurrent,
            "stateInputs": list(self.state_input_names),
            "stateOutputs": list(self.state_output_names),
        }


def _sha256(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _pair_state_inputs(inputs: list, outputs: list) -> list[tuple[str, str]]:
    """Pair state outputs with the state inputs they feed.

    Pairing is by name first (the exporter names both sides, possibly with an
    ``_in``/``_out``-style suffix), then by size+order. Ambiguity — two
    candidates of the same size, or an output with no candidate at all — is a
    contract error, because guessing here feeds the wrong tensor as history.
    """
    pairs: list[tuple[str, str]] = []
    consumed_inputs: list = []
    unmatched_outputs: list = list(outputs)
    for state_in in inputs:
        candidates = [
            state_out
            for state_out in unmatched_outputs
            if state_out.name == state_in.name
            or state_out.name.replace("_out", "").rstrip("s")
            == state_in.name.replace("_in", "").replace("initial_", "").rstrip("s")
            or state_out.name.replace("initial_", "") == state_in.name
        ]
        if len(candidates) > 1:
            raise PolicyContractError(
                f"state input {state_in.name!r} matches multiple outputs: {_describe(candidates)}"
            )
        if candidates:
            pairs.append((state_in.name, candidates[0].name))
            unmatched_outputs.remove(candidates[0])
            consumed_inputs.append(state_in)
    if unmatched_outputs:
        # Name pairing left outputs over: retry by size, consuming in order.
        # Only inputs the name pass did not consume are candidates — a paired
        # input claiming a second, same-size output ("h_out" plus a stray
        # "mystery") is ambiguous, not a match.
        remaining_inputs = [item for item in inputs if item not in consumed_inputs]
        for state_out in list(unmatched_outputs):
            size = _dim_of(state_out.shape) or _last_dim(state_out.shape)
            same_size = [item for item in remaining_inputs if _dim_of(item.shape) == size]
            if len(same_size) != 1:
                raise PolicyContractError(
                    f"cannot pair state output {state_out.name!r} with an input "
                    f"(candidates by size: {_describe(same_size)})"
                )
            pairs.append((same_size[0].name, state_out.name))
            consumed_inputs.append(same_size[0])
            remaining_inputs.remove(same_size[0])
            unmatched_outputs.remove(state_out)
    return pairs


def classify_graph(inputs: list, outputs: list) -> dict[str, object]:
    """Split a graph's inputs/outputs into obs/action/state. Pure and testable.

    Returns the fields ``Policy`` needs; raises on anything ambiguous. The
    rule for which input is the observation: the one whose non-batch size is
    61. The action output is the one whose non-batch size is 14. Everything
    else must pair up as state.
    """
    if not inputs or not outputs:
        raise PolicyContractError(
            f"graph has no inputs or no outputs (inputs={_describe(inputs)}, "
            f"outputs={_describe(outputs)})"
        )
    obs_inputs = [item for item in inputs if _dim_of(item.shape) == OBSERVATION_SIZE]
    if len(obs_inputs) != 1:
        raise PolicyContractError(
            f"expected exactly one input of size {OBSERVATION_SIZE}, got "
            f"{len(obs_inputs)}: {_describe(inputs)}"
        )
    action_outputs = [item for item in outputs if _dim_of(item.shape) == ACTION_SIZE]
    if len(action_outputs) != 1:
        raise PolicyContractError(
            f"expected exactly one output of size {ACTION_SIZE}, got "
            f"{len(action_outputs)}: {_describe(outputs)}"
        )
    state_inputs = [item for item in inputs if item is not obs_inputs[0]]
    state_outputs = [item for item in outputs if item is not action_outputs[0]]
    pairs: list[tuple[str, str]] = []
    state_shapes: list[tuple[int, ...]] = []
    if state_inputs or state_outputs:
        if not (state_inputs and state_outputs):
            raise PolicyContractError(
                f"graph has state on only one side (inputs: {_describe(state_inputs)}, "
                f"outputs: {_describe(state_outputs)})"
            )
        pairs = _pair_state_inputs(state_inputs, state_outputs)
        state_shapes = [_state_shape(item.shape) for item in state_inputs]
    return {
        "input_name": obs_inputs[0].name,
        "output_name": action_outputs[0].name,
        "state_input_names": tuple(name for name, _ in pairs),
        "state_output_names": tuple(name for _, name in pairs),
        "state_shapes": state_shapes,
        "recurrent": bool(pairs),
    }


def _initial_state(shapes: list[tuple[int, ...]]) -> list[np.ndarray]:
    return [np.zeros(shape, dtype=np.float32) for shape in shapes]


def load_policy(path: str | Path) -> Policy:
    import onnxruntime as ort

    file_path = Path(path)
    if not file_path.is_file():
        raise FileNotFoundError(f"policy not found: {file_path}")
    session = ort.InferenceSession(str(file_path), providers=["CPUExecutionProvider"])
    fields = classify_graph(session.get_inputs(), session.get_outputs())
    shapes = fields["state_shapes"]  # type: ignore[assignment]
    return Policy(
        session=session,
        input_name=fields["input_name"],  # type: ignore[arg-type]
        output_name=fields["output_name"],  # type: ignore[arg-type]
        observation_size=OBSERVATION_SIZE,
        action_size=ACTION_SIZE,
        path=str(file_path),
        sha256=_sha256(file_path),
        state_input_names=fields["state_input_names"],  # type: ignore[arg-type]
        state_output_names=fields["state_output_names"],  # type: ignore[arg-type]
        state=_initial_state(shapes),  # type: ignore[arg-type]
        recurrent=fields["recurrent"],  # type: ignore[arg-type]
    )
