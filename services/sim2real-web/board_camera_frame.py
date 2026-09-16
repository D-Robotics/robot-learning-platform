#!/usr/bin/env python3
"""Camera frame conversion for the board vision policy path.

Deliberately free of ROS and numpy-at-import-time so it can be unit tested on a
workstation and imported by both the telemetry node (which produces frames) and
the policy runtime (which validates the declared shape).

Two responsibilities:

1. `declared_shape()` is the single parser for the `channels x height x width`
   declaration. The node and the runtime must agree on it exactly - a node that
   emitted a different shape than the runtime expects would be caught by the
   runtime's length check, but only at control-loop time, so both sides read the
   same code here instead of keeping two copies of the parser.
2. `frame_to_nhwc()` turns a raw ROS image into the exact flat float list the
   snapshot carries. It never guesses: an unsupported encoding, a buffer that is
   too short for the declared geometry, or a step/row-padding mismatch returns
   None so the caller fails closed rather than feeding a policy a reinterpreted
   buffer.

Resampling uses a box filter (area average) rather than nearest neighbour.
Nearest neighbour on a downscale is aliasing: it samples roughly one pixel in
every N and can drop a thin obstacle entirely, which for a navigation policy
means acting on an image that does not contain the thing it is about to hit.
"""

import os

# Mirrors the board runtime's per-axis bound. A frame larger than this is a
# configuration mistake, not a policy input.
MAX_AXIS = 4096

# ROS image encodings this converter can map onto the platform's RGB frame.
# Listed explicitly so an unknown encoding is refused instead of assumed.
_ENCODING_CHANNELS = {
    "rgb8": ("rgb", 3),
    "bgr8": ("bgr", 3),
    "rgba8": ("rgba", 4),
    "bgra8": ("bgra", 4),
    "mono8": ("mono", 1),
    "8UC3": ("bgr", 3),
    "8UC1": ("mono", 1),
}


def parse_shape(raw):
    """Parse ``channelsxheightxwidth`` (also accepts ``x``/``,``/``*``).

    Returns ``(channels, height, width)`` or ``None`` when the value is absent
    or malformed. Never raises: this is called at import time.
    """
    if not isinstance(raw, str):
        return None
    text = raw.strip().lower()
    if not text:
        return None
    for separator in (",", "*"):
        text = text.replace(separator, "x")
    parts = text.split("x")
    if len(parts) != 3:
        return None
    try:
        values = tuple(int(part) for part in parts)
    except (TypeError, ValueError):
        return None
    if any(value < 1 or value > MAX_AXIS for value in values):
        return None
    return values


def declared_shape(environ=None):
    """The declared frame shape from ``RDK_SIM2REAL_OBSERVATION_IMAGE``."""
    env = os.environ if environ is None else environ
    return parse_shape(env.get("RDK_SIM2REAL_OBSERVATION_IMAGE", ""))


def _box_indices(source_size, target_size):
    """Half-open source ranges, one per target pixel.

    Computed with integer arithmetic so the same input always yields the same
    mapping: a frame must not resample differently between the node and a
    replay just because of floating point.
    """
    ranges = []
    for index in range(target_size):
        start = (index * source_size) // target_size
        end = ((index + 1) * source_size) // target_size
        if end <= start:
            end = min(source_size, start + 1)
        ranges.append((start, end))
    return ranges


def frame_to_nhwc(
    *,
    encoding,
    width,
    height,
    step,
    data,
    channels,
    out_height,
    out_width,
):
    """Convert a raw image buffer to a flat NHWC float list, or ``None``.

    ``data`` is a bytes-like object; ``step`` is the ROS row stride in bytes
    (rows are frequently padded, so it is honoured rather than assumed equal to
    ``width * pixel_bytes``).
    """
    try:
        encoding = str(encoding).lower()
        width = int(width)
        height = int(height)
        step = int(step)
    except (TypeError, ValueError):
        return None
    if width < 1 or height < 1 or step < 1:
        return None
    layout = _ENCODING_CHANNELS.get(encoding)
    if layout is None:
        return None
    order, source_channels = layout
    try:
        raw = bytes(data)
    except (TypeError, ValueError):
        return None
    needed = step * height
    if len(raw) < needed:
        return None
    minimum_step = width * source_channels
    if step < minimum_step:
        return None

    try:
        out_channels = int(channels)
        out_height = int(out_height)
        out_width = int(out_width)
    except (TypeError, ValueError):
        return None
    if out_height < 1 or out_width < 1:
        return None
    if out_channels not in (1, 3):
        return None
    if out_channels == 1 and order != "mono":
        # Asking for 1 channel from a colour source would silently drop colour;
        # require the adapter to declare 3 so the choice is explicit.
        return None

    rows = _box_indices(height, out_height)
    columns = _box_indices(width, out_width)
    out = []
    for row_start, row_end in rows:
        for column_start, column_end in columns:
            count = (row_end - row_start) * (column_end - column_start)
            if count <= 0:
                return None
            total_r = total_g = total_b = 0
            for y in range(row_start, row_end):
                base = y * step
                for x in range(column_start, column_end):
                    offset = base + x * source_channels
                    if offset + source_channels > len(raw):
                        return None
                    if order == "rgb":
                        r, g, b = raw[offset], raw[offset + 1], raw[offset + 2]
                    elif order == "bgr":
                        b, g, r = raw[offset], raw[offset + 1], raw[offset + 2]
                    elif order == "rgba":
                        r, g, b = raw[offset], raw[offset + 1], raw[offset + 2]
                    elif order == "bgra":
                        b, g, r = raw[offset], raw[offset + 1], raw[offset + 2]
                    else:  # mono
                        r = g = b = raw[offset]
                    total_r += r
                    total_g += g
                    total_b += b
            if out_channels == 1:
                # Mono source into a mono contract: the three totals are equal
                # by construction, so one average is the pixel value.
                out.append(round(total_r / count, 6))
            else:
                # RGB output. A mono source yields r == g == b, i.e. a grey
                # frame, rather than (v, 0, 0).
                out.append(round(total_r / count, 6))
                out.append(round(total_g / count, 6))
                out.append(round(total_b / count, 6))
    expected = out_channels * out_height * out_width
    if len(out) != expected:
        return None
    return out
