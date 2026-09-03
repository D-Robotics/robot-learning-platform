# Microduck upstream

The production browser simulator is built from the public Pollen Robotics
repository at commit `1261013e7e28ba2a6878bd76ae573751c0e4b457`.

- Simulator: https://github.com/pollen-robotics/microduck-simulator
- Robot model and runtime: https://github.com/pollen-robotics/microduck
- RL policies and training assets: https://github.com/pollen-robotics/microduck_rl
- Public demo: https://huggingface.co/spaces/pollen-robotics/microduck-simulator

The upstream repositories' license and model-file terms apply to the
corresponding static assets. Do not add arbitrary model or code uploads to the
public route.

The hosted build applies one integration fix in `app/src/game/duck.js`: the
upstream absolute STL directory is resolved against the page URL so roller
assets work under `/mujoco/microduck/`.
