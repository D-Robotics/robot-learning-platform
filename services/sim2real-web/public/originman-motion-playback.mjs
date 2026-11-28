/** Read-only playback of catalog simulations in the existing OriginMan viewer. */
export function mountMotionPlayback({ document, api }) {
  const panel = document.getElementById('motion-playback');
  if (!panel) return null;
  const win = document.defaultView;
  const canvas = panel.querySelector('canvas');
  const button = panel.querySelector('button');
  const range = panel.querySelector('input');
  const speed = panel.querySelector('select');
  const time = panel.querySelector('output');
  const status = panel.querySelector('[role=status]');
  const title = panel.querySelector('h3');
  const controls = panel.querySelector('.motion-playback-controls');
  let generation = 0;
  let controller;
  let renderer;
  let rendering;
  let sceneRequest;
  let animation;
  let clip;
  let samples;
  let position = 0;
  let previousTime = null;

  function reset() {
    generation++;
    controller?.abort();
    pause();
    renderer?.dispose();
    renderer = clip = samples = undefined;
    panel.hidden = canvas.hidden = controls.hidden = true;
    status.textContent = '';
  }

  function pause() {
    if (animation !== undefined) win.cancelAnimationFrame(animation);
    animation = undefined;
    previousTime = null;
    button.textContent = '播放';
  }

  function frameAt(index) {
    const { frames, fps, stride, bodyCount } = clip;
    const width = bodyCount * 7;
    return {
      time: Math.min(index * stride, frames - 1) / fps,
      bodies: samples.subarray(index * width, (index + 1) * width),
      force: [0, 0, 0],
    };
  }

  function seek(value) {
    const { frames, fps, stride, bodyCount } = clip;
    const duration = frames / fps;
    position = Math.max(0, Math.min(duration, value));
    const frame = Math.min(frames - 1, position * fps);
    const left = Math.floor(frame / stride);
    const right = Math.min(samples.length / (bodyCount * 7) - 1, left + 1);
    const a = frameAt(left);
    const b = frameAt(right);
    const alpha = b.time === a.time ? 0 : (frame / fps - a.time) / (b.time - a.time);
    renderer.showFrame(a, b, Math.max(0, Math.min(1, alpha)));
    range.value = String(position);
    time.textContent = position.toFixed(2) + ' / ' + duration.toFixed(2) + ' 秒';
  }

  function tick(now) {
    seek(position + (previousTime === null ? 0 : (now - previousTime) / 1000 * Number(speed.value)));
    previousTime = now;
    if (position >= clip.frames / clip.fps) pause();
    else animation = win.requestAnimationFrame(tick);
  }

  button.onclick = () => {
    if (!renderer || clip.method === 'pose') return;
    if (animation !== undefined) return pause();
    if (position >= clip.frames / clip.fps) seek(0);
    button.textContent = '暂停';
    animation = win.requestAnimationFrame(tick);
  };
  range.oninput = () => { if (renderer) seek(Number(range.value)); };

  function library() {
    if (win.OriginmanWebGL) return Promise.resolve(win.OriginmanWebGL);
    if (!rendering) rendering = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('./originman-webgl.js', win.location.href);
      script.onload = () => win.OriginmanWebGL ? resolve(win.OriginmanWebGL) : reject();
      script.onerror = reject;
      document.head.append(script);
    }).catch(() => {
      rendering = undefined;
      throw Error('三维组件暂时无法加载，可重新打开预览。');
    });
    return rendering;
  }

  async function open(selection) {
    reset();
    const current = generation;
    controller = new win.AbortController();
    panel.hidden = false;
    title.textContent = '仿真预览';
    status.textContent = '正在读取 OriginMan 模型和预览轨迹…';
    try {
      if (!sceneRequest) sceneRequest = api('originman-motion/visual-scene').catch((cause) => {
        sceneRequest = undefined;
        throw cause;
      });
      const [visual, scene, data] = await Promise.all([
        library(), sceneRequest,
        api('originman-motion/playback', selection, undefined, controller.signal),
      ]);
      if (generation !== current) return;
      const asset = data.playback;
      if (!visual.supported()) throw Error('当前浏览器无法显示三维预览。轨迹校验和训练仍可使用。');
      if (!asset || asset.sceneSha256 !== scene.sceneSha256 || asset.bodyCount !== scene.scene.bodyCount)
        throw Error('预览轨迹与仿真模型不一致。');
      const bytes = Uint8Array.from(win.atob(asset.samples), (character) => character.charCodeAt(0));
      const values = new Float32Array(bytes.buffer);
      if (values.length !== (Math.ceil((asset.frames - 1) / asset.stride) + 1) * asset.bodyCount * 7 ||
          !values.every(Number.isFinite)) throw Error('仿真预览帧不完整。');
      clip = asset;
      samples = values;
      renderer = visual.create(canvas, scene.scene, () => {}, () => {
        if (generation !== current) return;
        pause();
        controls.hidden = canvas.hidden = true;
        status.textContent = '三维画面已中断。请重新打开预览。';
      });
      // Front/side angles are local to the viewer and do not modify the clip.
      renderer.setCamera({ azimuth: 35, elevation: -14, distance: 0.94 });
      title.textContent = data.displayName + ' · 仿真预览';
      const metrics = clip.evaluation;
      status.textContent = clip.method === 'pose'
        ? '定格姿态。加入一个动态动作后可提交组合训练。'
        : '参考控制 · ' + (metrics?.completed ? '完整跑完' : '提前结束') +
          (metrics?.framesExpected ? ' · ' + metrics.framesEvaluated + '/' + metrics.framesExpected + ' 帧' : '') +
          (Number.isFinite(metrics?.maxTiltDeg) ? ' · 峰值倾角 ' + metrics.maxTiltDeg.toFixed(1) + '°' : '') +
          '。训练结果在对应 Run 查看。';
      canvas.hidden = false;
      controls.hidden = clip.method === 'pose';
      range.max = String(clip.frames / clip.fps);
      seek(0);
    } catch (cause) {
      if (generation === current) status.textContent = cause.message || '暂时无法打开仿真预览。';
    }
  }

  win.addEventListener('pagehide', reset);
  panel.querySelectorAll('[data-view-angle]').forEach((control) => {
    control.onclick = () => renderer?.setCamera({ azimuth: Number(control.dataset.viewAngle) });
  });
  return { open, reset };
}
