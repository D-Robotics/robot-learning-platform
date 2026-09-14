from originbot_env import DomainParameters, RDKRobotEnv

def main():
    e=RDKRobotEnv(seed=3); a,_=e.reset(seed=3); assert len(a)==8
    b,*rest=e.step([99,-99]); info=rest[-1]
    assert abs(info['cmd_vel']['linear'])<=.3 and abs(info['cmd_vel']['angular'])<=1
    assert len(b)==8 and isinstance(rest[0],float)
    # The file-protocol fallback must honor the task pack's obstacle scene
    # contract and terminate on a contact with an obstacle.
    obstacle_env = RDKRobotEnv(seed=4, goal_distance=(10, 10), obstacle_count=1, obstacle_radius=.2)
    obstacle_env.domain = DomainParameters()
    obstacle_env.randomization = obstacle_env.domain.as_dict()
    obstacle_env._reset_episode_state()
    obstacle_env.state[2] = 0.0; obstacle_env.odom[2] = 0.0
    obstacle_env.obstacles = [(0.01, 0.0, 0.2)]
    _, _, done, _, obstacle_info = obstacle_env.step([.3, 0.0])
    assert done and obstacle_info['collision'] and obstacle_info['obstacles'][0]['radius'] == .2
    # Randomization is episode-scoped and changes the physical path without
    # mutating a shared adapter or leaking into the next nominal episode.
    randomized=RDKRobotEnv(seed=13, domain_randomization=True, goal_distance=(10,10))
    _,reset_info=randomized.reset(seed=13)
    assert set(('motorGain','lagTauSeconds','gyroNoiseStdRadSec','odomNoiseStdM',
                'angularBiasRadSec','actionLatencySteps','odomDropoutProb','slipScale')) <= set(reset_info['domainRandomization'])
    randomized.domain=DomainParameters(latency_steps=2, slip_scale=.5, lag_tau_seconds=0.0)
    randomized.randomization=randomized.domain.as_dict(); randomized._reset_episode_state()
    randomized.state[2] = 0.0; randomized.odom[2] = 0.0
    applied=[randomized.step([.3,0.0])[4]['applied_cmd_vel']['linear'] for _ in range(3)]
    assert applied[:2] == [0.0, 0.0] and applied[2] == .3
    # Slip-blind odometry must diverge from the true pose.
    assert randomized.odom[0] > randomized.state[0] + 0.001
    assert randomized.episode_metrics()['pathLength'] > 0.0
    print('[rdk-rl-env] PASS — OriginBot adapter reset/step/action limits')
if __name__=='__main__': main()
