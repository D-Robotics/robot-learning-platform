#!/usr/bin/env python3
import json,sys
from originbot_env import RDKRobotEnv
steps=int(sys.argv[1]) if len(sys.argv)>1 else 50
env=RDKRobotEnv(seed=11, domain_randomization=True); obs,reset_info=env.reset(seed=11)
for i in range(steps):
    action=[0.12,0.0]; obs,reward,done,truncated,info=env.step(action)
    print(json.dumps({'t':round(i*env.adapter.dt,3),'observation':obs,'action':action,'reward':reward,'done':done,'truncated':truncated,'source':'originbot-sim','controlPeriodSeconds':env.adapter.dt,'controlHz':1.0/env.adapter.dt,'domainRandomization':reset_info['domainRandomization'],'telemetry':{'odom':info['odom'],'imu':info['imu'],'batteryVoltage':12.1},'episode':info['episode']},separators=(',',':')))
    if done or truncated: break
