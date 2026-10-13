// A view of the existing project evidence. Actions only open existing pages;
// this guide neither starts a job nor issues a device command.
(function (root) {
  'use strict';
  const destinations = Object.freeze({
    devices: { view: 'station', child: 'devices' },
    calibration: { view: 'station', module: 'diagnostics' },
    simulate: { view: 'simulate', child: 'simulate' },
    prepare: { view: 'train', child: 'prepare' },
    configure: { view: 'train', child: 'configure' },
    train: { view: 'train', child: 'submit' },
    evaluate: { view: 'evaluate', child: 'evaluation-run' },
    deploy: { view: 'deploy', child: 'preflight' },
    trial: { view: 'station', module: 'policy' },
    follow: { view: 'station', module: 'telemetry' },
    records: { view: 'records', child: 'evaluation-evidence' },
  });
  let navigate = null;
  let bound = false;
  let lastView = null;
  let selectedStep = '';
  let context = '';
  let stepSignature = '';

  function derive(input = {}) {
    const { model, device, telemetry } = input;
    const run = input.run && (!model?.id || input.run.modelId === model.id) ? input.run : null;
    const status = String(run?.status || '').toLowerCase();
    const engine = run?.metrics?.engine || run?.training?.engine;
    const synthetic = run?.mock === true || run?.evaluation?.replay?.source === 'demo-fixture' || telemetry?.source === 'demo-fixture';
    const training = Boolean(run && ['local', 'robogo'].includes(run.backend) && !synthetic);
    const walking = training && engine === 'microduck-rl';
    const trained = walking && ['completed', 'ready'].includes(status);
    const active = training && ['queued', 'running'].includes(status);
    const failed = training && ['failed', 'cancelled', 'canceled', 'unknown'].includes(status);
    const uncertain = training && status === 'unknown';
    const gate = run?.taskEvaluation?.qualityGate || run?.evaluation?.qualityGate;
    const passed = Boolean(trained && input.releaseEvidenceReady === true && gate?.passed === true);
    const browser = input.integrations?.simulator?.browser;
    const available = browser?.available === true || browser?.state === 'mounted' || ['mounted', 'redirect'].includes(input.publicHealth?.microduck?.state);
    const recorded = !synthetic && telemetry?.source === 'browser-microduck' && Number(telemetry?.summary?.sampleCount) > 1;
    const deployments = (Array.isArray(input.deployments) ? input.deployments : []).filter((item) =>
      model?.id && device?.id && item.modelId === model.id && item.deviceId === device.id,
    );
    const executed = deployments.some((item) => ['canary', 'live'].includes(item.mode) && item.status === 'completed' && item.executedAt && item.verification?.passed === true && item.verification.mock !== true);
    const preflight = deployments.some((item) => item.mode === 'preflight' && ['ready', 'completed'].includes(item.status) && item.verification?.passed === true && item.verification.mock !== true);
    const preparation = input.preparation;
    const passport = preparation?.passport;
    const preparationReady = passport ? preparationRecord({ passport }).ready : false;
    const preparationBlocked = preparation?.status === 'error' || Boolean(passport && !preparationReady);
    let source = model?.builtin ? '预置参考模型' : model ? '登记模型 · 来源待验' : '尚未选择模型';
    if (run) source = synthetic ? '协议演示 · 不可部署' : run.backend === 'browser' ? '参考仿真记录' : trained ? '本次行走训练成果' : training ? '训练记录 · 尚待验收' : source;
    const steps = [
      { key: 'devices', name: '绑定设备', state: device ? 'recorded' : 'ready', status: device ? '已选择' : '待绑定', detail: device ? `${device.name || device.id}。请核对本组设备编号与连接状态。` : '在设备管理中登记并选择本组机器人。未接好机器人时可以运行参考仿真。', action: 'devices', label: '打开设备管理' },
      { key: 'calibration', name: '校准检查', state: preparationReady ? 'ready' : preparationBlocked ? 'blocked' : 'pending', status: preparationReady ? '准备通过 · 校准待验' : preparationBlocked ? '准备检查受阻' : '待只读检查', detail: preparationReady ? '只读报告已检查关节、home 配置与传感器来源。检查通过不等于完成零位、方向、限位和停止保护的现场验收。' : '刷新鸭子准备报告，查看传感器源时间、14 个关节的 home 与当前角度、配置来源和缺项；可下载报告留存，不会自动校准或运动。', action: 'calibration', label: '查看鸭子准备报告' },
      { key: 'simulate', name: '仿真试跑', state: recorded ? 'recorded' : available ? 'ready' : 'blocked', status: recorded ? '有录制' : available ? '可用' : '待资源', detail: '打开参考仿真，试跑并录下动作。参考策略用于观察仿真行为，本次训练成果的试跑与评测在评测页查看。', action: 'simulate', label: '打开参考仿真' },
      { key: 'train', name: '行走训练', state: trained ? 'recorded' : failed ? 'failed' : active ? 'active' : 'ready', status: trained ? '已训练' : uncertain ? '待找回' : failed ? '需修复' : active ? (status === 'queued' ? '排队中' : '运行中') : '待配置', detail: uncertain ? '任务状态尚未确认。先检查训练资源连接与日志、找回原任务；确认原任务已经结束后再重试。' : failed ? '打开 Run 查看错误与日志。修复配置后重试，或选择可用 checkpoint 续训；原运行记录保留。' : trained ? '保留本次 checkpoint 与 ONNX，继续核对导出一致性和仿真评测。训练完成不等于实体鸭可以行走。' : '选择 microduck-rl 与可用 GPU。现场时间不足时可运行参考仿真；冒烟训练只验证链路，训练完成仍需验收。', action: active || failed ? 'train' : 'configure', label: active || failed ? '查看 Run 与日志' : '配置行走训练' },
      { key: 'evaluate', name: '模型验收', state: passed ? 'recorded' : 'ready', status: passed ? '有通过记录' : '待验收', detail: '检查 ONNX 契约、导出一致性与仿真评测。未通过时修复后重测；仿真通过仍需实体校准与受控试走。', action: 'evaluate', label: '查看模型验收' },
      { key: 'deploy', name: '受控部署', state: executed ? 'recorded' : preflight ? 'ready' : 'blocked', status: executed ? '有执行记录' : preflight ? '预检通过' : '待预检', detail: '为当前模型与设备执行只读预检，再按证据和人工审批推进受控发布。审批通过与计划就绪不等于模型已下发。', action: 'deploy', label: '打开预检与发布' },
      { key: 'trial', name: '实体试走', state: 'pending', status: '待现场验收', detail: '确认已校准、急停可用，再在现场受控试走并保存姿态和关节遥测。零命令只停止步态指令，不代表站立已验证或舵机断电。', action: 'trial', label: '查看策略运行时' },
      { key: 'follow', name: '人体跟随', state: passport?.checks?.camera?.ok === false ? 'blocked' : 'pending', status: passport?.checks?.camera?.ok === false ? '缺相机 · 跟随待接入' : passport?.checks?.camera?.ok === true ? '发现相机 · 跟随待接入' : '待接通', detail: '打开板载相机画面并检查输入。相机出图不等于人体检测或跟随控制已接入；当前缺少检测目标、距离和目标丢失保护的真实接口。', action: 'follow', label: '查看相机与跟随条件' },
      { key: 'records', name: '保存成果', state: run ? 'recorded' : 'ready', status: run ? '有记录' : '待成果', detail: '下载实验记录 JSON，保存当前项目、模型、训练、评测、部署与证据引用，明确标注预置、mock 和现场来源。模型文件、原始轨迹与视频在各自记录中另行下载。', action: 'records', label: '查看全部证据' },
    ];
    let next;
    if (input.serviceError) next = { key: 'devices', title: '工作区暂不可用', copy: '重新加载后再查看设备与训练状态，已有记录会从台账恢复。', action: 'refresh', label: '重新加载工作区' };
    else if (input.authRequired) next = { key: 'simulate', title: '运行参考仿真', copy: '参考仿真可以直接打开；保存训练记录和连接机器人时登录活动账号。', action: 'simulate', label: '进入参考仿真' };
    else if (!input.loaded) next = { key: 'devices', title: '正在读取当前进度', copy: '进度来自当前项目的设备、训练和评测记录。', action: 'devices', label: '等待工作区加载', disabled: true };
    else if (active) next = { key: 'train', title: status === 'queued' ? '训练已排队' : '训练正在运行', copy: '查看曲线、进度与日志。现场时间不足时可以运行参考仿真，原任务继续保留。', action: 'train', label: '查看训练进度' };
    else if (uncertain) next = { key: 'train', title: '找回原训练任务', copy: '任务状态尚未确认。先检查连接与日志、找回原任务，确认已结束后再重试。', action: 'train', label: '查看任务与日志' };
    else if (failed) next = { key: 'train', title: '修复后继续训练', copy: '查看错误与日志，修复后重新提交或从可用 checkpoint 续训。可继续运行参考仿真。', action: 'train', label: '查看错误与日志' };
    else if (!device) next = { key: 'devices', title: '绑定本组机器人鸭', copy: '登记并选择本组设备，核对设备编号。也可以先完成参考仿真流程。', action: 'devices', label: '绑定设备' };
    else if (!model) next = { key: 'train', title: '准备机器人鸭模型契约', copy: '选择或登记与机器人鸭匹配的模型，再配置行走训练。', action: 'prepare', label: '选择模型与契约' };
    else if (!trained) next = { key: 'train', title: '配置机器人鸭行走训练', copy: '使用 microduck-rl 与可用 GPU 训练腿式策略。参考模型与其它引擎结果不会计为本次行走训练完成。', action: 'configure', label: '配置行走训练' };
    else if (!passed) next = { key: 'evaluate', title: '验收本次训练成果', copy: '检查导出一致性和仿真评测，缺少或未通过评测时先修复，再推进部署。', action: 'evaluate', label: '查看模型验收' };
    else if (!preflight && !executed) next = { key: 'deploy', title: '检查目标设备与模型', copy: '执行当前机器人与模型的只读预检，再查看发布所需的证据与审批。', action: 'deploy', label: '进入只读预检' };
    else next = { key: 'calibration', title: '实体运动仍需现场验收', copy: '软件证据与实体运动分别验收。关节校准、停止保护和受控试走仍需真实机器人完成并留存结果。', action: 'calibration', label: '查看设备诊断' };
    return { visible: input.productId === 'microduck', context: `${input.productId}:${model?.id || ''}:${device?.id || ''}`, source, steps, next };
  }

  // Exports are deliberately assembled from an allowlist. A raw passport or
  // manifest may contain connection addresses, local paths or account fields.
  function fields(value, names) {
    const result = {};
    for (const name of names) {
      const item = value?.[name];
      if (typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item) || typeof item === 'string' && item.length <= 256) result[name] = item;
    }
    return result;
  }
  function rows(value, names, limit = 100) {
    return (Array.isArray(value) ? value : []).slice(0, limit).map((item) => fields(item, names));
  }
  function preparationRecord(input = {}) {
    const passport = input.passport || {};
    const checks = passport.checks || {};
    const ages = checks.telemetry?.sourceAgeMs || {};
    const sourceTime = checks.telemetry?.sourceTime || {};
    const contract = checks.contract || {};
    const contractReady = contract.ok === true && Number.isInteger(contract.observationSize) && contract.observationSize > 0 && contract.observationSize % 61 === 0 && contract.actionSize === 14 && contract.actionOutput === 'joint-position-offset' && contract.commandVectorSize === 13 && Number.isFinite(contract.controlHz) && contract.controlHz > 0;
    const mock = passport.mock === true || checks.identity?.provenance?.mock === true;
    const expectedTopics = Array.isArray(checks.ros?.expected) ? checks.ros.expected : checks.ros?.expected && typeof checks.ros.expected === 'object' ? Object.entries(checks.ros.expected).map(([key, topic]) => ({ key, ...fields(topic, ['name', 'type', 'qos', 'required', 'present']) })) : [];
    return {
      schemaVersion: 1, kind: 'duck-preparation-record', generatedAt: input.generatedAt,
      device: fields(input.device, ['id']), observedAt: passport.observedAt || null,
      source: { kind: passport.kind || 'unknown', mock },
      ready: passport.kind === 'joint-onboarding-preflight' && passport.ready === true && !mock && contractReady && checks.joints?.ok === true && checks.telemetry?.ok === true && checks.telemetry?.fresh === true, physicalCalibrationVerified: false, motionStarted: false,
      profile: { sha256: checks.identity?.profileSha256 || null, provenance: fields(checks.identity?.provenance, ['kind', 'mock']) },
      contract: fields(checks.contract, ['ok', 'observationSize', 'actionSize', 'observationLayout', 'actionOutput', 'controlHz', 'commandVectorSize']),
      camera: fields(checks.camera, ['ok', 'required', 'requiredReason']),
      telemetry: { ...fields(checks.telemetry, ['ok', 'fresh', 'sensorStallSec']), sourceAgeMs: fields(ages, ['imu', 'jointStates', 'odom']), sourceTime: Object.fromEntries(['imu', 'jointStates', 'odom'].map((key) => [key, fields(sourceTime[key], ['sampleTs', 'sampleMonotonicNs'])])) },
      joints: { ok: checks.joints?.ok === true, expectedNames: (Array.isArray(checks.joints?.expectedNames) ? checks.joints.expectedNames : []).filter((name) => typeof name === 'string').slice(0, 14), rows: rows(checks.joints?.rows, ['name', 'homeRad', 'positionRad', 'velocityRadSec', 'errorFromHomeRad'], 14), missingNames: (Array.isArray(checks.joints?.missingNames) ? checks.joints.missingNames : []).filter((name) => typeof name === 'string').slice(0, 14) },
      ros: { ...fields(checks.ros, ['ok', 'fresh', 'observedAt', 'sourceAgeSec']), expected: rows(expectedTopics, ['key', 'name', 'type', 'qos', 'required', 'present'], 20) },
      missingChecks: [...['identity', 'python', 'tros', 'camera', 'ros', 'telemetry', 'joints'].filter((key) => checks[key]?.ok === false && !(key === 'camera' && checks.camera.required === false)), ...(!contractReady ? ['contract'] : [])],
      safety: { stopBehavior: checks.safety?.stopBehavior || null, physicalCalibrationVerified: false },
    };
  }
  function experimentRecord(input = {}) {
    const model = input.model;
    const projectId = input.project?.id;
    const run = input.run && input.run.modelId === model?.id && (!projectId || input.run.projectId === projectId) ? input.run : null;
    const artifact = run?.artifact || {};
    const demo = run?.evaluation?.replay?.source === 'demo-fixture';
    const candidates = (Array.isArray(input.deployments) ? input.deployments : []).filter((item) => item.modelId === model?.id && item.deviceId === input.device?.id);
    const included = candidates.filter((item) => !projectId || (item.projectId ? item.projectId === projectId : Boolean(run?.projectId === projectId && item.runId === run.id)));
    return {
      schemaVersion: 1, kind: 'duck-experiment-record', generatedAt: input.generatedAt,
      project: fields(input.project, ['id', 'name']), device: fields(input.device, ['id']),
      projectAttribution: { mode: projectId ? 'selected-project' : 'account-view', excludedLegacyRun: Boolean(projectId && input.run?.modelId === model?.id && !input.run.projectId), excludedUnattributedDeployments: projectId ? candidates.filter((item) => !item.projectId && !included.includes(item)).length : 0, note: 'Without a selected project, records follow the model/account view. A selected project includes only explicitly attributed runs; legacy deployments require a matching run attributed to that project.' },
      model: { ...fields(model, ['id', 'builtin']), ...fields(model?.manifest, ['modelId', 'displayName', 'version']), robot: fields(model?.manifest?.robot, ['id', 'variant']), contract: fields(model?.manifest?.contract, ['id', 'observationSize', 'actionSize', 'controlHz', 'jointCount']) },
      provenance: { preset: model?.builtin === true, mock: run?.mock === true || demo ? true : run?.mock === false ? false : null, source: demo ? 'demo-fixture' : run?.backend === 'browser' ? 'browser-reference' : run?.backend || (model?.builtin === true ? 'prebuilt-reference' : 'unknown'), physicalMotionVerified: false },
      run: run ? { ...fields(run, ['id', 'projectId', 'experimentId', 'label', 'modelId', 'taskId', 'backend', 'status', 'mock', 'createdAt', 'updatedAt']), training: fields(run.training, ['engine', 'algorithm', 'profile', 'numEnvs', 'maxIterations', 'seed']), metrics: fields(run.metrics, ['engine', 'physicsBackend', 'contractValid', 'successRate', 'fallRate', 'controlLatencyMs', 'onnxExported', 'onnxGate']) } : null,
      evaluation: run ? { ...fields(run.evaluation || run.taskEvaluation, ['evaluatedAt', 'taskId']), qualityGate: fields((run.taskEvaluation || run.evaluation)?.qualityGate, ['passed', 'gateOn']), replay: fields(run.evaluation?.replay, ['source', 'attested', 'sampleCount', 'durationSeconds']) } : null,
      artifact: fields(artifact, ['artifactId', 'version', 'format', 'sizeBytes', 'sha256']),
      deployments: rows(included.map((item) => ({ ...item, projectAttribution: !projectId ? 'account-view' : item.projectId ? 'explicit-project' : 'matched-project-run' })), ['id', 'projectId', 'projectAttribution', 'modelId', 'runId', 'artifactId', 'evaluationId', 'deviceId', 'mode', 'status', 'createdAt', 'updatedAt', 'executedAt']),
      evidenceReferences: run ? { runId: run.id, artifactIds: Array.isArray(run.artifactIds) ? run.artifactIds.filter((id) => typeof id === 'string') : [], evaluationId: typeof run.evaluationId === 'string' ? run.evaluationId : null, ...Object.fromEntries(Object.entries(fields(input.evidencePaths, ['boardSessionsPath', 'policyDownloadPath'])).filter(([, value]) => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[?#]/.test(value))) } : {},
      preparation: input.preparation ? preparationRecord({ ...input.preparation, device: input.device, generatedAt: input.generatedAt }) : null,
      scope: 'Metadata and existing evidence references; model files, raw trajectories and videos are separate downloads. Read-only preparation is not physical calibration or motion evidence.',
    };
  }

  function text(id, value) {
    const node = root.document?.getElementById(id);
    if (node && node.textContent !== value) node.textContent = value;
  }

  function renderSelection() {
    const step = lastView?.steps.find((item) => item.key === selectedStep) || lastView?.steps.find((item) => item.key === lastView.next.key);
    if (!step) return;
    text('duck-workshop-detail-title', `${step.name} · ${step.status}`);
    text('duck-workshop-detail-copy', step.detail);
    text('duck-workshop-detail-button', step.label);
    const button = root.document?.getElementById('duck-workshop-detail-button');
    if (button) button.dataset.duckAction = step.action;
    root.document?.querySelectorAll('[data-duck-step]').forEach((node) => node.setAttribute('aria-pressed', String(node.dataset.duckStep === step.key)));
  }

  function bind() {
    const panel = root.document?.getElementById('duck-workshop');
    if (!panel || bound) return;
    bound = true;
    panel.addEventListener('click', (event) => {
      const button = event.target.closest?.('button');
      if (!button || button.disabled || !panel.contains(button)) return;
      if (button.dataset.duckStep) { selectedStep = button.dataset.duckStep; renderSelection(); return; }
      const action = button.dataset.duckAction;
      if (action === 'refresh') { root.document.getElementById('workspace-status-retry')?.click(); return; }
      const destination = destinations[action];
      if (!destination) return;
      if (navigate) navigate({ ...destination });
      else root.location.hash = `${destination.view}${destination.child ? '/' + destination.child : ''}`;
    });
  }

  function render(input) {
    const view = derive(input);
    const panel = root.document?.getElementById('duck-workshop');
    if (!panel) return view;
    bind();
    panel.hidden = !view.visible;
    if (!view.visible) return view;
    if (context !== view.context) { selectedStep = ''; context = view.context; }
    lastView = view;
    text('duck-workshop-source', view.source);
    text('duck-workshop-next-title', view.next.title);
    text('duck-workshop-next-copy', view.next.copy);
    text('duck-workshop-next-button', view.next.label);
    const next = root.document.getElementById('duck-workshop-next-button');
    if (next) { next.disabled = view.next.disabled === true; next.dataset.duckAction = view.next.action; }
    const signature = JSON.stringify(view.steps.map(({ key, name, state, status }) => ({ key, name, state, status })));
    const list = root.document.getElementById('duck-workshop-steps');
    if (list && signature !== stepSignature) {
      const fragment = root.document.createDocumentFragment();
      view.steps.forEach((step, index) => {
        const item = root.document.createElement('li');
        item.dataset.state = step.state;
        const button = root.document.createElement('button');
        button.className = 'duck-workshop-step'; button.type = 'button'; button.dataset.duckStep = step.key;
        [['duck-workshop-step-number', String(index + 1).padStart(2, '0')], ['duck-workshop-step-name', step.name], ['duck-workshop-step-status', step.status]].forEach(([className, value]) => {
          const span = root.document.createElement('span'); span.className = className; span.textContent = value; button.append(span);
        });
        button.setAttribute('aria-label', `${step.name}：${step.status}，查看步骤说明`);
        item.append(button); fragment.append(item);
      });
      list.replaceChildren(fragment); stepSignature = signature;
    }
    renderSelection();
    return view;
  }

  root.DuckWorkshop = Object.freeze({ derive, render, preparationRecord, experimentRecord, setNavigate(handler) { navigate = typeof handler === 'function' ? handler : null; } });
})(globalThis);
