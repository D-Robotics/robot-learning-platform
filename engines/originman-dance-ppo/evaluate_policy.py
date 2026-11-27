"""Re-evaluate a retained ONNX policy using the training engine's simulation gate."""

import hashlib
import json
from pathlib import Path
import subprocess
import sys

import numpy as np
import onnxruntime as ort

from adapter import environment_for_contract, policy_metadata, validate_bundle
from dance_env import validate_dance_config
from train import evaluate


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    directory = Path(sys.argv[1])
    bundle = Path(sys.argv[2])
    request = json.loads((directory / 'input.json').read_text())
    scene = bundle / 'model/scene.xml'
    if validate_bundle(bundle)['sceneSha256'] != request['sceneSha256']:
        raise ValueError('scene does not match the source run')
    policy = directory / 'policy.onnx'
    if sha(policy) != request['policySha256']:
        raise ValueError('policy does not match the source run')
    dance = validate_dance_config(request['dance'])
    environment_class = environment_for_contract({'id': request['contractId']})
    options = ort.SessionOptions()
    options.intra_op_num_threads = options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(policy), sess_options=options, providers=['CPUExecutionProvider'])
    metadata = session.get_modelmeta().custom_metadata_map
    # Older releases never embedded runtime metadata and advanced 20 steps
    # per action even on the 2 ms scene. Reproduce that clock for those policies.
    legacy_timing = not any(key.startswith('rdk.') for key in metadata)
    environment = environment_class(bundle, dance, training=False, legacy_timing=legacy_timing)

    def actor(observation):
        action = session.run(['action'], {'observation': observation[None, :]})[0][0]
        if action.shape != (18,) or not np.isfinite(action).all():
            raise ValueError('invalid action from policy')
        return action.clip(-1, 1)

    nominal = dance['bpm']
    tempos = sorted({max(80.0, nominal * 0.95), nominal, min(140.0, nominal * 1.05)})
    evaluations = []
    trace = directory / 'dance-replay.npz'
    try:
        expected = policy_metadata(request['contractId'], request['sceneSha256'], environment.names)
        if not legacy_timing and any(metadata.get(key) != value for key, value in expected.items()):
            raise ValueError('ONNX contract, scene, control clock or action order does not match the source run')
        for bpm in tempos:
            row = evaluate(environment, actor, bpm, trace=bpm == nominal)
            if bpm == nominal:
                np.savez_compressed(trace, qpos=row.pop('qpos'), bpm=bpm)
                row.pop('frameMetrics')
            sections = row.pop('sectionResults')
            row['sections'] = []
            for section in sections:
                fields = ('type', 'beats', 'clean', 'stylePassed', 'passed')
                row['sections'].append({
                    **{key: section[key] for key in fields},
                    'measurements': {key: value for key, value in section.items() if key not in (*fields, 'index')},
                })
            evaluations.append(row)
    finally:
        environment.close()
    video = directory / 'replay.mp4'
    subprocess.run([
        sys.executable, str(Path(__file__).with_name('render_replay.py')),
        '--scene', str(scene), '--replay', str(trace), '--output', str(video),
    ], check=True, timeout=105, stdout=subprocess.DEVNULL)
    receipt = json.loads(video.with_suffix('.receipt.json').read_text())
    report = {
        'qualityGatePassed': all(row['allSectionsPassed'] for row in evaluations),
        'evaluations': evaluations,
        'replay': {
            'sha256': receipt['replaySha256'], 'videoSha256': receipt['videoSha256'],
            'durationSeconds': receipt['durationSeconds'],
        },
        'runtime': {'engine': 'cpu-mujoco', 'inference': 'onnxruntime-cpu'},
    }
    (directory / 'report.json').write_text(json.dumps(report, allow_nan=False))


if __name__ == '__main__':
    main()
