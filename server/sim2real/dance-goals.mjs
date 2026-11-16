import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  createDanceGoalContinuation,
  createDanceIteration,
  matchesDanceIterationGpu,
} from '../../plugins/rdk-robot-learning-platform/scripts/dance-iteration.mjs';
import {
  acceptDanceSimulation,
  createDanceEvaluationReader,
} from '../../plugins/rdk-robot-learning-platform/scripts/dance-evaluation.mjs';
import {
  canonicalDanceConfig,
  trainOriginmanDance,
} from '../../plugins/rdk-robot-learning-platform/scripts/dance-training.mjs';
import { openTrainingGoalJournal } from '../../plugins/rdk-robot-learning-platform/scripts/submission-journal.mjs';

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,23}$/;
const ledgerAudience = 'http://127.0.0.1';
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function danceGoalDraft(input) {
  if (
    !input ||
    !Object.keys(input).every((key) =>
      ['contextId', 'dance', 'computeResourceId', 'modelId', 'totalSteps'].includes(key),
    ) ||
    !safeId.test(input.contextId ?? '') ||
    !/^[a-f0-9-]{8,100}$/i.test(input.computeResourceId ?? '') ||
    (input.modelId !== undefined && !/^[a-zA-Z0-9._-]{1,160}$/.test(input.modelId)) ||
    !Number.isSafeInteger(input.totalSteps) ||
    input.totalSteps < 8192 ||
    input.totalSteps > 2_000_000 ||
    !input.dance ||
    input.dance.trainingSteps !== undefined
  )
    throw Error('请提供 4090 资源、舞蹈目标和 8,192–2,000,000 步总预算。');
  const { trainingSteps: _trainingSteps, ...dance } = canonicalDanceConfig(input.dance);
  return {
    contextId: input.contextId,
    goal: 'dance-quality-gate',
    computeResourceId: input.computeResourceId,
    ...(input.modelId && { modelId: input.modelId }),
    totalSteps: input.totalSteps,
    dance,
  };
}

function samePlanKey(args) {
  const { title: _title, ...dance } = args.dance;
  return sha([args.computeResourceId, args.modelId, args.totalSteps, dance]);
}

/** A short, one-request internal capability. Browser credentials never enter the background ledger. */
function backgroundConnection(callerAuth, prefix, port) {
  const permits = new Map();
  const resolved = new WeakMap();
  const authorize = (request) => {
    if (resolved.has(request)) return resolved.get(request);
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket?.remoteAddress);
    const token = request.headers['x-rdk-dance-goal-permit'];
    const allowed = local && typeof token === 'string' ? permits.get(token) : null;
    if (!allowed || allowed.path !== request.path || allowed.method !== request.method) return null;
    permits.delete(token);
    resolved.set(request, allowed.principal);
    return allowed.principal;
  };
  return {
    auth: {
      ...callerAuth,
      resolvePrincipal: (request) => authorize(request) ?? callerAuth.resolvePrincipal(request),
    },
    request: async (principal, method, suffix, { body, signal, idempotencyKey } = {}) => {
      const route = prefix + suffix;
      const token = randomUUID();
      permits.set(token, { principal, method, path: route });
      try {
        const response = await fetch('http://127.0.0.1:' + port() + route, {
          method,
          headers: {
            accept: 'application/json',
            'x-rdk-dance-goal-permit': token,
            ...(body && { 'content-type': 'application/json' }),
            ...(idempotencyKey && { 'idempotency-key': idempotencyKey }),
          },
          ...(body && { body: JSON.stringify(body) }),
          signal: AbortSignal.any([AbortSignal.timeout(65_000), ...(signal ? [signal] : [])]),
          redirect: 'error',
        });
        const payload = await response.json();
        if (response.status === 404 && suffix.endsWith('/dance-evaluation') && method === 'GET')
          return null;
        if (!response.ok || payload?.ok !== true)
          throw Object.assign(Error(payload.message ?? '平台请求受阻。'), {
            httpStatus: response.status,
          });
        return payload;
      } finally {
        permits.delete(token);
      }
    },
  };
}

function roundDelivery(run) {
  const evidence = run.metrics?.originmanDance;
  const policy = run.artifact?.sha256;
  const valid = (value) => /^[a-f0-9]{64}$/.test(value ?? '');
  return {
    policy: run.artifact?.format === 'onnx' && valid(policy) ? 'available' : 'unavailable',
    replay:
      valid(evidence?.video?.sha256) &&
      valid(evidence?.replay?.sha256) &&
      evidence.video.policySha256 === policy &&
      evidence.video.sourceReplaySha256 === evidence.replay.sha256
        ? 'simulation'
        : 'unavailable',
  };
}

