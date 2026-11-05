/** Host instructions only. Creation never opens a browser or proves playback. */
export function createPlaybackPlan(result) {
  const blocked = (reason) => ({ available: false, verifiedInPlayer: false, reason });
  if (
    result?.association?.executionVerified !== true ||
    result?.playback?.state !== 'recorded' ||
    result?.evaluation?.status !== 'completed'
  )
    return blocked('尚无本次同源评测的完整视频回执，不自动播放或重交评测。');
  const ids = [result.contextId, result.training?.runId, result.evaluation?.runId];
  if (!ids.every((id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(id)))
    return blocked('原实验标识不完整，保留原任务，不猜测或选择最近视频。');
  let page;
  try {
    page = new URL(result.links?.experiment);
    if (
      !['https:', 'http:'].includes(page.protocol) ||
      page.username ||
      page.password ||
      !page.pathname.endsWith('/experiment.html') ||
      page.searchParams.get('context') !== result.contextId
    )
      return blocked('缺少绑定本次实验的页面入口；旧工作台需按原Run核对选择器。');
  } catch {
    return blocked('没有本次实验页地址，不改用原始媒体URL。');
  }
  const expected = {
    origin: page.origin,
    pathname: page.pathname,
    contextId: result.contextId,
    trainingRunId: result.training.runId,
    evaluationRunId: result.evaluation.runId,
    videoPath:
      page.pathname.slice(0, -'experiment.html'.length) +
      'api/v1/duck/runs/' +
      encodeURIComponent(result.evaluation.runId) +
      '/workshop-video',
  };
  const guard = `const expected=${JSON.stringify(expected)};
if(location.origin!==expected.origin || location.pathname!==expected.pathname || new URL(location.href).searchParams.get('context')!==expected.contextId) throw Error('实验页面身份不符，停止播放');
const d=document.getElementById('experiment-diagnostics');
const state=JSON.parse(d?.textContent || '{}');
if(state.contextId!==expected.contextId || state.training?.runId!==expected.trainingRunId || state.evaluation?.runId!==expected.evaluationRunId || state.associationVerified!==true) throw Error('训练、评测或同源校验不符，停止播放');
const v=document.getElementById('experiment-video');
if(!v) throw Error('没有本次评测播放器');
const source=new URL(v.currentSrc || v.getAttribute('src') || '',location.href);
if(source.origin!==expected.origin || source.pathname!==expected.videoPath) throw Error('视频来源不是本次评测，停止播放');
const read=()=>({contextId:state.contextId,trainingRunId:state.training.runId,evaluationRunId:state.evaluation.runId,src:source.href,currentTime:v.currentTime,duration:Number.isFinite(v.duration)?v.duration:null,paused:v.paused,ended:v.ended,readyState:v.readyState,visibility:document.visibilityState,error:v.error?{code:v.error.code,message:v.error.message}:null});`;
  return {
    available: true,
    surface: 'qoder-in-app',
    verifiedInPlayer: false,
    expected,
    requiredToolNames: [
      'list_pages',
      'navigate_page',
      'select_page',
      'take_snapshot',
      'evaluate_script',
    ],
    discovery:
      '检索并核对mcp__browser-use__下工具描述为Qoder in-app browser。它们是内置工具，不是同名browser-use Skill；不要加载外部Browser Connector Skill或createBrowserAgent。',
    steps: [
      '用内置navigate_page打开本次experiment页，list_pages精确匹配expected.origin/pathname/context，取实际pageId，执行select_page({pageId,bringToFront:true})使内置面板真正可见，再take_snapshot。仅选中标签页不等于面板显示；不要猜pageId。参考观察也用同一置前步骤。',
      '用内置evaluate_script执行probeScript，必须visibility=visible且本次同源校验通过后才启动。hidden时先再次select_page({pageId,bringToFront:true})，再只读确认；不要让学员手动展开面板。初始readyState=0或时长未知只说明尚未请求媒体，不是视频损坏。',
      '执行startScript一次；它先核对可见性和本轮来源，再只对本视频静音play()，返回起点和约1.5秒后的真实samples，避免短视频在模型下轮调用前播完。不会seek、重置时间、修改证据或再次提交任务。',
      '仍在同一页面用probeScript读取真实时间推进及ended=true；可用内置wait_for等候“本次回放已结束”，最多20秒。保留至少一个中间进度和最后状态。已经ended的旧页面不能当本轮从起点播放的证明。',
      '只有观察到同源视频的currentTime实际推进且ended=true，才报告回放已完成。被拒播、媒体错误、超时或缺工具时保留真实未通过，不改浏览器安全设置、不切外部浏览器、不重训、不重提评测。',
    ],
    probeScript: `()=>{${guard}\nreturn read();}`,
    startScript: `async()=>{${guard}
if(document.visibilityState!=='visible') throw Error('内置面板尚不可见，先select_page bringToFront:true再核对，不启动播放');
if(v.error) throw Error('本次媒体有错误，保留原评测');
if(!v.paused || v.ended) return read();
const before=read();
v.muted=true; v.playsInline=true;
let timer;
try { await Promise.race([v.play(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('播放启动超时，结果待核对，不重复启动')),12000);})]); }
finally { clearTimeout(timer); }
await new Promise(resolve=>setTimeout(resolve,1500));
const after=read();
return {...after,samples:[before,after]};}`,
    evidenceBoundary:
      '计划与脚本不是实际执行或播放证明；DOM观察是宿主本轮证据，不是平台签发或实体资格。',
  };
}
