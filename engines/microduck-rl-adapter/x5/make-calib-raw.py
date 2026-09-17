from pathlib import Path

import numpy as np

rng = np.random.default_rng(7)
n = 256
obs = np.zeros((n, 61), dtype=np.float32)
obs[:, 0:3] = rng.normal(0, 0.5, (n, 3))
g = rng.normal(0, 0.1, (n, 3))
obs[:, 3:6] = g / np.linalg.norm(g, axis=1, keepdims=True)
obs[:, 6:20] = rng.normal(0, 0.15, (n, 14))
obs[:, 20:34] = rng.normal(0, 1.0, (n, 14))
obs[:, 34:48] = rng.uniform(-1, 1, (n, 14))
obs[:, 48:51] = rng.uniform(-0.3, 0.5, (n, 3))
obs[:, 51:61] = rng.uniform(-0.3, 0.3, (n, 10))

out = Path("/root/bpu-compile/calib_raw")
out.mkdir(parents=True, exist_ok=True)
for index in range(n):
    # The toolchain reads calibration samples with numpy.fromfile: raw float32
    # bytes shaped like input_shape (1x61), never a .npy container.
    obs[index].astype(np.float32).tofile(out / f"sample_{index:04d}.bin")
print("wrote", len(list(out.glob('*.bin'))), "raw samples,", (out / 'sample_0000.bin').stat().st_size, "bytes each")
