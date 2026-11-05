import { existsSync, readFileSync } from 'node:fs';
export const UI_URI = 'ui://rdk-robot-learning-platform/experiment';
export const UI_MIME = 'text/html;profile=mcp-app';
const resource = new URL('../ui/experiment.html', import.meta.url);
export const UI_HTML = existsSync(resource) ? readFileSync(resource, 'utf8') : null;
export const UI_TOOLS = new Set([
  'rdk_experiment_remember',
  'rdk_experiment_resume',
  'rdk_originman_short_train',
  'rdk_originman_short_evaluate',
  'rdk_originman_train',
  'rdk_originman_evaluate',
]);
export const uiSupported = (params) => {
  const types = params?.capabilities?.extensions?.['io.modelcontextprotocol/ui']?.mimeTypes;
  return Array.isArray(types) && types.includes(UI_MIME);
};
export const uiMetadata = {
  ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] }, prefersBorder: true },
};
export function uiResource(html) {
  if (typeof html !== 'string' || !html || Buffer.byteLength(html) > 2 * 1024 * 1024)
    throw Error('交互视图缺失或超出预算；请打开平台实验页。');
  return { contents: [{ uri: UI_URI, mimeType: UI_MIME, text: html, _meta: uiMetadata }] };
}
