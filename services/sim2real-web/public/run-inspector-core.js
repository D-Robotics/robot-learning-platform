/* Pure, DOM-free recorded-data logic shared by the Run inspector and tests. */
(function (root) {
  'use strict';

  function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function prepareFrames(input) {
    const frames = [];
    let dropped = 0;
    for (const sample of Array.isArray(input) ? input : []) {
      const t = finite(sample?.t) ?? finite(sample?.time);
      if (t === null) {
        dropped += 1;
        continue;
      }
      frames.push({ ...sample, t });
    }
    frames.sort((a, b) => a.t - b.t);
    return { frames, dropped };
  }

  function duration(frames) {
    return frames.length ? frames[frames.length - 1].t - frames[0].t : 0;
  }

  function atOrBefore(frames, t) {
    let low = 0;
    let high = frames.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (frames[middle].t <= t) low = middle + 1;
      else high = middle;
    }
    return low - 1;
  }

  function sampleAtElapsed(frames, elapsed) {
    if (!frames.length || finite(elapsed) === null || elapsed < 0) {
      return { sample: null, index: -1, ended: false };
    }
    if (elapsed > duration(frames) + 0.0000001) {
      return { sample: null, index: -1, ended: true };
    }
    const index = atOrBefore(frames, frames[0].t + elapsed + 0.0000001);
    return { sample: frames[index] ?? null, index, ended: false };
  }

  function cameraAtElapsed(frames, elapsed) {
    const selected = sampleAtElapsed(frames, elapsed);
    if (!selected.sample) return null;
    for (let index = selected.index; index >= 0; index -= 1) {
      if (frames[index].cameraFrame) {
        return {
          frame: frames[index],
          index,
          age: Math.max(0, frames[0].t + elapsed - frames[index].t),
        };
      }
    }
    return null;
  }

  function dimensions(contract, field, count) {
    const descriptors = [];
    const layout = contract?.[`${field}Layout`];
    for (const item of Array.isArray(layout) ? layout : []) {
      if (item?.modality === 'image') continue;
      const fields = Array.isArray(item?.fields) ? item.fields : [];
      const size =
        Number.isSafeInteger(item?.size) && item.size > 0 ? item.size : fields.length || 1;
      const remaining = Math.min(size, count - descriptors.length);
      for (let offset = 0; offset < remaining; offset += 1) {
        const entry = fields[offset];
        const name = typeof entry === 'string' ? entry : entry?.name;
        const base = typeof item?.name === 'string' && item.name ? item.name : field;
        const unit = entry?.unit ?? item?.unit ?? item?.units;
        descriptors.push({
          name: name || (size === 1 ? base : `${base}[${offset}]`),
          unit: typeof unit === 'string' && unit ? unit : null,
          index: descriptors.length,
        });
      }
      if (descriptors.length >= count) break;
    }
    while (descriptors.length < count)
      descriptors.push({
        name: `${field}[${descriptors.length}]`,
        unit: null,
        index: descriptors.length,
      });
    return descriptors;
  }

  function rewardParts(sample) {
    const raw =
      sample?.rewardComponents ??
      sample?.rewardTerms ??
      sample?.rewardContributions ??
      sample?.rewardBreakdown;
    if (Array.isArray(raw))
      return raw
        .filter((item) => typeof item?.name === 'string' && finite(item?.value) !== null)
        .map((item) => ({ name: item.name, value: item.value }));
    if (!raw || typeof raw !== 'object') return [];
    return Object.entries(raw)
      .filter(([, value]) => finite(value) !== null)
      .map(([name, value]) => ({ name, value }));
  }

  function events(frames) {
    if (!frames.length) return [];
    const result = [];
    for (const sample of frames) {
      const append = (kind, label) =>
        result.push({ elapsed: sample.t - frames[0].t, t: sample.t, kind, label });
      if (sample.fall === true) append('fall', '跌倒');
      if (sample.done === true) append('done', 'episode 完成');
      if (typeof sample.event?.kind === 'string') {
        append(
          sample.event.kind,
          sample.event.kind + (sample.event.stopReason ? ` · ${sample.event.stopReason}` : ''),
        );
      }
    }
    return result;
  }

  function cameraRgba(camera, bytes) {
    const { width, height, channels, encoding } = camera ?? {};
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width * height > 4194304
    )
      return null;
    if (
      !['rgb8', 'bgr8', 'mono8'].includes(encoding) ||
      channels !== (encoding === 'mono8' ? 1 : 3)
    )
      return null;
    if (!bytes || bytes.length !== width * height * channels) return null;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const source = pixel * channels;
      const target = pixel * 4;
      rgba[target] = bytes[source + (encoding === 'bgr8' ? 2 : 0)];
      rgba[target + 1] = bytes[source + (channels === 1 ? 0 : 1)];
      rgba[target + 2] = bytes[source + (channels === 1 || encoding === 'bgr8' ? 0 : 2)];
      rgba[target + 3] = 255;
    }
    return rgba;
  }

  function nextElapsed(frames, elapsed, direction) {
    if (!frames.length) return 0;
    const start = frames[0].t;
    if (direction > 0) {
      const index = atOrBefore(frames, start + elapsed + 0.0000001) + 1;
      return index < frames.length ? frames[index].t - start : duration(frames);
    }
    const index = atOrBefore(frames, start + elapsed - 0.0000001);
    return index >= 0 ? frames[index].t - start : 0;
  }

  root.RdkRunInspectorCore = {
    finite,
    prepareFrames,
    duration,
    sampleAtElapsed,
    cameraAtElapsed,
    dimensions,
    rewardParts,
    events,
    cameraRgba,
    nextElapsed,
  };
})(globalThis);
