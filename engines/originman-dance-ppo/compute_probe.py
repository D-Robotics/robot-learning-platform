"""Compare identical ONNX bytes and recorded simulation inputs on another CPU.

This program imports no robot control, serial, ROS, or sensor interface.
"""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import time

import numpy as np
import onnxruntime as ort


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    model = args.directory / 'policy.onnx'
    probe_file = args.directory / 'probes.json'
    probes = json.loads(probe_file.read_text())
    sha = hashlib.sha256(model.read_bytes()).hexdigest()
    if sha != probes['modelSha256']:
        raise ValueError('policy SHA-256 differs from reference')
    observations = np.asarray(probes['observations'], dtype=np.float32)
    expected = np.asarray(probes['expected'], dtype=np.float32)
    if observations.ndim != 2 or observations.shape[1] != 78 or expected.shape != (len(observations), 18):
        raise ValueError('probe contract must be 78 observations to 18 actions')
    if not np.isfinite(observations).all() or not np.isfinite(expected).all():
        raise ValueError('probe contains non-finite values')
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    session = ort.InferenceSession(str(model), sess_options=options, providers=['CPUExecutionProvider'])
    name = session.get_inputs()[0].name
    actual, latency = [], []
    for row in observations:
        start = time.perf_counter()
        output = session.run(None, {name: row[None, :]})[0][0]
        latency.append((time.perf_counter() - start) * 1000)
        actual.append(output)
    actual = np.asarray(actual)
    passed = actual.shape == expected.shape and bool(np.allclose(actual, expected, atol=1e-5, rtol=1e-4))
    receipt = {
        'passed': passed, 'modelSha256': sha,
        'probeSha256': hashlib.sha256(probe_file.read_bytes()).hexdigest(),
        'sourceRunId': probes['sourceRunId'], 'inputSource': probes['source'],
        'contractId': probes.get('contractId'),
        'observationAdapterId': probes.get('observationAdapterId'),
        'architecture': platform.machine(), 'onnxruntime': ort.__version__,
        'inputShape': list(observations.shape), 'outputShape': list(actual.shape),
        'maximumAbsoluteError': float(np.max(np.abs(actual - expected))),
        'singleInferenceMedianMs': float(np.median(latency)),
        'singleInferenceP95Ms': float(np.percentile(latency, 95)),
        'computationOnly': True, 'physicalSensorData': False,
        'authorizesDeployment': False, 'physicalMotionVerified': False,
    }
    (args.directory / 'compute-receipt.json').write_text(json.dumps(receipt, indent=2))
    print(json.dumps(receipt))
    if not passed:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
