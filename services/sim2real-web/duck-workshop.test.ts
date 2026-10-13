import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const source = await readFile(new URL('./public/duck-workshop.js', import.meta.url), 'utf8');
const html = await readFile(new URL('./public/index.html', import.meta.url), 'utf8');
type Snapshot = Record<string, unknown>;
type Destination = { view: string; child?: string; module?: string };
type Step = { key: string; state: string; status: string; detail: string; action: string };
type WorkshopView = {
  visible: boolean;
  source: string;
  steps: Step[];
  next: { key: string; title: string; copy: string; action: string; disabled?: boolean };
};
type Workshop = {
  derive: (input?: Snapshot) => WorkshopView;
  render: (input?: Snapshot) => WorkshopView;
  setNavigate: (handler: (destination: Destination) => void) => void;
  experimentRecord: (input?: Snapshot) => Record<string, unknown>;
};

let dom: JSDOM;
let workshop: Workshop;
let document: Document;
let navigate: ReturnType<typeof vi.fn>;
let fetch: ReturnType<typeof vi.fn>;

const run = {
  id: 'run-walk',
  modelId: 'model-walk',
  backend: 'local',
  status: 'completed',
  mock: false,
  metrics: { engine: 'microduck-rl' },
};
const base = {
  productId: 'microduck',
  loaded: true,
  model: { id: 'model-walk', builtin: false },
  device: { id: 'duck-one', name: '第一组机器人鸭' },
  run,
  releaseEvidenceReady: true,
};
const passed = { ...base, run: { ...run, taskEvaluation: { qualityGate: { passed: true } } } };
const deployment = {
  modelId: 'model-walk',
  deviceId: 'duck-one',
  mode: 'live',
  status: 'completed',
  executedAt: '2026-10-13T00:00:00Z',
  verification: { passed: true, mock: false },
};

beforeEach(() => {
  // Use the actual page so default disclosure state and DOM wiring are covered.
  // Only the guide is evaluated: the full app and external scripts stay inert.
  dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  fetch = vi.fn();
  dom.window.fetch = fetch;
  dom.window.eval(source);
  workshop = (dom.window as unknown as { DuckWorkshop: Workshop }).DuckWorkshop;
  document = dom.window.document;
  navigate = vi.fn();
  workshop.setNavigate(navigate);
});

afterEach(() => {
  dom.window.close();
  vi.restoreAllMocks();
});

function step(input: Snapshot, key: string) {
  const found = workshop.derive(input).steps.find((item) => item.key === key);
  if (!found) throw new Error(`Missing workshop step: ${key}`);
  return found;
}

function button(selector: string) {
  const found = document.querySelector<HTMLButtonElement>(selector);
  if (!found) throw new Error(`Missing workshop button: ${selector}`);
  return found;
}

