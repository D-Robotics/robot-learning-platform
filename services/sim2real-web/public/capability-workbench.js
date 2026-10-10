(function () {
'use strict';

// These are existing authenticated platform reads, not arbitrary tool dispatch.
// A handler binding describes the Agent contract; it does not prove a device,
// GPU, or external knowledge service is healthy. Only an actual query can do so.
const READ_TRIALS = {
  rdk_workspace_overview: { path: '/sim2real/overview', keys: ['models', 'runs', 'deployments', 'devices', 'computeResources'], view: 'overview' },
  rdk_workspace_summary: { path: '/sim2real/workspace-summary', object: 'counts', view: 'overview' },
  rdk_projects_list: { path: '/sim2real/projects', collection: 'projects', view: 'records' },
  rdk_datasets_list: { path: '/sim2real/datasets', collection: 'datasets', view: 'records' },
  rdk_models_list: { path: '/sim2real/models', collection: 'models', view: 'train' },
  rdk_runs_list: { path: '/sim2real/runs?limit=10', collection: 'runs', view: 'records' },
  rdk_artifacts_list: { path: '/sim2real/artifacts?limit=10', collection: 'artifacts', view: 'records' },
  rdk_evaluations_list: { path: '/sim2real/evaluations?limit=10', collection: 'evaluations', view: 'evaluate' },
  rdk_compute_resources_list: { path: '/sim2real/compute-resources', collection: 'computeResources', view: 'resources' },
  rdk_device_discover: { path: '/sim2real/device-connections', collection: 'connections', view: 'station' },
  rdk_feedback_summary: { path: '/sim2real/feedback/summary', object: 'summary', view: 'records' },
};
const FIELD_LABELS = {
  models: '模型', projects: '项目', datasets: '数据集', runs: '运行', deployments: '部署',
  devices: '设备', computeResources: '算力资源', activeRuns: '执行中的 Run',
  activeDeployments: '执行中的部署', connectedDevices: '已连接设备', detectedDevices: '已识别设备',
  evaluations: '评测', artifacts: '制品', connections: '设备连接', total: '总数',
};
const VIEW_LABELS = { overview: '工作区总览', records: '证据与记录', train: '训练工作台', evaluate: '评测与对比', resources: '执行资源', station: '设备管理', deploy: '预检与发布', simulate: '仿真与录制' };
const SAMPLE_PROMPTS = {
  rdk_docs_search: '请用 rdk_docs_search 检索 RDK X5 相机接入的官方文档，附来源链接；未命中时说明官方资料未核对。',
  rdk_docs_manuals: '请用 rdk_docs_manuals 列出官方手册，并说明如何选择相机相关章节。',
  rdk_docs_toc: '先列出官方手册供我选择，再用 rdk_docs_toc 读取所选手册目录；不要猜测手册标识。',
  rdk_docs_page: '请先检索 RDK X5 相机接入的官方资料，再用 rdk_docs_page 阅读检索命中的页面并附来源。',
  rdk_web_search: '请用 rdk_web_search 查找机器人视觉交互资料，附链接并标明第三方信息。',
  rdk_training_status: '先列出当前账号的 Run，再用 rdk_training_status 查看最近一条 Run 的状态和训练指标；没有 Run 时告诉我如何开始。',
  rdk_runs_replay: '先列出当前账号的 Run，再用 rdk_runs_replay 读取最近一条有遥测的 Run 的回放；缺少遥测时说明如何补齐。',
  rdk_telemetry_list: '先列出当前账号的 Run，再用 rdk_telemetry_list 查看最近一条 Run 的遥测数量、丢帧和证据状态。',
  rdk_run_logs: '先列出当前账号的 Run，再用 rdk_run_logs 读取最近一条本地训练 Run 的有界日志。',
  rdk_lineage_get: '先列出当前账号的 Run 或制品，选择最近一条，再用 rdk_lineage_get 解释它的数据、训练和评测来源。',
  rdk_board_health: '请用 rdk_board_health 检查当前选中设备的连接、传感器和磁盘；缺少设备时提示我先连接。',
  rdk_board_station_status: '请用 rdk_board_station_status 读取当前选中设备的心跳和传感器快照。',
  rdk_board_station_command: '先读取当前选中设备支持的只读命令清单，让我选择后再用 rdk_board_station_command 执行；不要猜测命令 id。',
  rdk_compute_resource_test: '先列出当前账号的训练资源，让我选择后再用 rdk_compute_resource_test 检查其健康状态。',
  rdk_model_validate: '请解释 rdk_model_validate 需要的 manifest 和目标平台，让我提供真实文件后再校验；不要生成虚构文件。',
  rdk_simulator_open: '请用 rdk_simulator_open 查看参考仿真的可用入口，说明如何开始录制。',
};

function categoryOf(id) {
  if (/^rdk_(docs|web)_/.test(id)) return '资料';
  if (/^rdk_(board|device)_/.test(id)) return '设备';
  if (/^rdk_deployment_|^rdk_artifact_promote/.test(id)) return '部署';
  if (/^rdk_(training|compute)_/.test(id)) return '训练';
  if (/^rdk_(runs_replay|telemetry|evaluation|retraining|run_logs|replay_video)/.test(id)) return '评测';
  return '工作区';
}

function viewOf(item) {
  if (READ_TRIALS[item.id]) return READ_TRIALS[item.id].view;
  if (/^rdk_deployment_|^rdk_board_policy_|^rdk_artifact_promote|^rdk_board_stop/.test(item.id)) return 'deploy';
  if (/^rdk_(board|device)_/.test(item.id)) return 'station';
  if (/^rdk_(training|model)_/.test(item.id)) return 'train';
  if (/^rdk_compute_/.test(item.id)) return 'resources';
  if (/^rdk_simulator_/.test(item.id)) return 'simulate';
  if (categoryOf(item.id) === '评测') return 'evaluate';
  return 'records';
}

function exampleOf(item) {
  if (!item.readOnly) {
    return `请为“${item.description}”准备 ${item.id} 的操作计划。先核对当前账号的真实资源、必填参数与安全前置条件，缺少信息先让我补充。本次只准备计划，等待我明确确认后再通过平台审批执行；不要编造 ID、制品或执行结果。`;
  }
  return SAMPLE_PROMPTS[item.id] || `请用 ${item.id} ${item.description}。先核对当前账号的真实资源和所需参数，缺少信息先让我补充；没有数据或调用失败时如实说明，不要编造 ID 或结果。`;
}

function prerequisitesOf(item) {
  if (READ_TRIALS[item.id]) return '使用当前账号的数据，无需填参数。空列表也会如实显示。';
  if (/^rdk_(docs|web)_/.test(item.id)) return '需要已启用的 Agent 和可连接的资料服务；检索结果附来源。';
  if (/^rdk_(board|device)_/.test(item.id)) return '先在设备管理选定真实设备；运动能力仍需设备安全开关与平台审批。';
  if (/^rdk_(run|telemetry|retraining|replay|evaluation)/.test(item.id)) return '先有当前账号可访问的真实 Run；回放还需要该 Run 的遥测证据。';
  if (/^rdk_deployment_|^rdk_artifact_promote/.test(item.id)) return '需要真实模型、制品、评测与目标设备；发布条件由平台校验。';
  if (/^rdk_training_|^rdk_compute_/.test(item.id)) return '先选择模型与训练资源；实际训练提交仍经过审批。';
  return '需要当前账号可访问的真实资源；Agent 会先核对缺失参数。';
}

function safeEvidence(value, depth = 0) {
  if (depth > 4) return '[展开层级已限制]';
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => safeEvidence(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !/(?:token(?!Configured$)|secret|password|cookie|authorization|credential)/i.test(key)).slice(0, 30).map(([key, item]) => [key, safeEvidence(item, depth + 1)]));
  }
  return typeof value === 'string' ? value.slice(0, 1200) : value;
}