function danceClient(principal, request, goalId) {
  const read = (method, suffix, options) => request(principal, method, suffix, options);
  const evaluationPath = (runId) => '/runs/' + encodeURIComponent(runId) + '/dance-evaluation';
  const evaluator = createDanceEvaluationReader({
    readDanceEvaluationRun: async (id, options) =>
      (await read('GET', evaluationPath(id), options))?.evaluation,
    evaluateDanceRun: async (id, options) =>
      (await read('POST', evaluationPath(id), options)).evaluation,
  });
  return {
    accept: async (runId, signal) => {
      const { run } = await read('GET', '/runs/' + encodeURIComponent(runId), { signal });
      if (run?.id !== runId) throw Error('平台未确认原训练记录。');
      if (['queued', 'running', 'pending'].includes(run.status))
        return {
          run,
          simulationAcceptance: {
            state: 'waiting',
            reason: run.status === 'running' ? '正在训练。' : '等待算力开始训练。',
          },
        };
      if (run.status !== 'completed')
        return {
          run,
          simulationAcceptance: { state: 'unverified', reason: '本轮训练未完成，已保留训练记录。' },
        };
      try {
        return {
          run,
          simulationAcceptance: await acceptDanceSimulation(run, {
            upstream: { evaluateDanceRun: evaluator },
            signal,
          }),
          runDelivery: roundDelivery(run),
        };
      } catch (error) {
        if (error.code !== 'DANCE_EVALUATION_PENDING') throw error;
        return { run, simulationAcceptance: { state: 'waiting', reason: error.message } };
      }
    },
    call: async (name, args, signal) => {
      switch (name) {
        case 'rdk_model_validate':
          return (await read('POST', '/models/validate', { body: args, signal })).validation;
        case 'rdk_models_list':
          return read('GET', '/models', { signal });
        case 'rdk_model_register': {
          const payload = await read('POST', '/models', {
            body: { manifest: args.manifest },
            signal,
          });
          return { ...payload.model, contractId: payload.contractId };
        }
        case 'rdk_compute_resources_list':
          return read('GET', '/compute-resources', { signal });
        case 'rdk_compute_resource_test': {
          const payload = await read(
            'POST',
            '/compute-resources/' + encodeURIComponent(args.computeResourceId) + '/test',
            { signal },
          );
          return {
            ...payload.computeResource,
            connected: payload.connected,
            browserRelay: payload.browserRelay,
          };
        }
        case 'rdk_training_submit': {
          const {
            modelId,
            computeResourceId,
            backend,
            taskId,
            label,
            idempotencyKey,
            profile,
            engine,
            algorithm,
            numEnvs,
            maxIterations,
            video,
            originmanDance,
          } = args;
          const body = {
            modelId,
            computeResourceId,
            backend,
            taskId,
            label,
            experimentId: goalId,
            requestedVia: 'agent',
            training: { profile, engine, algorithm, numEnvs, maxIterations, video, originmanDance },
          };
          const payload = await read('POST', '/runs', { body, signal, idempotencyKey });
          return { runId: payload.run?.id };
        }
        default:
          throw Error('自动迭代没有此操作。');
      }
    },
  };
}

const platformSchedulers = new WeakMap();

export function setupDanceGoals(options) {
  const { callerAuth, storageDirectory, defaultPort } = options;
  let schedulers = platformSchedulers.get(callerAuth);
  if (!schedulers) platformSchedulers.set(callerAuth, (schedulers = new Map()));
  const key = path.resolve(storageDirectory) + ':' + defaultPort;
  if (!schedulers.has(key)) schedulers.set(key, createDanceGoals(options));
  return schedulers.get(key);
}

