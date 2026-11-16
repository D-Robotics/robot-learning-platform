const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;
const shaPattern = /^[a-f0-9]{64}$/;
const runId = { type: 'string', pattern: idPattern.source };
const object = (properties, required) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const DANCE_ACCEPTANCE_TOOL = {
  name: 'rdk_originman_dance_acceptance',
  description:
    '一键验收明确的 OriginMan 舞蹈 Run。沿同一 Run 等待训练完成，自动用本轮 ONNX 做独立仿真评测并核对场景与契约。按 studioNavigation 在右侧显示判定、未通过项、回放和策略下载。只涉及仿真评测。',
  inputSchema: object(
    {
      runId,
      pollCursor: {
        type: 'string',
        pattern: '^[a-f0-9-]{36}$',
        description: '训练仍在运行时，使用回执 nextArguments 的游标。',
      },
    },
    ['runId'],
  ),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

export const DANCE_EVALUATION_TOOLS = [
  {
    name: 'rdk_originman_dance_evaluate',
    description:
      '用一条已完成舞蹈 Run（训练记录）的原 ONNX（策略文件）做独立仿真评测。仅在用户明确要求重新评测时调用。结果打开主站评测页，可看逐段实测、达标门槛与对应回放。',
    inputSchema: object({ runId }, ['runId']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'rdk_originman_dance_compare',
    description:
      '按两条明确 Run（训练记录）对比原舞蹈评测，默认定位第 3 段，同时提供每段实测值、门槛和回放。打开主站对比页。缺少明确记录时先查找或请用户确认。',
    inputSchema: object(
      {
        baselineRunId: runId,
        candidateRunId: runId,
        section: { type: 'integer', minimum: 1, maximum: 8 },
      },
      ['baselineRunId', 'candidateRunId'],
    ),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
];

function nominal(run, report) {
  const dance = run.training?.originmanDance;
  const value = report?.evaluations?.find((row) => row.bpm === dance?.bpm);
  if (
    !Array.isArray(dance?.sections) ||
    value?.sections?.length !== dance.sections.length ||
    value.sections.some((section, index) => section.type !== dance.sections[index].type)
  )
    throw Error('标称节拍评测与原舞段不一致。');
  return { bpm: dance.bpm, qualityGatePassed: report.qualityGatePassed, sections: value.sections };
}

async function independentDanceReport(run, upstream, signal) {
  const result = await upstream.evaluateDanceRun(run.id, { signal });
  if (!result) throw Error('平台未返回独立评测结果。');
  if (result.source?.runId !== run.id || result.source?.policySha256 !== run.artifact.sha256)
    throw Error('独立评测回执与原策略不一致。');
  return result;
}

export async function acceptDanceSimulation(run, { upstream, signal }) {
  if (
    run.status !== 'completed' ||
    run.mock !== false ||
    run.taskId !== 'originman-dance' ||
    run.artifact?.format !== 'onnx' ||
    !shaPattern.test(run.artifact.sha256 ?? '')
  )
    throw Error('一键仿真验收需要一条已完成且有可核验 ONNX 的真实 OriginMan 舞蹈 Run。');
  const recorded = run.metrics?.originmanDance;
  const scene = recorded?.sceneProvenance?.sceneSha256;
  if (
    !upstream.evaluateDanceRun ||
    typeof recorded?.qualityGatePassed !== 'boolean' ||
    !shaPattern.test(scene ?? '') ||
    !run.contractId
  )
    throw Error('本轮场景、契约或质量记录尚不完整。');
  const result = await independentDanceReport(run, upstream, signal);
  if (
    result.source.sceneSha256 !== scene ||
    result.source.contractId !== run.contractId ||
    result.qualityGatePassed !== recorded.qualityGatePassed
  )
    throw Error('独立仿真与原 Run 的场景、契约或质量结论不一致。');
  const original = nominal(run, recorded);
  const acceptance = nominal(run, result);
  if (
    acceptance.sections.some((section, index) => {
      const previous = original.sections[index];
      return (
        typeof section.passed !== 'boolean' ||
        previous.passed !== section.passed ||
        previous.clean !== section.clean ||
        previous.stylePassed !== section.stylePassed
      );
    })
  )
    throw Error('独立仿真与原 Run 的逐段判定不一致。');
  const recordedRows = recorded.evaluations;
  const checkedRows = result.evaluations;
  const bpm = acceptance.bpm;
  const tempos = [...new Set([Math.max(80, bpm * 0.95), bpm, Math.min(140, bpm * 1.05)])];
  const allTemposVerified =
    recordedRows.length === tempos.length &&
    checkedRows.length === tempos.length &&
    tempos.every((tempo) => recordedRows.some((row) => Math.abs(row.bpm - tempo) < 0.001)) &&
    recordedRows.every((row) => {
      const matched = checkedRows.filter((item) => item.bpm === row.bpm);
      return (
        matched.length === 1 &&
        matched[0].sections?.length === row.sections?.length &&
        matched[0].sections.every((section, index) => {
          const previous = row.sections[index];
          return (
            previous.type === section.type &&
            previous.clean === section.clean &&
            previous.stylePassed === section.stylePassed &&
            previous.passed === section.passed
          );
        })
      );
    });
  return {
    ...acceptance,
    allTemposVerified,
    state: result.qualityGatePassed ? 'passed' : 'failed',
    policySha256: result.source.policySha256,
    sceneSha256: scene,
    contractId: run.contractId,
    evaluatedAt: result.evaluatedAt,
  };
}

export async function danceEvaluation(name, args, { upstream, baseUrl, signal }) {
  const comparison = name === DANCE_EVALUATION_TOOLS[1].name;
  const ids = comparison ? [args.baselineRunId, args.candidateRunId] : [args.runId];
  const section = comparison ? (args.section ?? 3) : 3;
  const allowed = comparison ? ['baselineRunId', 'candidateRunId', 'section'] : ['runId'];
  if (
    Object.keys(args).some((key) => !allowed.includes(key)) ||
    ids.some((id) => typeof id !== 'string' || !idPattern.test(id)) ||
    new Set(ids).size !== ids.length ||
    !Number.isInteger(section) ||
    section < 1 ||
    section > 8
  )
    throw Error('请提供准确的原训练记录，且两轮对比须选择不同记录。');
  if (!upstream.readTrainingRun || (!comparison && !upstream.evaluateDanceRun))
    throw Error('当前连接没有独立舞蹈评测接口，请刷新已登录的平台连接。');
  const url = new URL(baseUrl);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error('平台地址无效。');
  url.pathname = url.pathname.replace(/\/+$/, '') + '/dance-results.html';
  for (const id of ids) url.searchParams.append('run', id);
  url.searchParams.set('section', String(section));
  if (!comparison) url.searchParams.set('mode', 'independent');

  const records = await Promise.all(
    ids.map(async (id) => {
      const run = await upstream.readTrainingRun(id, { signal });
      if (
        run?.id !== id ||
        run.status !== 'completed' ||
        run.mock !== false ||
        run.taskId !== 'originman-dance' ||
        !shaPattern.test(run.artifact?.sha256 ?? '')
      )
        throw Error('当前账号须能读取已完成且有可校验策略的真实舞蹈训练。');
      return run;
    }),
  );
  const independent = comparison
    ? null
    : await independentDanceReport(records[0], upstream, signal);
  const reports = records.map((run) => ({
    runId: run.id,
    numEnvs: run.training.numEnvs,
    trainingSeconds: run.metrics?.trainingSeconds,
    ...nominal(run, independent ?? run.metrics?.originmanDance),
  }));
  const href = url.href;
  const title = comparison ? '打开两轮舞蹈对比' : '打开独立舞蹈评测';
  return {
    ok: true,
    mode: comparison ? 'comparison' : 'independent',
    reports,
    ...(independent ? { evaluatedAt: independent.evaluatedAt, source: independent.source } : {}),
    links: { result: href },
    visualization: { url: href },
    studioNavigation: { tool: 'studio_open_url', arguments: { url: href } },
    qoderNavigation: {
      steps: [
        { tool: 'navigate_page', arguments: { url: href } },
        { tool: 'list_pages', arguments: {} },
        {
          tool: 'select_page',
          argumentsFrom: '按完整URL匹配，使用实际pageId并传bringToFront:true。',
        },
      ],
    },
    studentReply: `[${title}](${href})。页面按原记录展示逐段实测、达标门槛和仿真回放。`,
    delivery:
      '立即按 studioNavigation 在 Studio 右侧打开主站对应页面，或按 qoderNavigation 打开并置前。宿主缺少导航工具时展示可点击链接。以实际播放器状态报告播放结果。',
  };
}
