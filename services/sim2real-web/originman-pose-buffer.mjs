// Interpolate only between received MuJoCo samples. Never predict a future pose.
export class PoseBuffer {
  constructor(delay = 0.12) {
    this.delay = delay;
    this.reset();
  }
  reset() {
    this.frames = [];
    this.time = 0;
    this.started = false;
    this.last = null;
    this.stalls = 0;
  }
  add(frames, snap = false) {
    if (!frames.length) return;
    if (snap || frames.at(-1).time < (this.frames.at(-1)?.time ?? -1)) this.reset();
    for (const frame of frames) {
      if (frame.time > (this.frames.at(-1)?.time ?? -1)) this.frames.push(frame);
      else if (frame.time === this.frames.at(-1)?.time) this.frames[this.frames.length - 1] = frame;
    }
    if (!this.started) this.time = Math.max(this.time, this.frames[0].time);
    if (snap) {
      this.time = this.frames.at(-1).time;
      this.started = false;
    }
    if (this.frames.length > 150) this.frames.splice(0, this.frames.length - 150);
  }
  sample(now, running) {
    if (!this.frames.length) return null;
    const latest = this.frames.at(-1);
    const delta = this.last === null ? 0 : Math.max(0, Math.min(0.1, (now - this.last) / 1000));
    this.last = now;
    if (!running) {
      this.time = latest.time;
      this.started = false;
    } else {
      if (!this.started && latest.time - this.time >= this.delay) this.started = true;
      if (this.started) {
        if (this.time + delta > latest.time) this.stalls++;
        this.time = Math.min(latest.time, this.time + delta);
      }
    }
    while (this.frames.length > 2 && this.frames[1].time <= this.time) this.frames.shift();
    const a = this.frames[0],
      b = this.frames[1] || a;
    return {
      a,
      b,
      alpha:
        b.time > a.time ? Math.max(0, Math.min(1, (this.time - a.time) / (b.time - a.time))) : 0,
      lag: latest.time - this.time,
      time: this.time,
      stalls: this.stalls,
    };
  }
}
