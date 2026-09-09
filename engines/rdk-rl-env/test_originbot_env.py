from originbot_env import RDKRobotEnv

def main():
    e=RDKRobotEnv(seed=3); a,_=e.reset(seed=3); assert len(a)==8
    b,*rest=e.step([99,-99]); info=rest[-1]
    assert abs(info['cmd_vel']['linear'])<=.3 and abs(info['cmd_vel']['angular'])<=1
    assert len(b)==8 and isinstance(rest[0],float)
    print('[rdk-rl-env] PASS — OriginBot adapter reset/step/action limits')
if __name__=='__main__': main()
