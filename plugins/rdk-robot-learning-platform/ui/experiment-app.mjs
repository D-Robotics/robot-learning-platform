import { App } from '@modelcontextprotocol/ext-apps/app-with-deps';
import { startExperimentView } from '../../../services/sim2real-web/public/experiment-view.mjs';
import identity from '../plugin.json';

const app = new App({ name: 'RDK Experiment', version: identity.version });
let controller,
  current,
  opening = false,
  pendingResult = null;
const value = (result) => {
  let data = result.structuredContent;
  if (!data) {
    try {
      data = JSON.parse(result.content?.find((c) => c.type === 'text')?.text ?? '{}');
    } catch {
      data = {};
    }
  }
  if (result.isError || data.ok === false)
    throw Error(data.error?.message ?? '本次实验暂不可读，保留原任务。');
  return data.experiment ?? data;
};
const tool = async (name, args) => value(await app.callServerTool({ name, arguments: args }));
const page = (data) => {
  const raw = data.links?.experiment ?? data.links?.workbench;
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw Error('实验页地址无效。');
  return url;
};
const open = async () => {
  try {
    if (current) await app.openLink({ url: page(current).href });
  } catch {
    document.getElementById('playback-status').textContent =
      '宿主未能打开实验页，请使用对话中的链接。';
  }
};
const show = async (result) => {
  if (opening) {
    pendingResult = result;
    return;
  }
  opening = true;
  try {
    const data = value(result);
    current = data;
    controller?.dispose();
    if (!data.view || !data.links?.experiment) {
      document.getElementById('connection-status').textContent = '此平台使用原工作台';
      const button = document.getElementById('open-playback-page');
      button.hidden = false;
      button.onclick = () => {
        void open();
      };
      return;
    }
    const location = { href: page(data).href };
    let first = data;
    controller = await startExperimentView({
      document,
      location,
      EventSourceImpl: null,
      openPlayback: open,
      onExport: open,
      fetchImpl: async (url) => {
        const request = new URL(url);
        if (request.origin !== page(current).origin) throw Error('拒绝跨平台读取。');
        if (request.pathname.endsWith('/experiments/' + encodeURIComponent(data.contextId))) {
          const state =
            first ?? (await tool('rdk_experiment_resume', { contextId: data.contextId }));
          first = null;
          if (page(state).origin !== page(data).origin) throw Error('实验平台地址发生变化。');
          current = state;
          if (!state.view) throw Error('平台未返回同一实验视图。');
          return Response.json({ view: state.view });
        }
        const match = /\/runs\/([A-Za-z0-9_.-]+)$/.exec(request.pathname);
        const allowed = [current.view?.training?.runId, current.view?.evaluation?.runId];
        if (!match || !allowed.includes(match[1])) throw Error('拒绝读取本次实验以外的任务。');
        await tool('rdk_training_status', { runId: match[1] });
        const full = await tool('rdk_lineage_get', { runId: match[1] });
        return Response.json({ run: full.lineage?.run });
      },
    });
    document.getElementById('export-experiment').textContent = '在平台保存完整记录';
  } catch (error) {
    document.getElementById('experiment-error').hidden = false;
    document.getElementById('experiment-error').textContent = error.message;
  } finally {
    opening = false;
    if (pendingResult) {
      const next = pendingResult;
      pendingResult = null;
      void show(next);
    }
  }
};
for (const link of document.querySelectorAll('a[href="./"]'))
  link.addEventListener('click', (event) => {
    event.preventDefault();
    void open();
  });
app.ontoolresult = (result) => {
  void show(result);
};
app.onhostcontextchanged = (context) => {
  if (context.theme)
    document.documentElement.classList.toggle('theme-dark', context.theme === 'dark');
};
try {
  await app.connect();
  document.documentElement.classList.toggle('theme-dark', app.getHostContext()?.theme === 'dark');
} catch {
  document.getElementById('connection-status').textContent =
    '当前宿主未连接交互面板，请使用对话中的实验页。';
}
