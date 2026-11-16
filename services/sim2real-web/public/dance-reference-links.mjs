/** Offer vetted reference clips alongside the learner's terminal result. */
export function renderDanceReferenceLinks(document, run, sectionLabels) {
  const summary = document.getElementById('quality-summary');
  if (!summary) return;
  document.getElementById('dance-reference-links')?.remove();

  const evidence = run.metrics?.originmanDance;
  const config = run.training?.originmanDance ?? run.originmanDance ?? run.metrics?.danceConfig;
  let failedSections;
  if (run.status === 'completed' && (evidence?.qualityGatePassed ?? evidence?.qualityGate?.passed) === false) {
    failedSections = (evidence.evaluations ?? [])
      .flatMap(({ sections }) => sections ?? [])
      .filter((section) => section.passed === false || section.stylePassed === false || section.clean === false);
    if (!failedSections.length) failedSections = config?.sections;
  } else if (['failed', 'blocked'].includes(run.status) && run.taskId === 'originman-dance') {
    failedSections = config?.sections;
  }
  const types = [...new Set((failedSections ?? []).map(({ type }) => type))]
    .filter((type) => Object.hasOwn(sectionLabels, type));
  if (!types.length) return;

  const paragraph = document.createElement('p');
  paragraph.id = 'dance-reference-links';
  paragraph.append('对照官方参考回放：');
  for (const [index, type] of types.entries()) {
    if (index) paragraph.append(' · ');
    const link = document.createElement('a');
    link.href = './originman-dance-references/index.html#' + encodeURIComponent(type);
    link.textContent = sectionLabels[type];
    paragraph.append(link);
  }
  summary.after(paragraph);
}
