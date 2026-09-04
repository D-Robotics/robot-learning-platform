# MuJoCo Web Playground

This is a small, isolated MuJoCo service for the production host. It exposes
fixed example models through a browser UI and a JSON API. It deliberately does
not accept arbitrary XML, Python, or shell commands from the network.

Run locally:

```bash
cd /path/to/robot-learning-platform
set -euo pipefail
python3.11 -m venv services/mujoco-web/.venv
. services/mujoco-web/.venv/bin/activate
pip install -r services/mujoco-web/requirements.txt
MUJOCO_GL=egl uvicorn --app-dir services/mujoco-web app:app --host 127.0.0.1 --port 18100
```

The production deployment runs this directory as `mujoco-web.service` on
127.0.0.1:18100 and publishes it at `/mujoco/` through the existing HTTPS
virtual host.

### Production provisioning

The Python MuJoCo lab and the browser-only MicroDuck static service are
independent units. The unit files intentionally use fixed, root-owned paths
so a release switch does not mutate the source checkout. Run the relevant
bootstrap below from a reviewed checkout/release directory.

#### Optional Python MuJoCo lab (18100)

```bash
set -euo pipefail
if ! id -u mujoco >/dev/null 2>&1; then
  sudo useradd --system --home /var/lib/mujoco-web --shell /usr/sbin/nologin mujoco
fi
release_id="$(git rev-parse --verify HEAD)"
release=/opt/mujoco-web/releases/"$release_id"
sudo install -d -o root -g root -m 0755 "$release"
sudo install -d -o root -g root -m 0755 /opt/mujoco-web/venv
sudo cp -a services/mujoco-web/. "$release/"
sudo chown -R root:root "$release"
current=/opt/mujoco-web/current
if [ -e "$current" ] && [ ! -L "$current" ]; then
  echo "refusing to replace non-symlink $current; migrate it manually" >&2
  exit 1
fi
sudo ln -sfnT "$release" "$current"
sudo python3.11 -m venv /opt/mujoco-web/venv
sudo /opt/mujoco-web/venv/bin/pip install --requirement \
  /opt/mujoco-web/current/requirements.txt
sudo install -o root -g root -m 0644 services/mujoco-web/mujoco-web.service \
  /etc/systemd/system/mujoco-web.service
sudo systemctl daemon-reload
sudo systemctl enable --now mujoco-web.service
for attempt in $(seq 1 30); do
  curl -fsS http://127.0.0.1:18100/healthz > /dev/null && break
  sleep 1
done
curl -fsS http://127.0.0.1:18100/healthz
```

If the deployment only needs the browser simulator, skip this Python block;
the `mujoco` user, virtualenv, and `mujoco-web.service` are not required.

#### Browser MicroDuck static service (18101)

`microduck-web.service` is needed when the reviewed MicroDuck static release
is hosted locally. Create its service user, copy the upstream release into a
versioned directory and switch the `/opt/microduck-web/current` symlink, then
install the additive overlay and enable the unit:

```bash
set -euo pipefail
if ! id -u microduck >/dev/null 2>&1; then
  sudo useradd --system --home /var/lib/microduck-web --shell /usr/sbin/nologin microduck
fi
# The release root must contain index.html. Acquire it through the approved
# upstream/release process, verify its checksum as described in
# MICRODUCK-UPSTREAM.md, then copy it into a versioned root.
MICRODUCK_RELEASE_DIR=/srv/releases/microduck-simulator-approved
test -s "$MICRODUCK_RELEASE_DIR/index.html"
: "${MICRODUCK_RELEASE_ID:?set an approved release id, for example 1261013e7e28}"
case "$MICRODUCK_RELEASE_ID" in
  *[!A-Za-z0-9._-]*) echo "invalid MICRODUCK_RELEASE_ID" >&2; exit 1 ;;
esac
release=/opt/microduck-web/releases/"$MICRODUCK_RELEASE_ID"
sudo install -d -o root -g root -m 0755 "$release"
sudo cp -a "$MICRODUCK_RELEASE_DIR/." "$release/"
sudo chown -R root:root "$release"
current=/opt/microduck-web/current
if [ -e "$current" ] && [ ! -L "$current" ]; then
  echo "refusing to replace non-symlink $current; migrate it manually" >&2
  exit 1
fi
sudo ln -sfnT "$release" "$current"
sudo env MICRODUCK_STATIC_ROOT="$current" \
  python3 services/mujoco-web/install-microduck-overlay.py
sudo install -o root -g root -m 0644 services/mujoco-web/microduck-web.service \
  /etc/systemd/system/microduck-web.service
sudo systemctl daemon-reload
sudo systemctl enable --now microduck-web.service
test -s /opt/microduck-web/current/index.html
for attempt in $(seq 1 30); do
  curl -fsS -o /dev/null http://127.0.0.1:18101/index.html && break
  sleep 1
done
curl -fsS -o /dev/null http://127.0.0.1:18101/index.html
```

The `mujoco` service needs a real Linux Python 3.11 environment and the
`mujoco` wheel's headless rendering dependencies; a browser-only MicroDuck
deployment can omit `mujoco-web.service` and use only the static service.
After updating either `current` directory, run `systemctl restart` for the
corresponding unit; `enable --now` alone does not reload an already-running
process.

If the HTTPS virtual host has not yet received a MuJoCo route, install the
safe, marker-based routes and validate Nginx before reloading it. Run the
base route first; the second installer adds the MicroDuck redirect and the
static asset location:

```bash
set -euo pipefail
sudo python3 services/mujoco-web/install-nginx-route.py
sudo python3 services/mujoco-web/install-microduck-nginx-route.py
sudo nginx -t && sudo systemctl reload nginx
```

这两个 installer 默认修改 `/etc/nginx/conf.d/rdkstudio-ssl.conf` 中的
`server_name rdkstudio.d-robotics.cc;` HTTPS server block；若发行版使用
`sites-enabled` 或其它域名，请设置 `RDK_SIM2REAL_NGINX_CONFIG=/绝对路径/your-server.conf`。
脚本只会在目标 server block 内验证端口和完整受管路由，发现旧配置不一致会停止并要求人工迁移。

If the browser-only deployment does not use the Python MuJoCo lab, the first
unit and its Python environment can be omitted; keep `microduck-web.service`
and the `/mujoco/microduck/` route.

`MUJOCO_GL=egl` is intended for a Linux/headless host. On macOS or a desktop
Linux session, omit it or use the platform's GLFW backend when running locally;
the browser MicroDuck static service does not require an EGL context.

Python MuJoCo API（`/api/sessions`、`/step`、`/reset` 和 JPEG frame）是公开示例接口，
本服务本身不提供 SSO、账号配额或公网限流。若要挂到互联网，必须在网关加认证、IP/账号
限流和会话配额，或只绑定内网；Nginx 反向代理本身不是认证边界。启用生产 unit 后应至少
实际验证一次 `POST /api/sessions`、`GET .../frame.jpg` 和 `POST .../step`，因为
`/healthz` 只证明 Python 进程活着，不证明 EGL/渲染设备可用。

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
sudo env MICRODUCK_STATIC_ROOT=/opt/microduck-web/current \
  python3 services/mujoco-web/install-microduck-overlay.py
sudo systemctl restart microduck-web.service
```

The installer copies the overlay and QR asset, then adds a versioned script tag
to the upstream `index.html`. It does not modify the simulator bundle. Run it
again after switching `/opt/microduck-web/current` to a new upstream release.
