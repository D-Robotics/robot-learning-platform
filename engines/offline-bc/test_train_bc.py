import json
from train_bc import train

def test_bc(tmp_path):
    d=tmp_path/'d.jsonl'; o=tmp_path/'m.json'; d.write_text('\n'.join(json.dumps({'observation':[x,1],'action':[2*x+3]}) for x in range(5)))
    loss=train(d,o,epochs=500,lr=.05); assert loss < 1e-4; assert json.loads(o.read_text())['format']=='rdk-offline-bc-v1'
