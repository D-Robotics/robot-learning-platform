/* Browser transport for local-agent runs. The worker owns training; closing
 * the page only stops this transport. Durable platform runs resume on reopen. */
(function (root) {
  'use strict';
  const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

  function relayError(message, status = 0) {
    return Object.assign(new Error(message), { status });
  }

  function retryable(error) {
    const status = Number(error?.status || 0);
    return status === 0 || status === 408 || status === 429 || status >= 500;
  }

  function create(options) {
    const fetchImpl = options.fetch;
    const schedule = options.schedule || root.setTimeout.bind(root);
    const cancel = options.cancel || root.clearTimeout.bind(root);
    const jobs = new Map();
    const pollMs = options.pollMs ?? 5000;
    const maxFailures = options.maxFailures ?? 6;
    let owner = null;

    function current(job) {
      return owner === job.owner && jobs.get(job.run.id) === job && !job.abort.signal.aborted;
    }

    function check(job) {
      if (!current(job)) throw relayError('训练中继账号已切换', 401);
    }

    async function bounded(job, timeoutMs, work) {
      check(job);
      const controller = new root.AbortController();
      const abort = () => controller.abort();
      job.abort.signal.addEventListener('abort', abort, { once: true });
      const timer = schedule(abort, timeoutMs);
      try {
        const result = await work(controller.signal);
        check(job);
        return result;
      } finally {
        cancel(timer);
        job.abort.signal.removeEventListener('abort', abort);
      }
    }

    async function worker(job, suffix, init = {}, binary = false) {
      return bounded(job, binary ? 60_000 : 30_000, async (signal) => {
        const response = await fetchImpl(job.agentUrl + suffix, {
          ...init,
          signal,
          headers: { 'x-sim2real-account': job.owner, ...init.headers },
        });
        if (binary) {
          if (!response.ok) throw relayError('训练制品下载失败', response.status);
          const declaredHeader = response.headers.get('content-length');
          const declared = declaredHeader === null ? null : Number(declaredHeader);
          if (declared !== null && (!Number.isSafeInteger(declared) || declared <= 0 || declared > MAX_ARTIFACT_BYTES)) {
            await response.body?.cancel().catch(() => {});
            throw relayError('训练制品为空或超过 50 MiB', 413);
          }
          if (!response.body) throw relayError('训练制品下载没有返回数据流', 502);
          const reader = response.body.getReader();
          const chunks = [];
          let total = 0;
          let complete = false;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) { complete = true; break; }
              total += value.byteLength;
              if (total > MAX_ARTIFACT_BYTES) throw relayError('训练制品超过 50 MiB', 413);
              chunks.push(value);
            }
          } finally {
            if (!complete) await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
          if (!total) throw relayError('训练制品为空', 422);
          if (declared !== null && total !== declared) throw relayError('训练制品下载不完整', 502);
          const bytes = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          return bytes;
        }
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw relayError(payload?.message || payload?.error || '本机 Agent 暂不可用', response.status);
        if (!payload) throw relayError('本机 Agent 返回了无效状态', 502);
        return payload;
      });
    }

    function platform(job, suffix, body, headers) {
      return bounded(job, 60_000, (signal) => options.request(
        '/sim2real/runs/' + encodeURIComponent(job.run.id) + suffix,
        { method: body === undefined ? 'GET' : 'POST', signal, ...(body === undefined ? {} : { body: headers ? body : JSON.stringify(body) }), ...(headers ? { headers } : {}) },
      ));
    }

    async function step(job) {
      if (!job.externalRunId) {
        const manifest = job.model?.manifest;
        if (!manifest) throw relayError('运行对应的模型契约不可用，请重新连接工作区', 404);
        // The platform reservation is durable. Deriving the worker key from it
        // keeps a lost submit/claim response or a reopened tab from starting a
        // second training job. Always use the saved normalized training spec.
        const idempotencyKey = 'relay-' + job.run.id;
        const payload = {
          accountId: job.owner, schemaVersion: manifest.schemaVersion,
          contractId: manifest.contract.id,
          model: { modelId: manifest.modelId, displayName: manifest.displayName, version: manifest.version },
          robot: manifest.robot, contract: manifest.contract,
          simulator: manifest.simulator, artifacts: manifest.artifacts,
          ...(job.run.taskId ? { taskId: job.run.taskId } : {}),
          ...(job.run.training ? { training: job.run.training } : {}),
          ...(job.run.resumeFrom ? { resumeFrom: job.run.resumeFrom } : {}),
          idempotencyKey,
        };
        const submitted = await worker(job, '/train', {
          method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey }, body: JSON.stringify(payload),
        });
        if (!submitted.runId) throw relayError('本机 Agent 未返回运行编号', 502);
        job.externalRunId = String(submitted.runId);
      }
      if (!job.claimed) {
        try {
          await platform(job, '/relay/claim', { externalRunId: job.externalRunId });
        } catch (error) {
          if (error.status !== 409) throw error;
          // Another tab (or our successful request whose response was lost)
          // may already have claimed it. Only resume the exact same worker id.
          const existing = await platform(job, '');
          if (existing?.run?.externalRunId !== job.externalRunId) throw error;
        }
        job.claimed = true;
      }
      const status = await worker(job, '/runs/' + encodeURIComponent(job.externalRunId));
      if (!['queued', 'running', 'completed', 'failed'].includes(status.status)) throw relayError('本机 Agent 返回了未知运行状态', 502);
      if (status.status === 'completed' && status.mock !== true) {
        const sha256 = String(status.artifact?.sha256 || '').toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(sha256)) throw relayError('训练已结束，但制品摘要不可用；请检查本机 Agent', 422);
        if (job.uploadedSha256 !== sha256) {
          const bytes = await worker(job, '/runs/' + encodeURIComponent(job.externalRunId) + '/artifact', {}, true);
          if (!bytes.length || bytes.length > MAX_ARTIFACT_BYTES) throw relayError('训练制品为空或超过 50 MiB', 422);
          await platform(job, '/relay/artifact', bytes, { 'content-type': 'application/octet-stream', 'x-artifact-sha256': sha256 });
          job.uploadedSha256 = sha256;
        }
      }
      // Completion becomes visible only after the platform accepted the bytes.
      // Retrying a failed final sync reuses the successful upload in this page.
      await platform(job, '/relay/sync', status);
      return status.status === 'completed' || status.status === 'failed';
    }

    function arm(job, delay) {
      if (!current(job) || job.timer !== null || job.state !== 'active') return;
      job.timer = schedule(() => { job.timer = null; void tick(job); }, delay);
    }

    async function tick(job) {
      if (!current(job) || job.inFlight || job.state !== 'active') return;
      job.inFlight = true;
      try {
        const terminal = await step(job);
        if (!current(job)) return;
        job.failures = 0;
        if (terminal) {
          job.state = 'done';
          options.onComplete?.(job.run.id);
        } else arm(job, pollMs);
      } catch (error) {
        if (!current(job)) return;
        job.failures += 1;
        const retry = retryable(error) && job.failures < maxFailures;
        const delay = Math.min(30_000, 1000 * 2 ** (job.failures - 1));
        if (retry) arm(job, delay);
        else job.state = 'paused';
        options.onError?.(error, { runId: job.run.id, retrying: retry, attempt: job.failures, delay });
      } finally {
        job.inFlight = false;
      }
    }

    function setOwner(next) {
      if (owner === next) return;
      for (const job of jobs.values()) {
        job.abort.abort();
        if (job.timer !== null) cancel(job.timer);
      }
      jobs.clear();
      owner = next;
    }

    function start(run, model, { retryPaused = false } = {}) {
      if (!owner || run?.backend !== 'local' || !run.relayAgentUrl || !['queued', 'running', 'completed'].includes(run.status)) return;
      if (run.status === 'completed' && !run.externalRunId) return;
      const existing = jobs.get(run.id);
      if (existing) {
        existing.run = run;
        existing.model = model || existing.model;
        if (!existing.externalRunId && run.externalRunId) {
          existing.externalRunId = run.externalRunId;
          existing.claimed = true;
        }
        if (retryPaused && existing.state === 'paused') {
          existing.failures = 0;
          existing.state = 'active';
          void tick(existing);
        }
        return;
      }
      const job = { run, model, owner, agentUrl: String(run.relayAgentUrl).replace(/\/+$/, ''), externalRunId: run.externalRunId || null, claimed: Boolean(run.externalRunId), uploadedSha256: null, abort: new root.AbortController(), timer: null, inFlight: false, failures: 0, state: 'active' };
      jobs.set(run.id, job);
      void tick(job);
    }

    function reconcile(overview, options = {}) {
      setOwner(overview ? String(overview.identity?.accountId || 'local-dev') : null);
      if (!overview) return;
      const models = new Map((overview.models || []).map((model) => [model.id, model]));
      for (const run of overview.runs || []) start(run, models.get(run.modelId), options);
    }

    return { reconcile, start, stop: () => setOwner(null) };
  }

  root.SimTrainingRelay = { create };
})(globalThis);