describe('duck workshop evidence', () => {
  it('keeps unknown or prebuilt origin distinct from an explicitly non-mock run', () => {
    expect(
      workshop.experimentRecord({ model: { id: 'reference', builtin: true } }).provenance,
    ).toMatchObject({
      preset: true,
      mock: null,
      source: 'prebuilt-reference',
      physicalMotionVerified: false,
    });
    expect(
      workshop.experimentRecord({ model: base.model, run: { ...run, mock: undefined } }).provenance,
    ).toMatchObject({ mock: null });
    expect(
      workshop.experimentRecord({
        model: base.model,
        run: { ...run, evaluation: { replay: { source: 'demo-fixture' } } },
      }).provenance,
    ).toMatchObject({ mock: true, source: 'demo-fixture' });
  });

  it('refuses an explicitly different project run even when its model matches', () => {
    const record = workshop.experimentRecord({
      project: { id: 'my-project' },
      model: base.model,
      run: { ...run, projectId: 'other-project' },
      device: base.device,
      deployments: [{ ...deployment, projectId: 'other-project' }],
    });
    expect(record.run).toBeNull();
    expect(record.deployments).toEqual([]);
    expect(record.evidenceReferences).toEqual({});
  });

  it('keeps unrelated or unattributed deployment history out of a selected project export', () => {
    const record = workshop.experimentRecord({
      project: { id: 'my-project' },
      model: base.model,
      device: base.device,
      run: { ...run, projectId: 'my-project' },
      deployments: [
        { ...deployment, id: 'other-project', projectId: 'other-project', runId: run.id },
        { ...deployment, id: 'unattributed', runId: 'another-run' },
      ],
    });
    expect(record.deployments).toEqual([]);
    expect(record.projectAttribution).toMatchObject({ excludedUnattributedDeployments: 1 });
    const legacy = workshop.experimentRecord({
      project: { id: 'my-project' },
      model: base.model,
      device: base.device,
      run,
    });
    expect(legacy.run).toBeNull();
    expect(legacy.projectAttribution).toMatchObject({ excludedLegacyRun: true });
  });

  it('retains a legacy deployment only through a run explicitly attributed to the selected project', () => {
    const record = workshop.experimentRecord({
      project: { id: 'my-project' },
      model: base.model,
      device: base.device,
      run: { ...run, projectId: 'my-project' },
      deployments: [{ ...deployment, id: 'matched-legacy', runId: run.id }],
    });
    expect(record.deployments).toEqual([
      expect.objectContaining({ id: 'matched-legacy', projectAttribution: 'matched-project-run' }),
    ]);
  });
  it('records real walking training but still requests model evaluation', () => {
    expect(step(base, 'train').state).toBe('recorded');
    expect(step(base, 'evaluate').state).not.toBe('recorded');
    expect(workshop.derive(base).next.action).toBe('evaluate');
    expect(workshop.derive(base).source).toBe('本次行走训练成果');
  });

  it('keeps reference, mock, synthetic and other-engine runs out of walking completion', () => {
    for (const input of [
      { ...base, run: { ...run, backend: 'browser' } },
      { ...base, run: { ...run, mock: true } },
      { ...base, telemetry: { source: 'demo-fixture' } },
      { ...base, run: { ...run, metrics: { engine: 'starter-ppo' } } },
    ]) {
      expect(step(input, 'train').state).not.toBe('recorded');
      expect(step(input, 'evaluate').state).not.toBe('recorded');
    }
    expect(
      workshop.derive({ ...base, run: null, model: { id: 'reference', builtin: true } }).source,
    ).toBe('预置参考模型');
  });

  it('does not use another model run to recommend deployment of the selected model', () => {
    const input = { ...passed, run: { ...passed.run, modelId: 'another-model' } };
    expect(step(input, 'train').state).not.toBe('recorded');
    expect(step(input, 'evaluate').state).not.toBe('recorded');
    expect(workshop.derive(input).next.action).toBe('configure');
  });

  it('requires both trusted release evidence and a passing quality gate for model acceptance', () => {
    expect(step(passed, 'evaluate').state).toBe('recorded');
    for (const input of [
      { ...passed, releaseEvidenceReady: false },
      { ...passed, run: { ...run, taskEvaluation: { qualityGate: { passed: false } } } },
      { ...passed, run: { ...run, taskEvaluation: { qualityGate: { passed: 'true' } } } },
    ])
      expect(step(input, 'evaluate').state).not.toBe('recorded');
  });

  it('isolates actual deployment records by both model and selected device', () => {
    expect(step({ ...passed, deployments: [deployment] }, 'deploy').state).toBe('recorded');
    for (const patch of [{ deviceId: 'duck-two' }, { modelId: 'another-model' }]) {
      expect(
        step({ ...passed, deployments: [{ ...deployment, ...patch }] }, 'deploy').state,
      ).not.toBe('recorded');
    }
  });

  it('never turns preflight, approval or mock verification into an actual model delivery', () => {
    for (const patch of [
      { mode: 'preflight' },
      { status: 'ready', approval: { status: 'approved' } },
      { executedAt: null },
      { verification: { passed: true, mock: true } },
    ])
      expect(
        step({ ...passed, deployments: [{ ...deployment, ...patch }] }, 'deploy').state,
      ).not.toBe('recorded');
  });

  it('keeps calibration, follow and physical walking pending after software deployment', () => {
    const input = { ...passed, deployments: [deployment] };
    for (const key of ['calibration', 'trial', 'follow']) {
      expect(step(input, key).state).toBe('pending');
    }
    expect(step(input, 'calibration').status).toBe('待只读检查');
    expect(step(input, 'follow').status).toBe('待接通');
    expect(step(input, 'trial').detail).toContain('不代表站立已验证或舵机断电');
  });

  it('asks to recover an unknown job before retrying instead of resubmitting it', () => {
    const input = { ...base, run: { ...run, status: 'unknown' } };
    const view = workshop.derive(input);
    expect(view.next.action).toBe('train');
    expect(view.next.title).toContain('找回');
    expect(view.next.copy).toContain('确认已结束后再重试');
    expect(step(input, 'train').detail).toContain('确认原任务已经结束后再重试');
  });
});

describe('duck workshop disclosure and navigation', () => {
  it('stays collapsed after initial render and keeps the existing three first-use goals', () => {
    workshop.render(base);
    const panel = document.getElementById('duck-workshop') as HTMLDetailsElement;
    expect(panel.hidden).toBe(false);
    expect(panel.open).toBe(false);
    expect(document.querySelectorAll('[data-start-intent]')).toHaveLength(3);
    expect(fetch).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('changes step detail without a request, device action or navigation', () => {
    workshop.render(base);
    button('[data-duck-step="follow"]').click();
    expect(document.getElementById('duck-workshop-detail-title')?.textContent).toContain('待接通');
    expect(button('[data-duck-step="follow"]').getAttribute('aria-pressed')).toBe('true');
    expect(navigate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('opens the existing policy page on an explicit detail action without starting movement', () => {
    workshop.render(base);
    button('[data-duck-step="trial"]').click();
    button('#duck-workshop-detail-button').click();
    expect(navigate).toHaveBeenCalledExactlyOnceWith({ view: 'station', module: 'policy' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps selection on a background refresh and resets it when the chosen device changes', () => {
    workshop.render(base);
    button('[data-duck-step="follow"]').click();
    workshop.render(base);
    expect(button('[data-duck-step="follow"]').getAttribute('aria-pressed')).toBe('true');
    workshop.render({ ...base, device: { id: 'duck-two' } });
    expect(button('[data-duck-step="follow"]').getAttribute('aria-pressed')).toBe('false');
    expect(button('[data-duck-step="evaluate"]').getAttribute('aria-pressed')).toBe('true');
  });

  it('hides other products and leaves loading actions disabled', () => {
    workshop.render({ ...base, productId: 'originbot' });
    expect(document.getElementById('duck-workshop')?.hidden).toBe(true);
    workshop.render({ productId: 'microduck', loaded: false });
    expect(button('#duck-workshop-next-button').disabled).toBe(true);
    button('#duck-workshop-next-button').click();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('routes failed training to the existing Run log instead of triggering another job', () => {
    workshop.render({ ...base, run: { ...run, status: 'failed' } });
    button('#duck-workshop-next-button').click();
    expect(navigate).toHaveBeenCalledExactlyOnceWith({ view: 'train', child: 'submit' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
