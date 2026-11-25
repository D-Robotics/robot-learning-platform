#!/usr/bin/env python3
"""Bounded, offline environment checks; never starts training or installs packages."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

import adapter

# Console-script wrappers convert list-envs' task count to a process exit code.
# Read the same registry through its Python API and emit explicit JSON instead.
REGISTRY_PROBE = "import json; import mjlab.tasks; from mjlab.tasks.registry import list_tasks; print(json.dumps({'tasks': list_tasks()}))"

# Executed in the same Python environment selected by adapter.main(). No shell.
RUNTIME_PROBE = r'''
import importlib.metadata as metadata
import json, sys
result = {"python": sys.version.split()[0], "dependencies": [], "cuda": False}
try:
    from packaging.requirements import Requirement
    from packaging.specifiers import SpecifierSet
    spec = json.load(sys.stdin)
    result["pythonCompatible"] = SpecifierSet(spec["python"]).contains(result["python"])
    for raw in spec["dependencies"]:
        requirement = Requirement(raw)
        if requirement.marker and not requirement.marker.evaluate():
            continue
        try:
            version = metadata.version(requirement.name)
            ok = not requirement.specifier or requirement.specifier.contains(version)
        except metadata.PackageNotFoundError:
            version, ok = None, False
        result["dependencies"].append({"name": requirement.name, "version": version, "ok": bool(ok)})
    try:
        import torch
        result["cuda"] = bool(torch.cuda.is_available())
        if result["cuda"]:
            result["gpuName"] = torch.cuda.get_device_name(0)
    except Exception:
        result["cudaError"] = "torch_cuda_probe_failed"
except Exception:
    result["error"] = "runtime_inspection_failed"
print(json.dumps(result))
'''


def robot_files_ready(repo: Path, task: str) -> bool:
    """Check local XML/mesh references, including LFS pointers, without loading physics."""
    robot = repo / "src/mjlab_microduck/robot/microduck"
    roller = any(kind in task for kind in ("Roller", "Swizzle", "Spin"))
    name = "robot_allcollisions_rollers.xml" if roller else (
        "robot_walk.xml" if "Velocity" in task else "robot_allcollisions.xml"
    )
    visited: set[Path] = set()

    def inspect(file: Path, meshdir: Path | None = None) -> None:
        file = file.resolve()
        if not file.is_relative_to(repo.resolve()) or len(visited) >= 64:
            raise ValueError("invalid model reference")
        if file in visited:
            return
        visited.add(file)
        if file.stat().st_size > 8 * 1024 * 1024:
            raise ValueError("model XML too large")
        doc = ET.parse(file).getroot()
        compiler = doc.find("compiler")
        if compiler is not None and compiler.get("meshdir"):
            meshdir = file.parent / compiler.get("meshdir")
        for include in doc.iter("include"):
            inspect(file.parent / include.get("file", ""), meshdir)
        for mesh in doc.iter("mesh"):
            value = mesh.get("file")
            if not value:
                continue
            target = ((meshdir or file.parent) / value).resolve()
            if not target.is_relative_to(repo.resolve()) or not target.is_file() or target.stat().st_size == 0:
                raise ValueError("missing mesh")
            with target.open("rb") as handle:
                if handle.read(80).startswith(b"version https://git-lfs.github.com/spec/"):
                    raise ValueError("unfetched LFS mesh")

    try:
        inspect(robot / name)
        return True
    except (OSError, ValueError, ET.ParseError):
        return False


def run_checked(command: list[str], repo: Path, *, stdin: str | None = None, timeout: int = 20) -> subprocess.CompletedProcess:
    environment = {**os.environ, "HF_HUB_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1",
                   "UV_OFFLINE": "1", "WANDB_MODE": "disabled", "PYTHONDONTWRITEBYTECODE": "1"}
    return subprocess.run(command, input=stdin, cwd=repo, env=environment,
                          capture_output=True, text=True, timeout=timeout)


def inspect_environment(task_id: str = "walk", *, upstream_task: str | None = None) -> dict:
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", task_id):
        raise ValueError("task must be a platform task id")
    if task_id not in adapter.TASK_BY_PLATFORM_ID:
        raise ValueError("unknown platform task id")
    task = upstream_task or adapter.resolve_task_id({"taskId": task_id})
    if not re.fullmatch(r"Mjlab-[A-Za-z0-9_-]{1,120}", task):
        raise ValueError("invalid upstream task id")
    checks: list[dict] = []

    def add(name: str, passed: bool, detail: str, recovery: str = "") -> None:
        checks.append({"id": name, "status": "passed" if passed else "blocked", "detail": detail,
                       **({"recovery": recovery} if not passed and recovery else {})})

    repo = adapter.find_repo()
    add("upstream", repo is not None, "上游训练仓库可读。" if repo else "未找到所配置的上游训练仓库。",
        "准备 MicroDuck RL 源码并设置 RDK_MICRODUCK_RL_DIR。")
    uv = adapter.find_uv()
    uv_ok = bool(uv and os.access(uv, os.X_OK))
    add("uv", uv_ok, "uv 可执行。" if uv_ok else "uv 不可执行或不存在。", "在训练主机安装 uv 并核对 Worker 的 PATH。")
    runtime: dict = {}
    spec: dict = {}
    if repo:
        try:
            import tomllib
            spec = tomllib.loads((repo / "pyproject.toml").read_text())["project"]
        except (ImportError, OSError, ValueError, KeyError):
            spec = {}
    spec_ok = bool(spec.get("requires-python") and isinstance(spec.get("dependencies"), list))
    add("project-spec", spec_ok,
        "按所选源码的 pyproject.toml 检查。" if spec_ok else "无法读取训练项目的环境要求。",
        "检查所选仓库及 pyproject.toml，执行 uv sync 准备对应环境。")
    venv_exists = bool(repo and (repo / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")).is_file())
    add("venv", venv_exists, "训练虚拟环境存在。" if venv_exists else "未找到所选仓库的训练虚拟环境。", "在所选仓库执行 uv sync；不会在预检中安装环境。")
    if repo and spec_ok and venv_exists:
        python = repo / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        executable = str(python) if python.is_file() else sys.executable
        try:
            completed = run_checked([executable, "-c", RUNTIME_PROBE], repo,
                stdin=json.dumps({"python": spec.get("requires-python", ""), "dependencies": spec.get("dependencies", [])}))
            runtime = json.loads(completed.stdout.strip().splitlines()[-1]) if completed.returncode == 0 else {}
        except (OSError, ValueError, IndexError, subprocess.TimeoutExpired):
            runtime = {}
    add("python", runtime.get("pythonCompatible") is True,
        "Python 符合所选源码要求。" if runtime.get("pythonCompatible") else "Python 版本不匹配或无法完成检查。",
        "在该仓库执行 uv sync，配置 Worker 使用其 .venv Python。")
    dependencies = runtime.get("dependencies", [])
    deps_ok = isinstance(dependencies, list) and bool(dependencies) and all(item.get("ok") is True for item in dependencies)
    add("dependencies", deps_ok, "声明依赖已安装且版本匹配。" if deps_ok else "存在缺失或不匹配的声明依赖。",
        "在所选上游仓库执行 uv sync；查看返回的依赖名称与版本。")
    add("cuda", runtime.get("cuda") is True, "PyTorch 可访问 CUDA。" if runtime.get("cuda") else "该 Python 环境无法访问 CUDA。",
        "检查 NVIDIA 驱动、GPU 授权及 CUDA 版 PyTorch；Mac 本机不能替代此 CUDA 训练资源。")
    assets_ok = bool(repo and robot_files_ready(repo, task))
    add("robot-assets", assets_ok, "本地 MJCF 与网格引用已检查。" if assets_ok else "模型/网格缺失、引用异常或仍是 Git LFS 指针。",
        "准备完整机器人资源，拉取 Git LFS 文件；不能把 LFS 指针当作网格。")
    exporter_ok = bool(repo and (repo / "scripts/export.py").is_file())
    add("exporter", exporter_ok, "上游 ONNX 导出脚本存在。" if exporter_ok else "缺少上游 ONNX 导出脚本。",
        "准备包含 scripts/export.py 的完整上游训练仓库。")
    tasks: list[str] = []
    if repo and uv_ok and venv_exists and deps_ok and runtime.get("pythonCompatible"):
        try:
            listed = run_checked([uv, "run", "--offline", "--no-sync", "python", "-c", REGISTRY_PROBE], repo)
            if listed.returncode == 0 and len(listed.stdout) <= 100_000:
                entries = json.loads(listed.stdout.strip().splitlines()[-1])["tasks"]
                if isinstance(entries, list) and all(isinstance(item, str) and re.fullmatch(r"Mjlab-[A-Za-z0-9_-]+", item) for item in entries):
                    tasks = sorted(set(entries))[:128]
        except (OSError, ValueError, KeyError, IndexError, subprocess.TimeoutExpired):
            pass
    add("task-registry", task in tasks, "所选任务已在实际注册表中发现。" if task in tasks else "尚未在实际任务注册表中确认所选任务。",
        "先准备依赖和资源，再在训练主机执行 uv run --offline --no-sync list-envs；检查导入错误。")
    return {"schemaVersion": 1, "engine": "microduck-rl", "taskId": task_id, "upstreamTaskId": task,
            "checkedAt": datetime.now(timezone.utc).isoformat(), "checks": checks,
            "readyForSmokeTraining": all(item["status"] == "passed" for item in checks),
            "pythonVersion": runtime.get("python"), "requiredPython": spec.get("requires-python"), "dependencies": dependencies,
            "gpuName": runtime.get("gpuName"), "registeredTasks": tasks,
            "trainingPerformed": False, "simulationVerified": False,
            "next": "基础检查不能证明训练成功或策略质量；通过后仍需小规模真实训练与独立评测。"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task", default=os.environ.get("RDK_PREFLIGHT_TASK_ID", "walk"))
    args = parser.parse_args()
    print(json.dumps(inspect_environment(args.task), ensure_ascii=False))
