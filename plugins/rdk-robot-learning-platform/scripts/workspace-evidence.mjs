import { PluginRequestError, publicFailure } from './plugin-errors.mjs';

const scopes = ['all', 'training', 'compute', 'devices', 'deployments', 'datasets'];
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/;
const deviceIdentifier =
  /^(?:[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}|bridge-ssh:[a-zA-Z0-9_.:\[\]-]{1,190})$/;
const sampleLimit = 10;

export const WORKSPACE_EVIDENCE_TOOL = {
  name: 'rdk_workspace_inspect',
  description:
    '只读盘点账号资产、最新训练产出、Worker 最近检查、设备状态和部署失败证据。全貌用 scope=all；专项用 training/compute/devices/deployments/datasets。指定原 Run、部署或板卡时传对应完整 ID。',
  inputSchema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: scopes },
      datasetId: { type: 'string', description: '仅 datasets，查询指定数据集及下载入口。' },
      runId: { type: 'string', description: '仅 training，省略时查工作区最新 Run。' },
      deploymentId: { type: 'string', description: '仅 deployments，省略时查最近更新的记录。' },
      deviceId: {
        type: 'string',
        description: '仅 devices，对指定板卡做一次只读 BoardAgent 健康查询。',
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
};

export const WORKSPACE_EVIDENCE_INSTRUCTIONS =
  '账号资产全貌、运行数、最近训练效果、Worker 可用性、设备状态或历史部署失败，先用 rdk_workspace_inspect，按用户范围选 scope。' +
  '设备列表用 scope=devices；仅用户询问指定设备的 BoardAgent 状态时传 deviceId。数据集用 scope=datasets 或 rdk_datasets_list，并展示 studentReply 中的托管状态和下载链接。Run 结果展示部署资格、回放和策略下载，按同一 Run 的回执报告。' +
  '按用户指定范围读完证据再回答；全貌给统计时间、范围、最近 Run 的指标/评测/制品和最近失败部署的步骤。' +
  'runCountScope=owner-ledger 时说明 Run 数和进行中数量覆盖当前账号的全部台账，按 runStatuses 给状态分布。runCountScope=recent-window 时把 Run 数和进行中数量标为近期列表统计。保留关键记录完整 ID 与时间。' +
  '列表有上限时给返回数和查询范围；counts 缺字段、部分查询失败、空列表分别说明。旧平台缺少制品或评测总数时直接说明总数未知，同时给已关联的记录。' +
  '区分训练完成、评测通过、制品发布、部署通过。成功率为 0 仅说明本项指标为 0；效果结论依据质量门与适用的评测。缺少指标时说明未知。区分设备连接状态、已识别板型和 BoardAgent 探测。' +
  'Worker 只据记录的 status、lastCheckedAt、message、engines 描述；并发上限不表示空闲槽位，回环地址不能判定隧道或进程状态。' +
  '无探测结果时保留失败步骤、平台回执和根因待确认，查询历史时无需重试预检或刷新 Worker 状态。';

function pick(record, fields) {
  return Object.fromEntries(
    fields
      .split(' ')
      .filter((key) => record?.[key] !== undefined)
      .map((key) => [key, record[key]]),
  );
}

function sample(items, project, limit = sampleLimit) {
  return {
    returned: Math.min(items.length, limit),
    limited: items.length > limit,
    items: items.slice(0, limit).map(project),
  };
}

function collection(value, key) {
  if (Array.isArray(value?.[key])) return value[key];
  throw new PluginRequestError('WORKSPACE_INVALID_RESPONSE', '平台未返回可用的列表。', {
    httpStatus: 502,
  });
}

function isShortRunId(identifier) {
  return typeof identifier === 'string' && /^[a-f0-9][a-f0-9-]{7,34}$/i.test(identifier);
}

export function matchesRunIdentifier(identifier, runId) {
  return (
    typeof runId === 'string' &&
    (runId === identifier ||
      (isShortRunId(identifier) && runId.toLowerCase().startsWith(identifier.toLowerCase())))
  );
}

