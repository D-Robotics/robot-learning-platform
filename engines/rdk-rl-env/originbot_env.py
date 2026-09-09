"""Generic lightweight RL environment with an OriginBot diff-drive adapter.
No ROS or simulator dependency: useful for contract/training UI demos.
"""
from dataclasses import dataclass
import math, random

@dataclass
class OriginBotAdapter:
    dt: float = 0.1
    max_linear: float = 0.3
    max_angular: float = 1.0
    observation_size: int = 8
    action_size: int = 2

    def project_action(self, action):
        v = max(-self.max_linear, min(self.max_linear, float(action[0])))
        w = max(-self.max_angular, min(self.max_angular, float(action[1])))
        return v, w

    def observation(self, state):
        # x, y, yaw, goal_x, goal_y, v, w, distance
        x, y, yaw, gx, gy, v, w = state
        dx, dy = gx-x, gy-y
        return [x, y, math.sin(yaw), math.cos(yaw), dx, dy, v, w]

class RDKRobotEnv:
    """Adapter-driven environment. Replace dynamics with Gazebo/Isaac later."""
    def __init__(self, adapter=None, seed=7, horizon=200):
        self.adapter = adapter or OriginBotAdapter(); self.horizon=horizon; self.rng=random.Random(seed)
        self.reset()
    def reset(self, seed=None):
        if seed is not None: self.rng.seed(seed)
        self.state=[0.,0.,0., self.rng.uniform(1.,2.), self.rng.uniform(-1.,1.), 0., 0.]; self.t=0
        return self.adapter.observation(self.state), {"adapter":"originbot-differential-drive","simulated":True}
    def step(self, action):
        v,w=self.adapter.project_action(action); x,y,yaw,gx,gy,_,_=self.state
        yaw += w*self.adapter.dt; x += v*math.cos(yaw)*self.adapter.dt; y += v*math.sin(yaw)*self.adapter.dt
        self.state=[x,y,yaw,gx,gy,v,w]; self.t+=1; d=math.hypot(gx-x,gy-y)
        reward=-d-0.01*(abs(v)+abs(w)); success=d<0.12; done=success or self.t>=self.horizon
        if success: reward+=5.
        return self.adapter.observation(self.state), reward, done, False, {"distance":d,"success":success,"cmd_vel":{"linear":v,"angular":w}}

if __name__ == '__main__':
    env=RDKRobotEnv(); obs,info=env.reset(seed=1)
    for _ in range(3): obs,r,done,truncated,info=env.step([0.1,0.0]); print(obs,r,info)
