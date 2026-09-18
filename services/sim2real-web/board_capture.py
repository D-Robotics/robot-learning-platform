#!/usr/bin/env python3
"""Bounded, non-blocking board capture primitives.

The producer path is deliberately tiny: copy a fixed-size sample into a
preallocated SPSC buffer and advance a sequence number. Serialization,
trigger-window draining and disk/network I/O belong to the consumer thread.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
import uuid
from dataclasses import dataclass
from typing import Iterable, Optional, Tuple


@dataclass(frozen=True)
class Sample:
    seq: int
    monotonic_ns: int
    wall_time_ms: int
    payload: bytes


class SpscRingBuffer:
    """Fixed-capacity SPSC byte-slot ring.

    ``push`` performs no allocation, lock, serialization or I/O. The single
    producer and consumer requirement is intentional and must be enforced by
    the board agent's thread topology.
    """

    def __init__(self, capacity: int, sample_bytes: int):
        if capacity < 2 or sample_bytes < 1:
            raise ValueError("capacity must be >=2 and sample_bytes must be >=1")
        self.capacity = int(capacity)
        self.sample_bytes = int(sample_bytes)
        self._slots = [bytearray(sample_bytes) for _ in range(capacity)]
        self._seq = [-1] * capacity
        self._write = 0
        self._read = 0
        self.overrun_count = 0

    def push(self, payload: bytes, seq: Optional[int] = None) -> int:
        if len(payload) != self.sample_bytes:
            raise ValueError("payload size does not match fixed sample size")
        index = self._write % self.capacity
        if self._write - self._read >= self.capacity:
            self._read += 1
            self.overrun_count += 1
        self._slots[index][:] = payload
        actual_seq = self._write if seq is None else int(seq)
        self._seq[index] = actual_seq
        self._write += 1
        return actual_seq

    def pop(self) -> Optional[Tuple[int, bytes]]:
        if self._read >= self._write:
            return None
        index = self._read % self.capacity
        seq = self._seq[index]
        payload = bytes(self._slots[index])
        self._read += 1
        return seq, payload

    def __len__(self) -> int:
        return self._write - self._read


class TriggerCapture:
    """Pre/post-window trigger state machine over decoded samples."""

    def __init__(self, pre_samples: int, post_samples: int):
        if pre_samples < 0 or post_samples < 0:
            raise ValueError("window sizes must be non-negative")
        self.pre_samples = pre_samples
        self.post_samples = post_samples
        self._history: list[Sample] = []
        self._active: list[Sample] | None = None
        self._remaining = 0

    def append(self, sample: Sample, triggered: bool = False) -> Optional[list[Sample]]:
        self._history.append(sample)
        if len(self._history) > self.pre_samples + 1:
            del self._history[0 : len(self._history) - self.pre_samples - 1]
        if triggered and self._active is None:
            self._active = list(self._history)
            self._remaining = self.post_samples
            if self._remaining == 0:
                result, self._active = self._active, None
                return result
        elif self._active is not None:
            self._active.append(sample)
            self._remaining -= 1
            if self._remaining <= 0:
                result, self._active = self._active, None
                return result
        return None


class RollingSpool:
    """Atomic JSONL segment writer with bounded retention."""

    def __init__(self, directory: str, max_bytes: int, keep_segments: int = 8):
        self.directory = os.path.abspath(directory)
        self.max_bytes = max(1024, int(max_bytes))
        self.keep_segments = max(1, int(keep_segments))
        os.makedirs(self.directory, exist_ok=True)
        self._part = 0
        self._handle = None
        self._path = ""
        self._size = 0

    def _open(self) -> None:
        self._part += 1
        self._path = os.path.join(self.directory, f"telemetry-{self._part:08d}.jsonl.tmp")
        self._handle = open(self._path, "ab", buffering=0)
        self._size = 0

    def append(self, samples: Iterable[Sample]) -> Optional[str]:
        rows = [
            {"seq": s.seq, "monotonicNs": s.monotonic_ns, "wallTimeMs": s.wall_time_ms, "payload": s.payload.hex()}
            for s in samples
        ]
        if not rows:
            return None
        if self._handle is None:
            self._open()
        data = ("".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows).encode())
        if self._size and self._size + len(data) > self.max_bytes:
            self.close()
            self._open()
        self._handle.write(data)
        self._handle.flush()
        os.fsync(self._handle.fileno())
        self._size += len(data)
        return self._path

    def close(self) -> None:
        if self._handle is None:
            return
        self._handle.close()
        final = self._path[:-4]
        os.replace(self._path, final)
        self._handle = None
        files = sorted(
            os.path.join(self.directory, name)
            for name in os.listdir(self.directory)
            if name.startswith("telemetry-") and name.endswith(".jsonl")
        )
        for path in files[:-self.keep_segments]:
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass


def deterministic_chunk_id(device_id: str, boot_id: str, first_seq: int, payload: bytes) -> str:
    digest = hashlib.sha256(payload).hexdigest()[:24]
    return f"{device_id}:{boot_id}:{first_seq}:{digest}"


def new_boot_id() -> str:
    return uuid.uuid4().hex