export function workspaceLink(baseUrl, route) {
  try {
    const url = new URL(baseUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    url.pathname = url.pathname.replace(/\/+$/, '') + '/api/v1/duck' + route;
    return url.href;
  } catch {
    return null;
  }
}

function hostedDatasetRecord(dataset) {
  const ref =
    typeof dataset.uri === 'string'
      ? /^dataset-hosted:\/\/([a-f0-9]{64})\/([^/]+)$/.exec(dataset.uri)
      : null;
  if (
    !ref ||
    ref[1] !== dataset.sha256 ||
    !Number.isSafeInteger(dataset.sizeBytes) ||
    dataset.sizeBytes < 1 ||
    dataset.sizeBytes > 50 * 1024 * 1024
  )
    return false;
  try {
    const filename = decodeURIComponent(ref[2]);
    return (
      filename.length > 0 &&
      filename.length <= 180 &&
      filename !== '.' &&
      filename !== '..' &&
      !/[\/\\\u0000-\u001f\u007f]/u.test(filename)
    );
  } catch {
    return false;
  }
}

function datasetEvidence(dataset, baseUrl) {
  const hosted = hostedDatasetRecord(dataset);
  const storage = hosted
    ? 'hosted'
    : typeof dataset.uri !== 'string' || dataset.uri.startsWith('dataset-hosted://')
      ? 'unverified'
      : 'external';
  const download =
    hosted && dataset.status !== 'revoked' && identifier.test(dataset.id ?? '')
      ? workspaceLink(baseUrl, '/datasets/' + encodeURIComponent(dataset.id) + '/file')
      : null;
  return {
    ...pick(dataset, 'id name version status format sampleCount contractId sourceRunId sizeBytes'),
    storage,
    ...(download && { links: { download } }),
  };
}

export function datasetEvidenceList(value, baseUrl, datasetId, limit = sampleLimit) {
  const items = collection(value, 'datasets');
  const matching = datasetId ? items.filter((item) => item.id === datasetId) : items;
  const result = sample(matching, (item) => datasetEvidence(item, baseUrl), limit);
  const rows = result.items.slice(0, sampleLimit).map((item) => {
    const name = String(item.name ?? item.id)
      .slice(0, 160)
      .replace(/[\r\n]/g, ' ')
      .replace(/[\[\]`<>&*]/g, '');
    const storage = {
      hosted: '平台托管',
      external: '外部登记，平台无托管文件',
      unverified: '托管状态待核实',
    };
    const action =
      item.status === 'revoked'
        ? '已撤销，无法下载'
        : item.links?.download
          ? `[下载数据集](${item.links.download})`
          : '';
    return `- ${name} · ${storage[item.storage]}${action ? ' · ' + action : ''}`;
  });
  if (matching.length > sampleLimit)
    rows.push(`共 ${matching.length} 条，以上展示前 ${sampleLimit} 条。`);
  return {
    ...result,
    studentReply:
      rows.join('\n') || (datasetId ? '当前工作区未找到这个数据集。' : '当前工作区暂无数据集。'),
  };
}

function runCollection(value, key, runId) {
  const items = collection(value, key);
  if (items.some((item) => item?.runId !== runId))
    throw new PluginRequestError('WORKSPACE_EVIDENCE_MISMATCH', '平台回执中存在其他 Run 的记录。', {
      httpStatus: 502,
    });
  return items;
}

function readFailure(error) {
  const { error: code, message, httpStatus, needsLogin } = publicFailure(error);
  return { code, message, httpStatus, needsLogin };
}

async function readSection(fn, signal) {
  try {
    return { status: 'read', ...(await fn()) };
  } catch (error) {
    signal?.throwIfAborted();
    return { status: 'unavailable', error: readFailure(error) };
  }
}

function runEvidence(run) {
  const dance = run.metrics?.originmanDance;
  return {
    ...pick(
      run,
      'id label modelId projectId productId taskId contractId backend computeResourceId status summary createdAt finishedAt mock evaluationId artifactIds',
    ),
    training: pick(
      run.training,
      'engine algorithm profile numEnvs maxIterations video syntheticSmoke',
    ),
    metrics: {
      ...pick(
        run.metrics,
        'engine physicsBackend sourceCommit reward successRate fallRate evaluationEpisodes meanReturn iterations trainingSteps trainingDevice trainingDeviceName cuda syntheticData trainChunkMse validationChunkMse controlLatencyMs measurementStage',
      ),
      ...(dance && { originmanDance: pick(dance, 'qualityGatePassed') }),
    },
    artifact: pick(run.artifact, 'format sha256 sizeBytes deployable'),
    failureDetail: pick(run.failureDetail, 'errorCode exitCode'),
  };
}

function deploymentEvidence(item) {
  return {
    ...pick(
      item,
      'id runId modelId artifactId evaluationId deviceId targetPlatform mode status summary createdAt updatedAt executedAt',
    ),
    blockingSteps: (Array.isArray(item.steps) ? item.steps : [])
      .filter((step) => ['failed', 'blocked'].includes(step?.status))
      .slice(0, sampleLimit)
      .map((step) => pick(step, 'id label status detail')),
    verification: pick(item.verification, 'passed checkedAt mock'),
  };
}

export async function inspectWorkspace(args, read, { signal, baseUrl } = {}) {
  const { scope = 'all', runId, deploymentId, deviceId, datasetId } = args;
  const idScope = {
    runId: 'training',
    deploymentId: 'deployments',
    deviceId: 'devices',
    datasetId: 'datasets',
  };
  if (
    !scopes.includes(scope) ||
    Object.entries(args).some(
      ([key, value]) =>
        key !== 'scope' &&
        (!Object.hasOwn(idScope, key) ||
          idScope[key] !== scope ||
          typeof value !== 'string' ||
          !(key === 'deviceId' ? deviceIdentifier : identifier).test(value)),
    )
  ) {
    throw new PluginRequestError(
      'WORKSPACE_INVALID_ARGUMENTS',
      '请选择查询范围，并在对应范围内使用完整记录 ID。',
      { httpStatus: 400 },
    );
  }
  const summary =
    scope === 'all' || (scope === 'training' && !runId) ? read('/workspace-summary') : null;
  const selected = (name) => scope === 'all' || scope === name;
  const sections = {
    ...(summary && {
      summary: async () => {
        const value = await summary;
        if (!Number.isSafeInteger(value.counts?.runs) || value.counts.runs < 0)
          throw new PluginRequestError(
            'WORKSPACE_INVALID_RESPONSE',
            '平台未返回有效的工作区统计。',
            { httpStatus: 502 },
          );
        return {
          generatedAt: value.generatedAt ?? null,
          counts: {
            registeredArtifacts: null,
            evaluations: null,
            ...pick(
              value.counts,
              'projects models datasets runs activeRuns registeredArtifacts evaluations deployments activeDeployments devices connectedDevices detectedDevices',
            ),
          },
          runCountScope: value.runCountScope === 'owner-ledger' ? 'owner-ledger' : 'recent-window',
          runStatuses: pick(value.runStatuses, 'ready queued running completed blocked failed'),
          deviceCountScope: Array.isArray(value.deviceStatuses)
            ? 'fresh-connection-probe'
            : 'legacy-summary',
        };
      },
    }),
    ...(scope === 'all' && {
      projects: async () =>
        sample(collection(await read('/projects'), 'projects'), (item) =>
          pick(item, 'id name slug'),
        ),
      models: async () =>
        sample(collection(await read('/models'), 'models'), (item) => ({
          ...pick(item, 'id builtin productId contractId createdAt updatedAt'),
          ...pick(item.manifest, 'name taskId'),
        })),
    }),
    ...(selected('datasets') && {
      datasets: async () => datasetEvidenceList(await read('/datasets'), baseUrl, datasetId),
    }),
    ...(selected('training') && {
      training: async () => {
        const summaryRun = runId ? null : (await summary).latest?.run;
        const id = runId ?? summaryRun?.id;
        if (id == null && summaryRun === null && !runId) return { run: null };
        if (!identifier.test(id ?? ''))
          throw new PluginRequestError(
            'WORKSPACE_INVALID_RESPONSE',
            '平台未返回有效的 Run 标识。',
            { httpStatus: 502 },
          );
        const query = '?runId=' + encodeURIComponent(id) + '&limit=' + (sampleLimit + 1);
        const detail = await readSection(async () => {
          const { run } = await read('/runs/' + encodeURIComponent(id));
          if (run?.id !== id)
            throw new PluginRequestError('WORKSPACE_INVALID_RESPONSE', '平台未确认指定 Run。', {
              httpStatus: 502,
            });
          return { run: runEvidence(run) };
        }, signal);
        if (detail.status !== 'read' && !summaryRun) return detail;
        const [evaluations, artifacts] = await Promise.all([
          readSection(
            async () =>
              sample(runCollection(await read('/evaluations' + query), 'evaluations', id), (item) =>
                pick(
                  item,
                  'id runId artifactId status source attested stale summary createdAt completedAt',
                ),
              ),
            signal,
          ),
          readSection(
            async () =>
              sample(runCollection(await read('/artifacts' + query), 'artifacts', id), (item) => ({
                ...pick(item, 'id name runId type status format sha256 createdAt'),
                ...pick(item.metadata, 'artifactId version sha256 contractId'),
                ...(item.type === 'artifact' &&
                  item.id?.startsWith('artifact:') && {
                    registryId: item.id.slice('artifact:'.length),
                  }),
              })),
            signal,
          ),
        ]);
        return {
          run: detail.run ?? (summaryRun ? runEvidence(summaryRun) : null),
          detailStatus: detail.status,
          ...(detail.error && { detailError: detail.error }),
          evaluations,
          artifacts,
        };
      },
    }),
    ...(selected('compute') && {
      compute: async () => {
        const items = collection(await read('/compute-resources'), 'computeResources');
        return {
          ...sample(
            items,
            (item) => {
              const health = pick(
                item.health,
                'status lastCheckedAt message engines gpuName cuda vramMb maxConcurrentJobs mock',
              );
              const resource = pick(
                item,
                'id name source status lastCheckedAt message engines gpuName cuda vramMb maxConcurrentJobs mock',
              );
              return { ...health, ...resource };
            },
            30,
          ),
          received: items.length,
        };
      },
    }),
    ...(selected('devices') && {
      devices: async () => {
        if (!deviceId) {
          const value = await read('/board-station/devices');
          return {
            ...sample(
              collection(value, 'devices'),
              (item) => pick(item, 'id name status boardPlatform boardModel connectionMode'),
              30,
            ),
            ...pick(value, 'agentConfigured'),
          };
        }
        const result = await read('/board-station/health?deviceId=' + encodeURIComponent(deviceId));
        if (result.device?.id !== deviceId)
          throw new PluginRequestError('WORKSPACE_INVALID_RESPONSE', '平台未确认指定设备。', {
            httpStatus: 502,
          });
        return {
          device: pick(result.device, 'id status boardPlatform boardModel'),
          agent: pick(result.agent, 'state capabilities mock actuatorControl'),
        };
      },
    }),
    ...(selected('deployments') && {
      deployments: async () => {
        const items = deploymentId
          ? [(await read('/deployments/' + encodeURIComponent(deploymentId))).deployment]
          : collection(await read('/deployments'), 'deployments');
        if (deploymentId && items[0]?.id !== deploymentId)
          throw new PluginRequestError('WORKSPACE_INVALID_RESPONSE', '平台未确认指定部署。', {
            httpStatus: 502,
          });
        const recent = [...items].sort((a, b) =>
          String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')),
        );
        const latest = recent[0];
        const failure = recent.find((item) => item.status === 'failed');
        const blocked = recent.find((item) => item.status === 'blocked');
        const target = failure ?? blocked ?? latest;
        const history = identifier.test(target?.id ?? '')
          ? await readSection(async () => {
              const value = await read(
                '/deployments/' + encodeURIComponent(target.id) + '/history',
              );
              if (value.deploymentId !== target.id)
                throw new PluginRequestError(
                  'WORKSPACE_INVALID_RESPONSE',
                  '平台未确认部署历史的所属记录。',
                  { httpStatus: 502 },
                );
              return {
                deploymentId: target.id,
                ...sample(collection(value, 'history').slice().reverse(), (item) =>
                  pick(item, 'id type status summary createdAt'),
                ),
                verification: pick(value.verification, 'passed checkedAt mock'),
              };
            }, signal)
          : null;
        return {
          ...sample(recent, deploymentEvidence),
          latest: latest ? deploymentEvidence(latest) : null,
          latestFailure: failure ? deploymentEvidence(failure) : null,
          latestBlocked: blocked ? deploymentEvidence(blocked) : null,
          history,
        };
      },
    }),
  };
  return {
    scope,
    ...Object.fromEntries(
      await Promise.all(
        Object.entries(sections).map(async ([key, fn]) => [key, await readSection(fn, signal)]),
      ),
    ),
  };
}