function recoveryFor(error) {
  if (error?.status === 401) return '登录后重新试用。';
  if (error?.status === 403) return '当前账号没有这项资源权限，请使用有权限的账号或资源。';
  if (error?.status === 404) return '核对当前部署是否已提供该能力，以及资源是否仍存在。';
  if (error?.status === 503) return '服务或依赖尚未就绪，请先检查执行资源和设备连接，再重试。';
  return '请查看下方错误，核对对应页面的资源和依赖，然后重试。';
}

function mount({ panel, list, count, capabilities, request, onUsePrompt, onNavigate }) {
  if (!panel || !list) return null;
  const document = panel.ownerDocument;
  const catalog = capabilities?.dsh?.capabilities;
  if (!Array.isArray(catalog)) return null;
  const seen = new Set();
  const items = catalog.filter((item) => item && typeof item.id === 'string' && typeof item.description === 'string' && !seen.has(item.id) && seen.add(item.id)).map((item) => ({ ...item, readOnly: item.readOnly === true, bound: item.bound === true }));
  if (!items.length) return null;
  panel.querySelector('[data-capability-controls]')?.remove();
  list.replaceChildren();
  panel.hidden = false;
  const agentReady = capabilities.runtime === 'dsh' && capabilities.dsh?.initialized === true;
  const directAvailable = typeof request === 'function';
  const controls = document.createElement('div');
  controls.className = 'capability-controls';
  controls.dataset.capabilityControls = '1';
  const availability = document.createElement('p');
  availability.className = 'agent-catalog-legend';
  availability.textContent = agentReady ? 'Agent 已就绪。绑定表示已接入工具；设备、算力与资料服务是否可用，以本次结果为准。' : 'Agent 尚未就绪。带“页面查询”的能力可通过当前账号直接试用，其余能力先到对应页面配置。';
  const searchLabel = document.createElement('label');
  searchLabel.textContent = '搜索能力';
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = '名称、说明或工具 ID';
  search.setAttribute('aria-label', '搜索原子能力');
  searchLabel.append(search);
  const filterLabel = document.createElement('label');
  filterLabel.textContent = '试用方式';
  const filter = document.createElement('select');
  filter.setAttribute('aria-label', '筛选原子能力');
  for (const [value, label] of [['all', '全部能力'], ['direct', '页面只读查询'], ['readOnly', '只读能力'], ['gated', '需确认能力'], ['unavailable', 'Agent 未绑定']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    filter.append(option);
  }
  filterLabel.append(filter);
  const tally = document.createElement('p');
  tally.className = 'empty-inline';
  tally.setAttribute('role', 'status');
  const empty = document.createElement('p');
  empty.className = 'empty-inline';
  empty.textContent = '没有匹配的能力，请调整搜索词或筛选。';
  empty.hidden = true;
  controls.append(availability, searchLabel, filterLabel, tally, empty);
  list.before(controls);
  const rows = new Map();
  const resultAreas = new Map();

  function status(area, state, text) {
    area.replaceChildren();
    area.dataset.state = state;
    const message = document.createElement('p');
    message.textContent = text;
    area.append(message);
  }

  function evidence(area, payload, title = '本次查询证据') {
    const disclosure = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = title;
    const code = document.createElement('pre');
    const json = JSON.stringify(safeEvidence(payload), null, 2);
    code.textContent = json.length > 16000 ? `${json.slice(0, 16000)}\n…内容较长，请到对应页面查看完整记录。` : json;
    disclosure.append(summary, code);
    area.append(disclosure);
  }

  async function query(item, preset, area, button) {
    button.disabled = true;
    area.setAttribute('aria-busy', 'true');
    status(area, 'running', '正在查询当前账号的真实数据…');
    try {
      const payload = await request(preset.path, { method: 'GET' });
      if (!payload || typeof payload !== 'object' || payload.ok === false) throw new Error(payload?.message || payload?.error || '服务没有返回有效查询结果');
      const metrics = [];
      let selected;
      if (preset.collection) {
        if (!Array.isArray(payload[preset.collection])) throw new Error('查询响应缺少预期列表，请检查服务版本');
        selected = { [preset.collection]: payload[preset.collection], ...(Number.isFinite(payload.total) ? { total: payload.total } : {}) };
        const total = Number.isFinite(payload.total) ? payload.total : payload[preset.collection].length;
        metrics.push([FIELD_LABELS[preset.collection] || preset.collection, total]);
      } else if (preset.object) {
        selected = payload[preset.object];
        if (!selected || typeof selected !== 'object' || Array.isArray(selected)) throw new Error('查询响应缺少预期摘要，请检查服务版本');
        for (const [key, value] of Object.entries(selected)) if (typeof value === 'number') metrics.push([FIELD_LABELS[key] || key, value]);
      } else {
        selected = {};
        for (const key of preset.keys) if (Array.isArray(payload[key])) {
          selected[key] = payload[key];
          metrics.push([FIELD_LABELS[key] || key, payload[key].length]);
        }
        if (!metrics.length) throw new Error('查询响应缺少工作区数据，请检查服务版本');
      }
      const emptyList = preset.collection && payload[preset.collection].length === 0;
      status(area, emptyList ? 'empty' : 'completed', emptyList ? '查询完成：当前账号暂无记录。可到对应页面创建后再试用。' : `查询完成 · ${new Date().toLocaleTimeString()} · 当前账号`);
      if (metrics.length) {
        const grid = document.createElement('dl');
        grid.className = 'capability-result-metrics';
        for (const [label, value] of metrics.slice(0, 12)) {
          const metric = document.createElement('div');
          const key = document.createElement('dt');
          key.textContent = label;
          const number = document.createElement('dd');
          number.textContent = String(value);
          metric.append(key, number);
          grid.append(metric);
        }
        area.append(grid);
      }
      evidence(area, selected);
    } catch (error) {
      status(area, 'failed', `试用失败：${error?.message || String(error)}。${recoveryFor(error)}`);
    } finally {
      button.disabled = false;
      area.setAttribute('aria-busy', 'false');
    }
  }

  for (const [index, item] of items.entries()) {
    const preset = item.readOnly && READ_TRIALS[item.id];
    const canQuery = Boolean(preset && directAvailable);
    const canAskAgent = item.bound && agentReady && typeof onUsePrompt === 'function';
    const row = document.createElement('li');
    row.className = `agent-catalog-item capability-card${item.readOnly ? '' : ' is-gated'}${item.bound ? '' : ' is-unavailable'}`;
    row.dataset.capabilityId = item.id;
    const badge = document.createElement('span');
    badge.className = 'agent-catalog-badge';
    badge.textContent = `${item.readOnly ? '只读' : '⚠️ 需确认'} · ${canQuery ? '页面查询' : item.bound ? (agentReady ? 'Agent 已接入' : 'Agent 未就绪') : 'Agent 未绑定'}`;
    const desc = document.createElement('strong');
    desc.className = 'agent-catalog-desc';
    desc.textContent = item.description;
    const detail = document.createElement('details');
    detail.className = 'capability-detail';
    const summary = document.createElement('summary');
    summary.textContent = `${categoryOf(item.id)} · 作用与试用`;
    const id = document.createElement('code');
    id.textContent = item.id;
    const requirement = document.createElement('p');
    requirement.textContent = prerequisitesOf(item);
    const sampleLabel = document.createElement('label');
    sampleLabel.textContent = canQuery ? '查询输入：当前账号，无需参数。Agent 示例（可编辑）' : 'Agent 示例（可编辑）';
    sampleLabel.htmlFor = `capability-sample-${index}`;
    const sample = document.createElement('textarea');
    sample.id = sampleLabel.htmlFor;
    sample.rows = 3;
    sample.maxLength = 4000;
    sample.value = exampleOf(item);
    const actions = document.createElement('div');
    actions.className = 'capability-actions';
    const result = document.createElement('div');
    result.className = 'capability-result';
    result.setAttribute('role', 'status');
    result.setAttribute('aria-live', 'polite');
    result.dataset.state = 'idle';
    if (canQuery) {
      const trial = document.createElement('button');
      trial.type = 'button';
      trial.className = 'button button-primary button-small';
      trial.textContent = '只读试用';
      trial.addEventListener('click', () => { void query(item, preset, result, trial); });
      actions.append(trial);
    }
    const prepare = document.createElement('button');
    prepare.type = 'button';
    prepare.className = 'button button-ghost button-small';
    prepare.textContent = item.readOnly ? '准备 Agent 指令' : '准备受控计划';
    prepare.disabled = !canAskAgent;
    prepare.title = canAskAgent ? '填入对话输入框，检查后点击发送' : (item.bound ? '等待 Agent 初始化，或使用对应页面' : '当前部署没有绑定该 Agent 工具');
    prepare.addEventListener('click', () => {
      const prompt = sample.value.trim();
      if (!prompt) {
        status(result, 'failed', '请先填写示例指令，再准备试用。');
        sample.focus();
        return;
      }
      if (onUsePrompt(prompt, item) === false) {
        status(result, 'blocked', 'Agent 正在执行其他任务，请等待完成或停止等待后再试用。');
        return;
      }
      status(result, 'prepared', item.readOnly ? '指令已填入对话框。检查后点击发送；本次尚未执行。' : '计划指令已填入对话框。本次尚未执行，写操作仍需明确确认与平台审批。');
    });
    actions.append(prepare);
    const view = viewOf(item);
    if (typeof onNavigate === 'function') {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'button button-ghost button-small';
      link.textContent = `打开${VIEW_LABELS[view]}`;
      link.addEventListener('click', () => onNavigate(view, item));
      actions.append(link);
    }
    detail.append(summary, id, requirement, sampleLabel, sample, actions, result);
    row.append(badge, desc, detail);
    list.append(row);
    rows.set(item.id, row);
    resultAreas.set(item.id, result);
  }

  function updateFilter() {
    const term = search.value.trim().toLowerCase();
    let visible = 0;
    for (const item of items) {
      const matches = `${item.id} ${item.description} ${categoryOf(item.id)}`.toLowerCase().includes(term)
        && (filter.value === 'all'
          || (filter.value === 'direct' && item.readOnly && Boolean(READ_TRIALS[item.id]) && directAvailable)
          || (filter.value === 'readOnly' && item.readOnly)
          || (filter.value === 'gated' && !item.readOnly)
          || (filter.value === 'unavailable' && !item.bound));
      rows.get(item.id).hidden = !matches;
      if (matches) visible += 1;
    }
    tally.textContent = `显示 ${visible} / ${items.length} 项 · ${items.filter((item) => item.bound).length} 项 Agent 已绑定 · ${items.filter((item) => item.readOnly && READ_TRIALS[item.id] && directAvailable).length} 项页面只读试用`;
    empty.hidden = visible > 0;
    if (count) count.textContent = `（${items.length}）`;
  }
  search.addEventListener('input', updateFilter);
  filter.addEventListener('change', updateFilter);
  updateFilter();

  return {
    started(id) {
      const area = resultAreas.get(id);
      if (area) status(area, 'running', 'Agent 正在核对资源与执行证据；需要确认时会在对话中暂停。');
    },
    finished(id, outcome) {
      const area = resultAreas.get(id);
      if (!area) return;
      const matching = Array.isArray(outcome?.toolTrail) ? outcome.toolTrail.filter((step) => step?.name === id) : [];
      const failed = matching.some((step) => step.ok === false);
      const confirmed = matching.length > 0 && matching.every((step) => step.ok === true);
      status(area, failed ? 'failed' : confirmed ? 'completed' : 'unverified', failed ? '该工具调用失败。请查看对话中的错误与资源条件，再修改指令重试。' : confirmed ? '该工具已执行，工具调用证据见下方；详细返回结果见本次对话。' : '本次对话已返回，尚无该工具成功执行的证据。请查看计划、缺失条件或确认请求。');
      if (outcome?.text) {
        const text = document.createElement('p');
        text.textContent = String(outcome.text).slice(0, 1000);
        area.append(text);
      }
      if (matching.length) evidence(area, matching, '本次工具调用证据');
    },
    failed(id, error) {
      const area = resultAreas.get(id);
      if (area) status(area, 'failed', `Agent 试用未完成：${error?.message || String(error)}。${recoveryFor(error)}`);
    },
  };
}

window.RdkCapabilityWorkbench = Object.freeze({ mount });
})();
