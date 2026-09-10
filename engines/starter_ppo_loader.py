"""Shared loader for the starter PPO engine module.

engines/starter-ppo is a directory with a hyphen, so it is not importable as
a package name. This loader registers it under a legal alias so the
rsl-rl adapter can reuse GoalNavEnv, the pinned-envelope evaluator, and the
quality gate instead of duplicating them — one evaluation shape across
engines means the platform's release gate re-computes the same verdict.

The engine is executed once per process (cached). Importing it must not run
a training job: starter-ppo/runner.py only trains inside main(), which this
loader never calls.
"""

import importlib
import importlib.util
import os
import sys

_CACHE = None
_ALIAS = "engines.starter_ppo_runner"
_ENGINES_DIR = os.path.dirname(os.path.abspath(__file__))


def load_starter_engine():
    """Return the starter-ppo module (GoalNavEnv, evaluators, quality gate)."""
    global _CACHE
    if _CACHE is not None:
        return _CACHE
    # The worker runs the engine with the job directory as CWD, so the repo's
    # engines/ package (this loader's own location) must be importable from
    # wherever the process starts.
    if _ENGINES_DIR not in sys.path:
        sys.path.insert(0, _ENGINES_DIR)
    runner_path = os.path.join(_ENGINES_DIR, "starter-ppo", "runner.py")
    if not os.path.isfile(runner_path):
        raise FileNotFoundError("engines/starter-ppo/runner.py is missing: " + runner_path)
    spec = importlib.util.spec_from_file_location(_ALIAS, runner_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[_ALIAS] = module
    spec.loader.exec_module(module)
    _CACHE = module
    return module
