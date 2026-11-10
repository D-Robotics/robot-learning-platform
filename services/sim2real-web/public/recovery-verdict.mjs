/** A legacy workbench summary uses the same case-level definition as Workshop. */
export function recoveryVerdict(cases, referenceMode, clearGain, tunedAvailable) {
  const prefix = referenceMode ? '课前结果，非本组成绩。' : '';
  if (!Array.isArray(cases) || !cases.length || cases.some(c => !Number.isFinite(c.force) ||
      !['original', 'tuned', 'rl'].every(k => typeof c[k] === 'boolean')))
    return prefix + '受扰恢复尚未验证：逐条条件记录不完整，不能用整体通过数代替。';
  const pushed = cases.filter(c => c.force !== 0), standing = cases.filter(c => c.force === 0);
  const counts = rows => ['original', 'tuned', 'rl'].map(k => rows.filter(c => c[k]).length);
  const p = counts(pushed), s = counts(standing);
  return prefix + `受扰恢复：原 PD ${p[0]}/${pushed.length}，` +
    (tunedAvailable ? `调参反馈 ${p[1]}/${pushed.length}，` : '尚无调参反馈对照，') +
    `RL ${p[2]}/${pushed.length}。无扰站立：原 PD ${s[0]}/${standing.length}，` +
    (tunedAvailable ? `调参反馈 ${s[1]}/${standing.length}，` : '') +
    `RL ${s[2]}/${standing.length}（不计入受扰恢复）。` +
    (clearGain === true ? '本条件集达到改善判据。' : clearGain === false ? '本条件集未达到改善判据，保留并分析。' : '效果判据尚未核对。') +
    '全部条件仍保留；仅仿真，不代表真机成功率。';
}
