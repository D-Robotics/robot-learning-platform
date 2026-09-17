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

#### Deployer model registry (optional extra models)

The service ships with the reviewed builtin models (cartpole,
double-pendulum, originbot). Deployers can add their **own reviewed MJCF
models** without touching code: drop a `<key>.json` entry into
`services/mujoco-web/registry/` following the contract in
`registry/README.md` (a minimal `example-model.json.example` sits beside it
and is never loaded). Entries arrive through your config management, not
through a network upload — the directory itself is the reviewed whitelist.

Every entry is shape-validated **and compiled with real MuJoCo at service
startup**; an invalid entry (bad MJCF, actuator-count mismatch with
`actuator_names`, a key colliding with a builtin) makes the process refuse
to start instead of serving a broken model. The registry is read **once at
startup** — there is no hot reload, by design: after adding or editing an
entry, restart the service (dev: restart uvicorn; production: `systemctl
restart mujoco-web.service`) so the fail-closed compile checks run again.
Valid entries appear in
`/api/models` and the browser model dropdown automatically, labeled
`source: "registry"` (builtin models answer `source: "builtin"`). CI covers
the same checks through `npm run verify:mujoco-models` (SKIP without
mujoco).

Because the production release is a copy under `/opt/mujoco-web/current`,
deploy the registry with the release — `sudo cp -a` of the checkout already
carries `registry/`; afterwards `systemctl restart mujoco-web.service` and
verify with `curl http://127.0.0.1:18100/api/models`.

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

每个会话最多闲置 30 分钟；显式 DELETE、访问过期会话和后台 janitor 都会回收模型和 EGL
渲染器，因此即使没有新的创建请求，崩溃/挂起的浏览器也不会一直占用资源。`/healthz`
会返回当前 active/capacity、TTL 和 janitor 间隔，便于监控资源水位。
客户端结束页面或切换模型时应调用 `DELETE /api/sessions/{id}`，该接口会立即释放会话
资源并返回 `{"ok":true,"closed":true}`。浏览器页面已使用 `keepalive` 发送这个请求，
但它只是尽力而为，服务端 TTL 仍是最终兜底。过期或已删除的会话统一返回 404，不会因为
一次状态轮询而重新激活。
`GET /api/sessions/{id}/state` 也显式返回 `Cache-Control: no-store`，策略循环不会从
浏览器或反向代理读到旧的传感器状态。

### OriginBot differential-drive contract

`POST /api/sessions` with `{"model":"originbot","seed":7,"domain_randomization":true}`
creates the reviewed OriginBot MJCF scene. The response carries the effective seed,
episode randomization parameters, actuator limits, a 20 Hz `controlPeriod`, and the
sensor contract. If randomization is enabled without a seed, the service mints and
returns one so the run can be reproduced.

`POST /api/sessions/{id}/cmd_vel` accepts bounded `linear` (m/s) and `angular`
(rad/s) fields. It converts them to left/right wheel rad/s using the 90 mm wheel and
500 mm track calibration, applies both the robot and MJCF limits, advances one 50 ms
control period (five 10 ms physics steps), and returns the requested/applied wheel
speeds, requested/applied `linear` and `angular` values, plus actuator torque
feedback. On the high-level `cmd_vel` path, `linear`/`angular` remain the
requested command for compatibility; `appliedLinear`/`appliedAngular` are the
twist implied by the bounded wheel speeds. The low-level `step` path reports
the applied control in both pairs. The browser reference loop is 20 Hz; the
X5 board profile currently publishes `/cmd_vel` at 10 Hz, so a policy exporter
must use the returned `controlHz`/`controlPeriod` fields (and resample its
trajectory explicitly) instead of assuming the preview cadence is the board
cadence. The state also exposes body-frame odometry,
IMU quaternion/gyro/accelerometer values, a 19-beam forward scan, and raw named
MuJoCo sensor values. `sensors.scan` stays a flat array for existing clients;
`sensors.scanMeta` adds the beam `count`, angles, validity, saturation, and raw returns.

The RGB preview is `frame.jpg`. `depth.jpg` is an 8-bit normalized preview, while
`depth.png` is the metric unsigned-16-bit millimetre frame (`0` means invalid),
with matching `X-Depth-*` headers. Both endpoints are cache-free so a browser or
recorder cannot replay an old frame.
The forward depth camera is pitched down 15 degrees toward the robot's +X
axis; rangefinder debug lines are removed from rendered RGB/depth pixels while
the numeric laser scan remains available in the state contract.

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

## Loading a trained policy into the browser duck

The same overlay adds a `策略装载` panel: it lists the account's completed local
training runs that carry a digest-verified ONNX artifact, and hands the chosen
run to the simulator's own move loader (`window.rl.loadCustomPolicy`). The
platform contributes no policy maths — upstream already validates that the graph
takes the robot's 61D observation and emits 14 actions, installs it in the walk
slot, and reverts to the stock policy with a reason when a custom move
misbehaves. The panel surfaces that reason verbatim.

Server side, this needs two things that are easy to miss:

- `GET /api/sim2real/runs/:id/policy.onnx` serves the bytes and carries
  `Access-Control-Allow-Origin: *`, because upstream's loader accepts only
  absolute `http(s)://...onnx` URLs and a deployment may mount the simulator on
  its own origin. The route is still gated on run ownership, terminal status,
  non-mock provenance and a digest match; it exposes no credential and no
  telemetry.
- The artifact fetch resolves the run's **compute resource** and fails closed
  when that resource's health lease has expired (default 600 s). Re-run
  `测试连接` in the workbench when the panel reports the artifact is
  unavailable — the lease is a freshness check, not a permanent grant.

A deployment that publishes the simulator only as a redirect to an external
build (no mounted static bundle) cannot show this panel at all: the overlay
never loads. Point `RDK_SIM2REAL_MICRODUCK_ROOT` at a reviewed local release and
install the overlay below to get it.

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
