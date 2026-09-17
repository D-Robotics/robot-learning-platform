"""Export a trained MicroDuck checkpoint at a vendor-acceptable ONNX opset.

The browser simulator loads whatever `scripts/export.py` produces (opset 18 is
fine there), but the X5 toolchain's front end refuses anything above opset 11:
    ERROR *** ERROR-OCCUR-DURING {horizon_nn.build_onnx} ***,
    The opset version of the model is 18, the maximum supported version is 11.
`onnx.version_converter` cannot downgrade this graph either (no adapter for Sub
from v14), so the only correct route is to re-run torch's exporter with
opset_version=11 on the same policy object. Upstream keeps that call inside
mjlab's `MjlabOnPolicyRunner.export_policy_to_onnx`, so this script reuses the
exporter's own environment construction and patches the module's opset for the
duration of one call.
"""

from __future__ import annotations

import argparse
from dataclasses import asdict

import torch

from mjlab.rl import MjlabOnPolicyRunner, RslRlVecEnvWrapper
from mjlab.envs import ManagerBasedRlEnv
from mjlab.tasks.registry import load_env_cfg, load_rl_cfg, load_runner_cls
from mjlab.utils.torch import configure_torch_backends


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("task_id")
    parser.add_argument("--checkpoint-file", required=True)
    parser.add_argument("--onnx-file", required=True)
    parser.add_argument("--device", default=None)
    args = parser.parse_args()

    configure_torch_backends()
    device = args.device or ("cuda:0" if torch.cuda.is_available() else "cpu")
    env_cfg = load_env_cfg(args.task_id, play=True)
    agent_cfg = load_rl_cfg(args.task_id)
    env = ManagerBasedRlEnv(cfg=env_cfg, device=device)
    wrapped = RslRlVecEnvWrapper(env, clip_actions=agent_cfg.clip_actions)
    runner_cls = load_runner_cls(args.task_id) or MjlabOnPolicyRunner
    runner = runner_cls(wrapped, asdict(agent_cfg), device=device)
    runner.load(args.checkpoint_file, map_location=device)

    original = MjlabOnPolicyRunner.export_policy_to_onnx

    def patched(self, path, filename="policy.onnx", verbose=False):
        import os

        import torch as _torch

        onnx_model = self.alg.get_policy().as_onnx(verbose=verbose)
        onnx_model.to("cpu")
        onnx_model.eval()
        os.makedirs(path, exist_ok=True)
        _torch.onnx.export(
            onnx_model,
            onnx_model.get_dummy_inputs(),
            os.path.join(path, filename),
            export_params=True,
            opset_version=11,
            verbose=verbose,
            input_names=onnx_model.input_names,
            output_names=onnx_model.output_names,
            dynamic_axes={},
            dynamo=False,
        )

    import os

    target = os.path.abspath(args.onnx_file)
    MjlabOnPolicyRunner.export_policy_to_onnx = patched
    try:
        runner.export_policy_to_onnx(os.path.dirname(target), filename=os.path.basename(target))
    finally:
        MjlabOnPolicyRunner.export_policy_to_onnx = original
    print("wrote", target, os.path.getsize(target), "bytes")


if __name__ == "__main__":
    main()
