#!/usr/bin/env python3
import json,sys
from originbot_env import RDKRobotEnv
steps=int(sys.argv[1]) if len(sys.argv)>1 else 50
env=RDKRobotEnv(seed=11); obs,_=env.reset(seed=11)
for i in range(steps):
    action=[0.12,0.0]; obs,reward,done,truncated,info=env.step(action)
    print(json.dumps({'t':round(i*env.adapter.dt,3),'observation':obs,'action':action,'reward':reward,'done':done,'source':'originbot-sim','telemetry':{'odom':{'x':env.state[0],'y':env.state[1],'yaw':env.state[2]},'imu':{'yaw':env.state[2]},'batteryVoltage':12.1}},separators=(',',':')))
    if done: break
