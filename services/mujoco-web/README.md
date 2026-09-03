# MuJoCo Web Playground

This is a small, isolated MuJoCo service for the production host. It exposes
fixed example models through a browser UI and a JSON API. It deliberately does
not accept arbitrary XML, Python, or shell commands from the network.

Run locally:

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
MUJOCO_GL=egl uvicorn app:app --host 127.0.0.1 --port 18100
```

The production deployment runs this directory as `mujoco-web.service` on
127.0.0.1:18100 and publishes it at `/mujoco/` through the existing HTTPS
virtual host.

## Microduck

The default `/mujoco/` entry redirects to the official browser-based
Microduck simulator at `/mujoco/microduck/`. It runs MuJoCo WebAssembly and
ONNX policies in the user's browser. The original fixed-model lab remains at
`/mujoco/lab/`.

The static release is built from the upstream Pollen Robotics simulator and
keeps its upstream model, policy, and attribution files. Upstream references
are recorded in `MICRODUCK-UPSTREAM.md`.

The production page may load `microduck-community-overlay.js` together with
`community/microduck-wechat.png`. The overlay keeps a branded community card on
the welcome page, then moves the same QR entry into a visible wall-style poster
after the simulation starts. The poster includes the RDK Studio/MicroDuck
community description and opens the full QR modal on click. The C control is
translated as "跟随视角" because it toggles the chase camera rather than a
physical camera device.

The keyboard legend is normalized by the overlay to match the runtime adapter:
Arrow keys or `W/A/S/D` move and turn, `Q/E` kick left/right, `R` toggles
sit/stand, `G` picks up from the ground, `C` toggles the chase view, `B`
quacks, `F` alternates the kick foot, `M` switches between feet and rollers,
and `Space` resets the simulation. The desktop legend uses the Chinese labels
“双足” and “滚轮” for the two locomotion modes.

## Browser trajectory recording

The simulator now includes a small `动作录制` panel after the entrance
sequence. Click `开始录制`, perform the motion, then click `停止` and
`导出 JSONL`. Each line contains the actual 61-dimensional observation, the
14-dimensional ONNX action, the 13-dimensional command (when exposed by the
runtime), the active policy mode, and a bounded base `qpos/qvel` snapshot. The
file format is `microduck-trajectory-v1` at the same 50 Hz control cadence as
the policy contract; it is suitable for replay/debugging, imitation-learning
preparation, and reward design. It is not a trained model by itself.

The recorder reads the upstream simulator's `window.rl` verification surface.
If an older static bundle does not expose `window.rl.buildObs` and
`window.rl.lastAction`, the panel stays disabled instead of silently saving
key presses as training data. The recorder is intentionally browser-local:
the exported file is under the user's control and no token or device command
is uploaded.

The upstream `microduck_rl` repository also has a separate desktop inference
recorder (`infer_policy.py --save-csv` / `--record`). That path records the
CPU MuJoCo rehearsal; the browser panel is the equivalent for the deployed
WASM/ONNX simulator.

For a downloaded upstream release, install the additive overlay once per
release (the production `current` directory is normally an atomic symlink):

```bash
MICRODUCK_STATIC_ROOT=/opt/microduck-web/current \
  python3 services/mujoco-web/install-microduck-overlay.py
sudo systemctl restart microduck-web
```

The installer copies the overlay and QR asset, then adds a versioned script tag
to the upstream `index.html`. It does not modify the simulator bundle. Run it
again after switching `/opt/microduck-web/current` to a new upstream release.
