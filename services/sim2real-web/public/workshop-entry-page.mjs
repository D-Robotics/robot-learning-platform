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

  const video = document.getElementById('dance-reference-video');
  const error = document.getElementById('dance-reference-error');
  if (!video || !error) return;
  const updateVideoStatus = () => { error.hidden = !video.error; };
  video.addEventListener('error', updateVideoStatus);
  video.addEventListener('loadedmetadata', updateVideoStatus);
  updateVideoStatus();
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
  else showWorkshopEntry(document, window.location.href);
}
