#!/usr/bin/env python3
"""Minimal offline behavior-cloning trainer for transition JSONL datasets."""
import argparse, json, pathlib
import numpy as np

def load(path):
    xs=[]; ys=[]
    for no,line in enumerate(pathlib.Path(path).read_text().splitlines(),1):
        if not line.strip(): continue
        row=json.loads(line); obs=row.get('observation',row.get('state')); act=row.get('action')
        if not isinstance(obs,list) or not isinstance(act,list): raise ValueError(f'line {no}: observation/action required')
        if not all(isinstance(x,(int,float)) for x in obs+act): raise ValueError(f'line {no}: values must be numeric')
        xs.append(obs); ys.append(act)
    if not xs: raise ValueError('dataset is empty')
    if len({len(x) for x in xs})!=1 or len({len(y) for y in ys})!=1: raise ValueError('inconsistent dimensions')
    return np.asarray(xs,dtype=np.float32),np.asarray(ys,dtype=np.float32)

def train(path, out, epochs=100, lr=1e-2):
    x,y=load(path); x1=np.c_[x,np.ones(len(x),dtype=np.float32)]; w=np.zeros((x1.shape[1],y.shape[1]),np.float32)
    for _ in range(epochs):
        err=x1@w-y; w-=lr*(x1.T@err)/len(x)
    pred=x1@w; loss=float(np.mean((pred-y)**2)); pathlib.Path(out).write_text(json.dumps({'format':'rdk-offline-bc-v1','observation_size':x.shape[1],'action_size':y.shape[1],'weights':w.tolist(),'train_loss':loss},ensure_ascii=False))
    return loss

if __name__=='__main__':
    p=argparse.ArgumentParser(); p.add_argument('dataset'); p.add_argument('--out',required=True); p.add_argument('--epochs',type=int,default=100); p.add_argument('--lr',type=float,default=1e-2); a=p.parse_args(); print(json.dumps({'train_loss':train(a.dataset,a.out,a.epochs,a.lr)}))
