"""Install a private, source-bound training Worker using an existing Studio SSH session."""
import base64
import fcntl
import json
import hashlib
import io
import platform
import tarfile
import shlex
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

MARKER = "RDK_WORKER_DEPLOYMENT="


def atomic_json(file, value):
    temporary = file.with_suffix(".tmp")
    with temporary.open("w") as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream)
    os.replace(temporary, file)


def read_health(port, token):
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/healthz", headers={"Authorization": "Bearer " + token}
    )
    with urllib.request.urlopen(request, timeout=3) as response:
        body = response.read(32769)
        if len(body) > 32768:
            raise ValueError("health-too-large")
        return json.loads(body)


def provision_node(root):
    existing = shutil.which("node")
    if existing:
        major = int(subprocess.check_output(
            [existing, "-p", "process.versions.node.split('.')[0]"], text=True, timeout=5).strip())
        if major in (22, 24) or major >= 26:
            return existing
    targets = {
        "x86_64": ("x64", "472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6"),
        "aarch64": ("arm64", "f3d5a797b5d210ce8e2cb265544c8e482eaedcb8aa409a8b46da7e8595d0dda0"),
    }
    if platform.system() != "Linux" or platform.machine() not in targets:
        raise ValueError("NODE_RUNTIME_UNSUPPORTED")
    arch, expected = targets[platform.machine()]
    folder = "node-v24.15.0-linux-" + arch
    url = "https://nodejs.org/dist/v24.15.0/" + folder + ".tar.xz"
    with urllib.request.urlopen(url, timeout=90) as response:
        data = response.read(100_000_001)
    if len(data) > 100_000_000 or hashlib.sha256(data).hexdigest() != expected:
        raise ValueError("NODE_RUNTIME_DIGEST_MISMATCH")
    destination = root / "node"
    destination.mkdir(exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:xz") as archive:
        for name in ("bin/node", "LICENSE"):
            member = archive.getmember(folder + "/" + name)
            if not member.isfile():
                raise ValueError("NODE_RUNTIME_INVALID_ARCHIVE")
            target = destination / name
            target.parent.mkdir(exist_ok=True)
            target.write_bytes(archive.extractfile(member).read())
    (destination / "bin/node").chmod(0o700)
    return str(destination / "bin/node")


def install_dependencies(root):
    python = root / "venv/bin/python"
    if not python.exists():
        subprocess.run([sys.executable, "-m", "venv", str(root / "venv")], check=True, timeout=90)
    subprocess.run(
        [str(python), "-m", "pip", "install", "--disable-pip-version-check",
         "--only-binary=:all:", "--index-url", "https://download.pytorch.org/whl/cpu",
         "torch==2.9.0"], check=True, timeout=1800
    )
    subprocess.run(
        [str(python), "-m", "pip", "install", "--disable-pip-version-check",
         "--only-binary=:all:", "numpy==2.0.2", "onnx==1.19.1", "onnxscript==0.7.2"],
        check=True, timeout=900
    )
    return python


def install(root, config):
    os.umask(0o077)
    lock = (root / "install.lock").open("a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    state = root / "state.json"
    if state.exists():
        previous = json.loads(state.read_text())
        if previous.get("state") in ("ready", "failed"):
            return
    atomic_json(state, {"state": "installing"})
    try:
        if not shutil.which("openssl"):
            raise ValueError("OPENSSL_REQUIRED")
        node = provision_node(root)
        with socket.socket() as probe:
            probe.bind((config.get("host", "127.0.0.1"), config["port"]))
        python = install_dependencies(root)
        subprocess.run([str(python), "-c", "import torch,numpy,onnx,onnxscript"], check=True, timeout=30)
        token = secrets.token_urlsafe(48)
        atomic_json(root / "worker-secret.json", {"token": token})
        env = {**{key: value for key, value in os.environ.items() if key in ("PATH", "HOME", "LANG", "TMPDIR", "LD_LIBRARY_PATH")},
               "RDK_SIM2REAL_LOCAL_WORKER_HOST": config.get("host", "127.0.0.1"),
               "RDK_SIM2REAL_LOCAL_WORKER_PORT": str(config["port"]),
               "RDK_SIM2REAL_LOCAL_WORKER_DATA_DIR": str(root / "jobs"),
               "RDK_SIM2REAL_LOCAL_RUNNER_TOKEN": token,
               "RDK_SIM2REAL_TRAIN_EXECUTABLE": str(python),
               "RDK_SIM2REAL_TRAIN_ARGS_JSON": json.dumps([str(root / "engines/starter-ppo/runner.py")]),
               "RDK_SIM2REAL_TRAIN_ENGINES_JSON": json.dumps({
                   "starter-ppo": {"executable": str(python), "args": [str(root / "engines/starter-ppo/runner.py")]}
               }),
               "RDK_STARTER_ENGINE_DEVICE": "cpu"}
        unit = "rdk-learning-worker-" + config["id"][:24] + ".service"
        manager = shutil.which("systemctl")
        supervised = bool(manager and subprocess.run(
            [manager, "--user", "show-environment"], stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=5).returncode == 0)
        process = None
        if supervised:
            environment = root / "worker.env"
            environment.write_text("\n".join(key + "=" + json.dumps(value)
                for key, value in env.items() if key.startswith("RDK_")) + "\n")
            unit_directory = Path.home() / ".config/systemd/user"
            unit_directory.mkdir(parents=True, exist_ok=True)
            definition = ("[Unit]\nDescription=RDK learning training Worker\n"
                "[Service]\nType=simple\nWorkingDirectory=" + shlex.quote(str(root)) +
                "\nEnvironmentFile=" + shlex.quote(str(environment)) +
                "\nExecStart=" + shlex.quote(node) + " " + shlex.quote(str(root / "worker.mjs")) +
                "\nRestart=on-failure\nRestartSec=3\n[Install]\nWantedBy=default.target\n")
            (unit_directory / unit).write_text(definition)
            subprocess.run([manager, "--user", "daemon-reload"], check=True, timeout=15)
            subprocess.run([manager, "--user", "enable", "--now", unit], check=True, timeout=30)
        else:
            log = (root / "worker.log").open("ab")
            process = subprocess.Popen([node, str(root / "worker.mjs")], cwd=root, env=env,
                                       stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                       start_new_session=True)
        atomic_json(root / "process.json", {"pid": process.pid if process else None, "service": unit if supervised else None})
        for _ in range(60):
            if process is not None and process.poll() is not None:
                raise ValueError("WORKER_START_FAILED")
            try:
                health = read_health(config["port"], token)
                if health.get("ok") is True and health.get("configured") is True:
                    atomic_json(state, {"state": "ready", "engine": "starter-ppo", "device": "cpu",
                                        "supervision": "user-service" if supervised else "process"})
                    return
            except (OSError, ValueError):
                pass
            time.sleep(0.5)
        # Only the process created by this attempt may be stopped.
        if process is not None:
            process.terminate()
            process.wait(timeout=10)
        else:
            subprocess.run([manager, "--user", "stop", unit], check=True, timeout=30)
        raise ValueError("WORKER_HEALTH_TIMEOUT")
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) else type(error).__name__
        atomic_json(state, {"state": "failed", "code": code[:100]})


def status(root, config):
    state = root / "state.json"
    result = json.loads(state.read_text()) if state.exists() else {"state": "starting"}
    if result["state"] == "ready":
        try:
            token = json.loads((root / "worker-secret.json").read_text())["token"]
            health = read_health(config["port"], token)
            if health.get("ok") is not True or health.get("configured") is not True:
                raise ValueError("WORKER_NOT_READY")
            sealed = subprocess.check_output(
                ["openssl", "pkeyutl", "-encrypt", "-pubin", "-inkey", str(root / "public.pem"),
                 "-pkeyopt", "rsa_padding_mode:oaep", "-pkeyopt", "rsa_oaep_md:sha256"],
                input=token.encode(), timeout=5
            )
            result["sealedToken"] = base64.b64encode(sealed).decode()
        except Exception:
            result = {"state": "offline", "code": "WORKER_UNREACHABLE"}
    print(MARKER + json.dumps(result))


if __name__ == "__main__":
    directory = Path(__file__).resolve().parent
    configuration = json.loads((directory / "config.json").read_text())
    if sys.argv[1:] == ["install"]:
        install(directory, configuration)
    elif sys.argv[1:] == ["status"]:
        status(directory, configuration)
    else:
        raise SystemExit("invalid action")
