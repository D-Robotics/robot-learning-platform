#!/usr/bin/env python3
"""OriginBot PPO trainer using the shared Worker file protocol."""
import json, os, random, math
import torch
from originbot_env import RDKRobotEnv

class ActorCritic(torch.nn.Module):
    def __init__(self):
        super().__init__(); self.body=torch.nn.Sequential(torch.nn.Linear(8,64),torch.nn.Tanh(),torch.nn.Linear(64,64),torch.nn.Tanh()); self.mu=torch.nn.Linear(64,2); self.value=torch.nn.Linear(64,1); self.logstd=torch.nn.Parameter(torch.full((2,),-0.5))
    def forward(self,x):
        h=self.body(x); return torch.tanh(self.mu(h)), self.value(h).squeeze(-1)

def main():
    req=json.load(open(os.environ['RDK_SIM2REAL_REQUEST_FILE'])); out=os.environ['RDK_SIM2REAL_RESULT_FILE']; profile=req.get('training',{}).get('profile','smoke'); updates={'smoke':20,'low-vram':80,'standard':180,'high-vram':300}.get(profile,20); torch.manual_seed(7); random.seed(7)
    env=RDKRobotEnv(seed=7); net=ActorCritic(); opt=torch.optim.Adam(net.parameters(),lr=3e-4); gamma=.99; lam=.95; clip=.2; rewards=[]
    for update in range(updates):
        obs,_=env.reset(seed=7+update); O=[]; A=[]; LP=[]; V=[]; R=[]; D=[]
        for _ in range(128):
            x=torch.tensor([obs],dtype=torch.float32); mu,val=net(x); dist=torch.distributions.Normal(mu,torch.exp(net.logstd)); a=dist.sample(); lp=dist.log_prob(a).sum(-1); act=a[0].detach().tolist(); nxt,r,done,_,_=env.step(act)
            O.append(x[0]); A.append(a[0]); LP.append(lp[0].detach()); V.append(val[0].detach()); R.append(r); D.append(done); obs=nxt
            if done: obs,_=env.reset(seed=7+update)
        with torch.no_grad(): _,lastv=net(torch.tensor([obs],dtype=torch.float32)); lastv=lastv[0]
        adv=[]; gae=torch.tensor(0.); vals=V+[lastv]
        for i in reversed(range(len(R))):
            delta=torch.tensor(R[i])+gamma*vals[i+1]*(0 if D[i] else 1)-vals[i]; gae=delta+gamma*lam*(0 if D[i] else 1)*gae; adv.insert(0,gae)
        obs_t=torch.stack(O); act_t=torch.stack(A); oldlp=torch.stack(LP); adv_t=torch.stack(adv); ret=adv_t+torch.stack(V); adv_t=(adv_t-adv_t.mean())/(adv_t.std()+1e-8)
        for _ in range(4):
            mu,val=net(obs_t); dist=torch.distributions.Normal(mu,torch.exp(net.logstd)); lp=dist.log_prob(act_t).sum(-1); ratio=torch.exp(lp-oldlp); loss=-torch.min(ratio*adv_t,torch.clamp(ratio,1-clip,1+clip)*adv_t).mean()+.5*torch.nn.functional.mse_loss(val,ret)-.001*dist.entropy().sum(-1).mean(); opt.zero_grad(); loss.backward(); torch.nn.utils.clip_grad_norm_(net.parameters(),.5); opt.step()
        rewards.append(sum(R)/len(R))
    job=os.path.dirname(out); ck=os.path.join(job,'originbot-ppo.pt'); torch.save({'model':net.state_dict(),'observationSize':8,'actionSize':2},ck); onnx_exported=False
    try: torch.onnx.export(net,torch.zeros(1,8),os.path.join(job,'originbot-policy.onnx'),input_names=['observation'],output_names=['action','value'],opset_version=17); onnx_exported=True
    except Exception: pass
    json.dump({'status':'completed','checkpoint':{'checkpointId':'originbot-ppo-final','artifactRef':'artifact://originbot/ppo-checkpoint','iteration':updates},'artifact':{'artifactRef':'artifact://originbot/ppo-policy','format':'onnx' if onnx_exported else 'torch','observationSize':8,'actionSize':2},'metrics':{'algorithm':'ppo','rewardStart':rewards[0],'rewardEnd':rewards[-1],'reward':max(rewards),'iterations':updates,'observationSize':8,'actionSize':2,'onnxExported':onnx_exported,'simulator':'originbot-kinematic'},'deployable':False},open(out,'w'))
    print(json.dumps({'status':'completed','algorithm':'ppo','iterations':updates,'rewardStart':rewards[0],'rewardEnd':rewards[-1],'onnxExported':onnx_exported}))
if __name__=='__main__': main()
