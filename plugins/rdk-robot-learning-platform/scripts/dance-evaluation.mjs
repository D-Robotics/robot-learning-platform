const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;
const shaPattern = /^[a-f0-9]{64}$/;
const runId = { type: 'string', pattern: idPattern.source };
const object = (properties, required) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

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
  const independent = comparison ? null : await upstream.evaluateDanceRun(ids[0], { signal });
  if (
    independent &&
    (independent.source?.runId !== ids[0] ||
      independent.source?.policySha256 !== records[0].artifact.sha256)
  )
    throw Error('独立评测回执与原策略不一致。');
  if (!comparison && !independent) throw Error('平台未返回独立评测结果。');
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
