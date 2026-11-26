const WORKSHOP_ENGINE = 'originman-reference-ppo';
const LOAD_FRESH_MS = 30_000;

export function workshopWorkerReady(resource) {
  return resource?.source !== 'local-agent' && resource?.status === 'online' &&
    resource.mock === false && Array.isArray(resource.engines) && resource.engines.includes(WORKSHOP_ENGINE);
}

export function freshWorkshopWorkerLoad(resource, now = Date.now()) {
  if (!workshopWorkerReady(resource)) return null;
  const age = now - Date.parse(resource.lastCheckedAt ?? '');
  const { activeJobs, maxConcurrentJobs, queuedJobs } = resource;
  if (!(age >= 0 && age <= LOAD_FRESH_MS) || !Number.isInteger(maxConcurrentJobs) || maxConcurrentJobs < 1 ||
      !Number.isInteger(activeJobs) || activeJobs < 0 || activeJobs > maxConcurrentJobs ||
      !Number.isInteger(queuedJobs) || queuedJobs < 0) return null;
  return { activeJobs, maxConcurrentJobs, queuedJobs };
}

export function anotherWorkshopWorker(resources, originalId, now = Date.now()) {
  return resources
    .filter((value) => value?.id !== originalId &&
      (value?.cuda === true || (value?.classroomShared === true && value.cuda !== false)) &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value?.id ?? '') &&
      typeof value?.name === 'string' && value.name.trim())
    .map((resource) => ({ resource, load: freshWorkshopWorkerLoad(resource, now) }))
    .filter(({ load }) => load && load.queuedJobs === 0 && load.activeJobs < load.maxConcurrentJobs)
    .sort((a, b) => Number(b.resource.cuda === true) - Number(a.resource.cuda === true) ||
      (b.load.maxConcurrentJobs - b.load.activeJobs) - (a.load.maxConcurrentJobs - a.load.activeJobs) ||
      a.resource.name.localeCompare(b.resource.name, 'zh-CN'))[0]?.resource;
}
