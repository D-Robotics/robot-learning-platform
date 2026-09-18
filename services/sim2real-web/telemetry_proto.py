"""Small dependency-free protobuf encoder for the v1 telemetry envelope.

It covers the fields emitted by the board capture path and intentionally has no
decoder. Production images may replace it with generated protobuf bindings;
the wire format and field numbers remain identical to proto/sim2real_telemetry.proto.
"""

from __future__ import annotations

import hashlib
import struct
from typing import Iterable, Optional


def _varint(value: int) -> bytes:
    value = int(value)
    if value < 0:
        value &= (1 << 64) - 1
    out = bytearray()
    while value > 0x7F:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value)
    return bytes(out)


def _field(number: int, payload: bytes, wire: int = 2) -> bytes:
    return _varint((number << 3) | wire) + (payload if wire == 0 else _varint(len(payload)) + payload)


def _string(number: int, value: Optional[str]) -> bytes:
    return b"" if not value else _field(number, value.encode("utf-8"))


def _packed_float(number: int, values: Iterable[float] | None) -> bytes:
    values = list(values or [])
    if not values:
        return b""
    return _field(number, b"".join(struct.pack("<f", float(v)) for v in values))


def encode_control(observation=(), action=(), reward=0.0, done=False, fall=False) -> bytes:
    out = _packed_float(1, observation) + _packed_float(2, action)
    if reward: out += _field(3, struct.pack("<f", float(reward)), 5)
    if done: out += _field(4, _varint(1), 0)
    if fall: out += _field(5, _varint(1), 0)
    return out


def encode_envelope(*, product_id="", contract_id="", device_id="", boot_id="", run_id="", model_artifact_id="", seq=0, monotonic_ns=0, wall_time_ms=0, dropped_count=0, trigger=1, control=None, imu=None, joint=None) -> bytes:
    out = _field(1, _varint(1), 0)
    for field, value in ((2, product_id), (3, contract_id), (6, model_artifact_id), (8, device_id), (9, boot_id), (10, run_id)):
        out += _string(field, value)
    for field, value in ((11, seq), (12, monotonic_ns), (16, dropped_count), (17, trigger)):
        if value: out += _field(field, _varint(value), 0)
    if wall_time_ms: out += _field(13, _varint(wall_time_ms), 0)
    if control is not None: out += _field(20, encode_control(**control))
    if imu is not None:
        body = _packed_float(1, imu.get("quaternion")) + _packed_float(2, imu.get("gyro")) + _packed_float(3, imu.get("linearAcceleration"))
        out += _field(21, body)
    if joint is not None:
        body = _packed_float(1, joint.get("position")) + _packed_float(2, joint.get("velocity")) + _packed_float(3, joint.get("effort"))
        out += _field(22, body)
    return out


def encode_chunk(envelopes: Iterable[bytes], device_id: str, boot_id: str, first_seq: int, last_seq: int) -> bytes:
    body = b"".join(_field(5, envelope) for envelope in envelopes)
    body = _string(1, device_id) + _string(2, boot_id) + _field(3, _varint(first_seq), 0) + _field(4, _varint(last_seq), 0) + body
    return body + _field(6, hashlib.sha256(body).digest())
