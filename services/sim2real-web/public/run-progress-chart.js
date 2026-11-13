// Shared renderer for the workbench and the standalone Run detail.
(() => {
  const CANVAS_TEXT_STYLE = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  const CANVAS_TEXT_COLOR = 'rgba(85, 86, 79, 0.95)';

  function clearCanvas(canvas, width, height) {
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.clearRect(0, 0, width, height);
    return ctx;
  }

  function drawCanvasPlaceholder(ctx, width, height, message) {
    ctx.fillStyle = CANVAS_TEXT_COLOR;
    ctx.font = CANVAS_TEXT_STYLE;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(message, width / 2, height / 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  const RUN_PROGRESS_CANVAS_W = 720;
  const RUN_PROGRESS_CANVAS_H = 200;

  function runProgressPoints(run) {
    if (!Array.isArray(run?.progress)) return [];
    return run.progress.filter(
      (point) =>
        point &&
        Number.isFinite(Number(point.iteration)) &&
        Number.isFinite(Number(point.meanReward)),
    ).map((point) => {
      if (run.training?.engine !== 'microduck-rl') return point;
      const { recentSuccess: _unmeasuredSuccess, ...measured } = point;
      return measured;
    });
  }

  function drawRunProgressChart(canvas, points, { title = '' } = {}) {
    const ctx = clearCanvas(canvas, RUN_PROGRESS_CANVAS_W, RUN_PROGRESS_CANVAS_H);
    if (!ctx) return false;
    const width = RUN_PROGRESS_CANVAS_W;
    const height = RUN_PROGRESS_CANVAS_H;
    if (!points.length) {
      drawCanvasPlaceholder(ctx, width, height, '暂无训练曲线数据');
      return false;
    }
    const plotLeft = 46;
    const plotRight = width - 40;
    const plotTop = 16;
    const plotBottom = height - 20;
    const plotWidth = plotRight - plotLeft;
    const plotHeight = plotBottom - plotTop;
    const lastTotal = points[points.length - 1].totalIterations || points[points.length - 1].iteration;
    const iterationMax = Math.max(lastTotal, points[points.length - 1].iteration);
    const rewards = points.map((point) => point.meanReward);
    let rewardMin = Math.min(0, ...rewards);
    let rewardMax = Math.max(0, ...rewards);
    if (rewardMin === rewardMax) rewardMax = rewardMin + 1;
    const rewardPad = (rewardMax - rewardMin) * 0.08;
    rewardMin -= rewardPad;
    rewardMax += rewardPad;
    const xOf = (iteration) => plotLeft + (iteration / (iterationMax || 1)) * plotWidth;
    const yReward = (reward) => plotBottom - ((reward - rewardMin) / (rewardMax - rewardMin)) * plotHeight;
    const ySuccess = (rate) => plotTop + (1 - Math.max(0, Math.min(1, rate))) * plotHeight;
    ctx.font = CANVAS_TEXT_STYLE;
    ctx.strokeStyle = 'rgba(28, 28, 26, 0.12)';
    ctx.lineWidth = 1;
    // Grid: reward ticks on the left, success ticks (0/50/100%) on the right.
    ctx.fillStyle = CANVAS_TEXT_COLOR;
    ctx.textAlign = 'right';
    for (const reward of [rewardMax, (rewardMax + rewardMin) / 2, rewardMin]) {
      const y = Math.round(yReward(reward)) + 0.5;
      if (y <= plotTop || y >= plotBottom) continue;
      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotRight, y);
      ctx.stroke();
      ctx.fillText(reward.toFixed(2), plotLeft - 4, y + 3);
    }
    ctx.textAlign = 'left';
    const hasSuccess = points.some((point) => point.recentSuccess != null && Number.isFinite(Number(point.recentSuccess)));
    for (const [rate, label] of (hasSuccess ? [[0, '0%'], [0.5, '50%'], [1, '100%']] : [])) {
      const y = Math.round(ySuccess(rate)) + 0.5;
      ctx.fillText(label, plotRight + 4, y + 3);
    }
    ctx.textAlign = 'right';
    ctx.fillText('iter 0', plotLeft, plotBottom + 12);
    ctx.fillText(String(iterationMax), plotRight, plotBottom + 12);
    ctx.textAlign = 'left';
    if (title) {
      ctx.fillStyle = CANVAS_TEXT_COLOR;
      ctx.fillText(title, plotLeft, plotTop - 4);
    }
    // Success rate line first (secondary), then reward on top (primary).
    ctx.strokeStyle = 'rgba(96, 165, 250, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let hasPreviousSuccess = false;
    points.forEach((point) => {
      if (point.recentSuccess == null || !Number.isFinite(Number(point.recentSuccess))) { hasPreviousSuccess = false; return; }
      const x = xOf(point.iteration);
      const y = ySuccess(point.recentSuccess);
      if (!hasPreviousSuccess) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      hasPreviousSuccess = true;
    });
    ctx.stroke();
    ctx.strokeStyle = 'rgba(85, 221, 176, 0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((point, index) => {
      const x = xOf(point.iteration);
      const y = yReward(point.meanReward);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    return true;
  }

  globalThis.RunProgressChart = { points: runProgressPoints, draw: drawRunProgressChart };
})();
