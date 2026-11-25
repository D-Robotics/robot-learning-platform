export function showWorkshopEntry(document, url) {
  const { searchParams } = new URL(url);
  const computeResourceId = searchParams.get('computeResourceId');
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(computeResourceId ?? '')) {
    for (const id of ['dance-budget-quick', 'dance-budget-formal']) {
      const link = document.getElementById(id);
      const destination = new URL(link.getAttribute('href'), url);
      destination.searchParams.set('computeResourceId', computeResourceId);
      link.href = destination.href;
    }
  }
}

export function workshopRedirect(url) {
  const target = new URL(url);
  const context = target.searchParams.get('context');
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(context ?? '')) {
    const record = new URL('./experiment.html', target);
    record.searchParams.set('context', context);
    return record.href;
  }
  if (target.searchParams.has('context') || target.searchParams.has('setup') || target.searchParams.get('course') === 'recovery') {
    target.searchParams.delete('context');
    target.searchParams.delete('setup');
    target.searchParams.set('course', 'dance');
    return target.href;
  }
  return null;
}

if (typeof window !== 'undefined') {
  const redirect = workshopRedirect(window.location.href);
  if (redirect) window.location.replace(redirect);
  else {
    showWorkshopEntry(document, window.location.href);
    mountDanceReference(document, window);
  }
}

export function mountDanceReference(document, window) {
  const canvas = document.getElementById('dance-reference-canvas');
  const play = document.getElementById('dance-reference-play');
  const stop = document.getElementById('dance-reference-stop');
  const status = document.getElementById('dance-reference-status');
  const context = canvas?.getContext('2d');
  if (!context || !play || !stop || !status) return;

  const secondsPerBeat = 60 / 100;
  const beats = 8;
  let animation = 0;
  let started = 0;
  const theme = window.getComputedStyle(canvas);
  const paint = (position) => {
    const swing = Math.cos(Math.PI * position);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.lineWidth = 7;
    context.lineCap = 'round';
    const path = (points, token) => {
      context.strokeStyle = theme.getPropertyValue(token).trim();
      context.beginPath();
      context.moveTo(...points[0]);
      for (const point of points.slice(1)) context.lineTo(...point);
      context.stroke();
    };
    context.strokeStyle = theme.getPropertyValue('--text').trim();
    context.beginPath();
    context.arc(320, 42, 18, 0, 2 * Math.PI);
    context.stroke();
    path([[320, 60], [320, 143], [320, 152]], '--text');
    path([[269, 92], [371, 92]], '--text');
    path([[320, 145], [289, 164], [269, 208], [252, 211]], '--text');
    path([[320, 145], [351, 164], [371, 208], [388, 211]], '--text');
    path([[269, 92], [225 + 19 * swing, 123 - 17 * swing], [190 + 33 * swing, 155 - 34 * swing]], '--accent');
    path([[371, 92], [415 + 19 * swing, 123 + 17 * swing], [450 + 33 * swing, 155 + 34 * swing]], '--text');
    for (let index = 0; index < beats; index++) {
      const x = 159 + 46 * index;
      path([[x, 241], [x + 21, 241]], index <= Math.floor(position) ? '--accent' : '--line');
    }
  };
  const reset = (message) => {
    window.cancelAnimationFrame(animation);
    animation = 0;
    stop.disabled = true;
    status.textContent = message;
  };
  const animate = (now) => {
    const position = (now - started) / 1000 / secondsPerBeat;
    paint(Math.min(position, beats));
    if (position < beats) animation = window.requestAnimationFrame(animate);
    else reset('已播完 8 拍。');
  };
  play.addEventListener('click', () => {
    reset('正在播放 8 拍示意。');
    started = window.performance.now();
    stop.disabled = false;
    animation = window.requestAnimationFrame(animate);
  });
  stop.addEventListener('click', () => reset('已停止。'));
  window.addEventListener('pagehide', () => window.cancelAnimationFrame(animation), { once: true });
  canvas.hidden = false;
  play.hidden = false;
  stop.hidden = false;
  stop.disabled = true;
  paint(0);
}
