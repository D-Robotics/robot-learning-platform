# GPU worker deployment

The supported production path is the existing `local-training-worker.mjs`
with `engines/mjlab-rsl-rl-adapter/adapter.py`. Install CUDA PyTorch,
`rsl-rl`, MuJoCo and `mjlab` on the GPU host, then configure:

```bash
RDK_SIM2REAL_TRAIN_EXECUTABLE=/usr/bin/python3
RDK_SIM2REAL_TRAIN_ARGS_JSON='["/opt/rdk/engines/mjlab-rsl-rl-adapter/adapter.py"]'
RDK_SIM2REAL_LOCAL_RUNNER_URL=http://gpu-host:19091/train
```

The adapter refuses a missing MJLab environment instead of silently claiming
contact-dynamics training; its fallback is explicitly labelled kinematic.