function createDanceGoals({ callerAuth, prefix, storageDirectory, defaultPort, findRun }) {
  const directory = path.join(storageDirectory, 'dance-goals');
  const drafts = path.join(directory, 'drafts');
  const journalDirectory = path.join(directory, 'progress');
  let listeningPort = defaultPort;
  let recoveryScheduled = false;
  const { auth, request } = backgroundConnection(callerAuth, prefix, () => listeningPort);
  const drivers = new Map();
  const keyFor = (owner, contextId) => sha([owner, contextId]);
  const journalFor = ({ principal, args }) =>
    openTrainingGoalJournal({
      account: principal.accountId,
      audience: ledgerAudience,
      contextId: args.contextId,
      directory: journalDirectory,
    });
  const records = (owner) => {
    if (!fs.existsSync(drafts)) return [];
    return fs
      .readdirSync(drafts)
      .filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
      .flatMap((file) => {
        try {
          const item = JSON.parse(fs.readFileSync(path.join(drafts, file), 'utf8'));
          return owner === undefined || item.principal.accountId === owner ? [item] : [];
        } catch (error) {
          console.warn('[dance-goals] unreadable draft', file, error.code ?? 'invalid');
          return [];
        }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  };
  const snapshot = (record) => ({
    id: record.args.contextId,
    createdAt: record.createdAt,
    goal: record.args.dance,
    ...(journalFor(record).progress() ?? {
      state: 'waiting',
      reason: '正在准备首轮训练。',
      rounds: [],
      spentSteps: 0,
      additionalSteps: record.args.totalSteps,
      remainingSteps: record.args.totalSteps,
      accelerator: 'RTX 4090',
      numEnvs: 64,
    }),
  });
  const start = (record) => {
    const { principal, args } = record;
    const key = keyFor(principal.accountId, args.contextId);
    if (drivers.has(key) || snapshot(record).state !== 'waiting') return;
    const account = async () => principal.accountId;
    const client = danceClient(principal, request, args.contextId);
    const iteration = createDanceIteration({
      account,
      baseUrl: ledgerAudience,
      contextDirectory: journalDirectory,
      accept: client.accept,
      recover: async (contextId) => {
        const existing = await findRun(
          contextId + '-train',
          callerAuth.isMultiUserDeployment() ? principal.accountId : undefined,
        );
        if (!existing) return null;
        if (
          existing.run.experimentId !== args.contextId ||
          existing.run.taskId !== 'originman-dance'
        )
          throw Error('训练回执与原平台实验的归属不一致。');
        return { submission: { runId: existing.run.id } };
      },
      submit: (input, signal) =>
        trainOriginmanDance(input, (name, params) => client.call(name, params, signal), {
          serverIdempotency: true,
          acceptWorker: matchesDanceIterationGpu,
        }),
    });
    const drive = createDanceGoalContinuation({
      account,
      baseUrl: ledgerAudience,
      contextDirectory: journalDirectory,
      iterate: iteration,
      pollMs: 0,
    });
    const tick = async () => {
      try {
        const result = await drive({ resumeContextId: args.contextId });
        if (result.iteration.state !== 'waiting') {
          clearInterval(timer);
          drivers.delete(key);
        }
      } catch {
        clearInterval(timer);
        drivers.delete(key);
        journalFor(record).save({
          ...snapshot(record),
          state: 'blocked',
          reason: '平台暂时无法继续原实验。已保留训练记录和预算。',
        });
      }
    };
    journalFor(record).register(args);
    const timer = setInterval(() => void tick(), 3500);
    timer.unref();
    drivers.set(key, timer);
    void tick();
  };

  return {
    auth,
    register(router, readOwner, wrap, mount = prefix) {
      const endpoint = mount + '/dance-goals';
      router.post(
        endpoint,
        wrap(async (req, res) => {
          res.setHeader('Cache-Control', 'no-store');
          const owner = readOwner(req, res);
          if (owner === null) return;
          const principal = {
            accountId: owner ?? 'local-dev',
            ...(callerAuth.resolvePrincipal(req)?.roles && {
              roles: callerAuth.resolvePrincipal(req).roles,
            }),
          };
          let args;
          try {
            args = danceGoalDraft(req.body);
          } catch (error) {
            return res.status(400).json({ ok: false, message: error.message });
          }
          if (req.socket.localPort) listeningPort = req.socket.localPort;
          const existing = records(principal.accountId);
          let record = existing.find((item) => item.args.contextId === args.contextId);
          const fingerprint = samePlanKey(args);
          if (record && fingerprint !== record.fingerprint)
            return res.status(409).json({ ok: false, message: '此实验已绑定另一份目标或预算。' });
          record ??= existing.find(
            (item) => item.fingerprint === fingerprint && snapshot(item).state === 'waiting',
          );
          const reused = Boolean(record);
          if (!record) {
            fs.mkdirSync(drafts, { recursive: true, mode: 0o700 });
            record = { principal, args, fingerprint, createdAt: new Date().toISOString() };
            const file = path.join(drafts, keyFor(principal.accountId, args.contextId) + '.json');
            const temporary = file + '.' + randomUUID();
            try {
              fs.writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
              fs.linkSync(temporary, file);
            } finally {
              fs.rmSync(temporary, { force: true });
            }
          }
          start(record);
          return res.status(reused ? 200 : 202).json({ ok: true, goal: snapshot(record) });
        }),
      );
      router.get(
        endpoint,
        wrap(async (req, res) => {
          res.setHeader('Cache-Control', 'no-store');
          const owner = readOwner(req, res);
          if (owner === null) return;
          res.json({
            ok: true,
            goals: records(owner ?? 'local-dev')
              .slice(0, 15)
              .map(snapshot),
          });
        }),
      );
      router.get(
        endpoint + '/:id',
        wrap(async (req, res) => {
          res.setHeader('Cache-Control', 'no-store');
          const owner = readOwner(req, res);
          if (owner === null) return;
          const record =
            safeId.test(req.params.id) &&
            records(owner ?? 'local-dev').find((item) => item.args.contextId === req.params.id);
          if (!record)
            return res.status(404).json({ ok: false, message: '当前账号找不到这组自动迭代。' });
          return res.json({ ok: true, goal: snapshot(record) });
        }),
      );
      if (!recoveryScheduled) {
        recoveryScheduled = true;
        const recover = () => records().forEach(start);
        // The HTTP listener may still be binding when the router is constructed.
        setTimeout(recover, 4000).unref();
      }
    },
  };
}
