#!/usr/bin/env python3
"""Train the synthetic OriginBot visual-to-twist policy.

This is a deterministic perception/control contract exercise, not real-world
evidence. Every result is explicitly marked synthetic and non-deployable.
"""
import json, os, random
import torch

DEVICE = torch.device("cuda" if torch.cuda.is_available() and os.environ.get("RDK_STARTER_ENGINE_DEVICE", "auto") != "cpu" else "cpu")

def make_dataset(n=4096, seed=7):
    rng = random.Random(seed); rows=[]
    for _ in range(n):
        dx, dy = rng.uniform(-1, 1), rng.uniform(-1, 1)
        width, height = rng.uniform(.03, .45), rng.uniform(.03, .45)
        conf = rng.uniform(.65, 1.0); yaw = rng.uniform(-3.14, 3.14)
        v = rng.uniform(0, .3); w = rng.uniform(-1, 1)
        obs = [dx, dy, width, height, conf, yaw, v, w]
        action = [max(0., min(.3, .18 * (1 - abs(dy)) * conf)), max(-1., min(1., 1.4 * dx - .2 * yaw))]
        rows.append({"observation": obs, "action": action, "source": "browser-simulator", "mock": True})
    return rows

class Policy(torch.nn.Module):
    def __init__(self):
        super().__init__(); self.net=torch.nn.Sequential(torch.nn.Linear(8,64),torch.nn.Tanh(),torch.nn.Linear(64,64),torch.nn.Tanh(),torch.nn.Linear(64,2))
    def forward(self, x): return self.net(x)

def main():
    out = os.environ["RDK_SIM2REAL_RESULT_FILE"]; job=os.path.dirname(out); rows=make_dataset(int(os.environ.get("RDK_VISUAL_DATASET_SAMPLES", "4096")))
    torch.manual_seed(7); model=Policy().to(DEVICE); opt=torch.optim.Adam(model.parameters(), lr=2e-3); x=torch.tensor([r["observation"] for r in rows],dtype=torch.float32,device=DEVICE); y=torch.tensor([r["action"] for r in rows],dtype=torch.float32,device=DEVICE)
    for _ in range(int(os.environ.get("RDK_VISUAL_EPOCHS", "80"))): opt.zero_grad(); loss=torch.nn.functional.mse_loss(model(x),y); loss.backward(); opt.step()
    model.eval(); onnx=os.path.join(job,"originbot-visual-twist.onnx"); torch.onnx.export(model,torch.zeros(1,8,device=DEVICE),onnx,input_names=["observation"],output_names=["action"],opset_version=11)
    with open(os.path.join(job,"visual-dataset.jsonl"),"w") as f:
        f.write("\n".join(json.dumps(r) for r in rows)+"\n")
    result={"status":"completed","synthetic":True,"mock":True,"deployable":False,"taskId":"originbot-visual-twist-v1","dataset":{"samples":len(rows),"source":"browser-simulator","mock":True},"artifact":{"artifactRef":"artifact://originbot/visual-twist/synthetic","format":"onnx","runtime":"cpu-onnx","observationSize":8,"actionSize":2,"deployable":False},"metrics":{"contractValid":True,"algorithm":"supervised-visual-twist","device":DEVICE.type,"deviceName":torch.cuda.get_device_name(0) if DEVICE.type=="cuda" else "cpu","epochs":int(os.environ.get("RDK_VISUAL_EPOCHS","80")),"datasetSamples":len(rows),"synthetic":True}}
    json.dump(result,open(out,"w")); print(json.dumps(result))
if __name__ == "__main__": main()
