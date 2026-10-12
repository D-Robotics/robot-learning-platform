#!/usr/bin/env node

import assert from 'node:assert/strict';
import http from 'node:http';
import { probeSim2Real } from './probe-sim2real.mjs';

let ready = true;
let metricsRoute = '/healthz';
let leakMetrics = '';
const server = http.createServer((request, response) => {
  if (!request.url?.startsWith('/sim2real/')) {
    response.statusCode = 404;
    response.end();
    return;
  }
  const route = request.url.slice('/sim2real'.length);
  if (route === '/healthz') {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        ok: true,
        service: 'sim2real-web',
        schemaVersion: 'v1',
        ready,
        storage: { writable: true },
      }),
    );
  } else if (route === '/readyz') {
    response.statusCode = ready ? 200 : 503;
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        ok: true,
        service: 'sim2real-web',
        schemaVersion: 'v1',
        ready,
        storage: { writable: ready },
      }),
    );
  } else if (route === '/metrics') {
    response.setHeader('content-type', 'text/plain; version=0.0.4');
    response.end(
      `# HELP sim2real_http_requests_total requests\nsim2real_http_requests_total{method="GET",route=${JSON.stringify(metricsRoute)},status="200"} 1\nsim2real_process_uptime_seconds 1${leakMetrics}\n`,
    );
  } else {
    response.statusCode = 404;
    response.end();
  }
});

await new Promise((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
  server.listen(0, '127.0.0.1');
});
try {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/sim2real`;
  assert.equal((await probeSim2Real({ url: base, retries: 0 })).ok, true);
  ready = false;
  assert.equal((await probeSim2Real({ url: base, retries: 0 })).ok, false);
  assert.equal((await probeSim2Real({ url: base, retries: 0, allowDegraded: true })).ok, true);
  ready = true;
  metricsRoute = '/tokens.css';
  const publicCss = await probeSim2Real({ url: base, retries: 0 });
  assert.equal(publicCss.ok, true);
  assert.equal(publicCss.checks.find((item) => item.id === 'metrics-redaction').status, 'pass');
  for (const credential of ['authorization', 'cookie', 'token', 'secret', 'password']) {
    // A harmless public route in the same metrics body must not hide a leak.
    leakMetrics = `\n# ${credential}=should-fail`;
    const leaked = await probeSim2Real({ url: base, retries: 0 });
    assert.equal(leaked.ok, false);
    assert.equal(leaked.checks.find((item) => item.id === 'metrics-redaction').status, 'fail');
  }
  leakMetrics = '';
  for (const otherRoute of ['/other-token.css', '/tokens.css?token=should-fail']) {
    metricsRoute = otherRoute;
    const leakedRoute = await probeSim2Real({ url: base, retries: 0 });
    assert.equal(leakedRoute.ok, false);
    assert.equal(leakedRoute.checks.find((item) => item.id === 'metrics-redaction').status, 'fail');
  }
  console.log(
    '[sim2real-probe] PASS — base-path routing, readiness degradation and metric redaction gates verified',
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
}
