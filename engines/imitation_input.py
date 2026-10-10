"""Digest-pinned worker input shared by the ACT and Diffusion engines."""
import hashlib
import json
import pathlib


def load_engine_demonstrations(request, loader, synthetic_factory, obs_size, act_size):
    training = request.get("training") or {}
    data = request.get("demonstrations")
    if training.get("syntheticSmoke") is True:
        if training.get("profile") != "smoke" or data or training.get("demonstrationRunId"):
            raise ValueError("syntheticSmoke requires smoke and cannot replace demonstrations")
        episodes = synthetic_factory(obs_size, act_size, episodes=8, steps=48, seed=0)
        return episodes, {"source": "synthetic-smoke", "synthetic": True}
    if not isinstance(data, dict) or data.get("sourceRunId") != training.get("demonstrationRunId"):
        raise ValueError("recorded demonstrations required; synthetic data must be explicitly requested")
    if any(slot.get("modality") == "image" for slot in (request.get("contract") or {}).get("observationLayout", [])):
        raise ValueError("recorded worker training supports vector observations; use the image CLI explicitly")
    # The worker materializes exactly this fixed filename in its private job
    # directory. No request path, URL, or shell fragment is ever interpreted.
    path = pathlib.Path("demonstrations.jsonl")
    with path.open("rb") as handle:
        raw = handle.read(512 * 1024 + 1)
    if len(raw) > 512 * 1024:
        raise ValueError("demonstrations exceed the 512 KiB input budget")
    digest = hashlib.sha256(raw).hexdigest()
    if digest != data.get("sha256") or (training.get("demonstrationSha256") and training["demonstrationSha256"] != digest):
        raise ValueError("demonstration SHA-256 mismatch")
    loaded = loader(path)
    episodes, actual_obs, actual_act = loaded[:3]
    if actual_obs != obs_size or actual_act != act_size:
        raise ValueError("demonstration observation/action dimensions differ from the model contract")
    rows = sum(len(ep[0]) for ep in episodes)
    boundaries = sum(json.loads(line).get("done") is True for line in raw.decode("utf-8").splitlines() if line.strip())
    if boundaries != len(episodes):
        raise ValueError("every demonstration episode must end with an explicit done marker")
    if rows > 20_000 or len(episodes) < 8 or any(len(ep[0]) < 4 for ep in episodes):
        raise ValueError("demonstrations need at least 8 episodes, each with at least 4 steps")
    if data.get("sampleCount") != rows or data.get("episodeCount") != len(episodes):
        raise ValueError("demonstration sample/episode counts differ from the pinned input")
    return episodes, {"source": "recorded-trajectory", "synthetic": False,
                      "sourceRunId": data["sourceRunId"], "sha256": digest}
