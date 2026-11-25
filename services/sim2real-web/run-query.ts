import { lookupSim2RealRun } from '../../server/sim2real/sim2real-store.js';
import { resolveRunPolicyDownload } from '../../server/sim2real/run-policy.js';

const RUN_ID = /^[a-f0-9][a-f0-9-]{7,35}$/i;
const QUERY_LEAD =
  /^(?:请|帮我|麻烦)?\s*(?:只读\s*)?(?:再\s*)?(?:查一下|查查|查看|查询|查|核对(?:一下)?|确认(?:一下)?|看看|看一下)\s*/u;
const READ_ONLY =
  /^(?:只查已有结果|只看已有结果|只读|请实时只读核对|别用历史答案|把下载链接也给我|给我下载链接|状态呢)$/u;
// Match the whole request. Mixed requests (such as a lookup followed by a
// training command) remain subject to the existing Agent and its approvals.
export function parseRunQuery(message: string) {
  if (message.length > 320) return null;
  const [first, ...rest] = message
    .split(/[。！？；，、,!;?\n]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!first) return null;
  const scope = first.replace(QUERY_LEAD, '');
  const explicit = /^(?:训练\s*)?Run\s*([a-f0-9-]{8,36})(?:\s*的\s*(.*))?$/iu.exec(scope);
  const previous = /^(?:刚才|上一轮)(?:的)?(?:那|这)?条?\s*Run(?:\s*的\s*(.*))?$/iu.exec(scope);
  if (!explicit && !previous) return null;
  const id = explicit?.[1];
  if (id && !RUN_ID.test(id)) return null;
  const fields = [explicit?.[2] ?? previous?.[1], ...rest].filter((part): part is string =>
    Boolean(part),
  );
  const wantsPolicy = fields.some((part) => /策略|留存|下载|ONNX/i.test(part));
  const allowed = fields.every(
    (field) =>
      READ_ONLY.test(field) ||
      /^(?:(?:策略)?(?:已经|是否|已)?留存(?:了吗|吗)?|(?:训练)?状态|终态|(?:ONNX\s*)?下载(?:链接)?)(?:\s*(?:和|与|及)\s*(?:(?:ONNX\s*)?下载(?:链接)?|(?:策略)?留存(?:状态)?|(?:训练)?状态))*$/iu.test(
        field,
      ),
  );
  return allowed ? { id, wantsPolicy } : null;
}

const RETENTION_MS = 15 * 60_000;
const SESSION_LIMIT = 256;

export function createRunQuery() {
  const recent = new Map<string, { id: string; expiresAt: number }>();
  const recorded = (key: string) => {
    const value = recent.get(key);
    return value && value.expiresAt > Date.now() ? value.id : undefined;
  };
  return {
    forget(key: string) {
      recent.delete(key);
    },
    async answer(
      query: NonNullable<ReturnType<typeof parseRunQuery>>,
      key: string,
      owner: string | undefined,
      accountId: string,
      publicPath: (pathname: string) => string,
      signal: AbortSignal,
    ) {
      const id = query.id ?? recorded(key);
      recent.delete(key);
      if (!id)
        return {
          text: '本会话没有刚刚确认的 Run。请发完整 Run ID 或至少 8 位前缀。',
          toolTrail: [],
        };
      signal.throwIfAborted();
      const { run, ambiguous } = await lookupSim2RealRun(id, owner);
      const trail = { name: 'platform_run_lookup', step: 1, ok: Boolean(run) };
      if (!run)
        return {
          text: ambiguous
            ? '这个 Run 短 ID 匹配多条记录，请提供更长的前缀或完整 ID。'
            : '运行记录不存在，或不属于当前账号。',
          toolTrail: [trail],
        };
      const result = query.wantsPolicy
        ? await resolveRunPolicyDownload(run, owner, accountId, { timeoutMs: 8_000 })
        : undefined;
      signal.throwIfAborted();
      if (recent.size >= SESSION_LIMIT) {
        const oldest = recent.keys().next().value;
        if (oldest) recent.delete(oldest);
      }
      recent.set(key, { id: run.id, expiresAt: Date.now() + RETENTION_MS });

      const status =
        {
          cancelled: '已取消',
          cancelling: '取消中',
          ready: '就绪',
          queued: '排队中',
          running: '运行中',
          completed: '已完成',
          failed: '失败',
          blocked: '已阻断',
        }[run.status] ?? run.status;
      const policyDownload = result?.ok
        ? publicPath('/api/v1/duck/runs/' + encodeURIComponent(run.id) + '/artifact')
        : undefined;
      const text = [`Run \`${run.id}\` · ${status}。`];
      if (result) {
        const retentionText = {
          retained: '平台已留存这份 ONNX，摘要核验通过。',
          'not-retained': '平台尚未留存这份 ONNX。',
          'not-applicable': '此 Run 不适用平台 ONNX 留存。',
          unavailable: '平台留存状态暂无法核验。',
        }[result.retention.state];
        text.push(
          retentionText,
          result.ok
            ? result.source === 'platform-retained'
              ? '可从平台留存副本下载。'
              : '已实时核验执行端 ONNX 的摘要，可以下载。'
            : result.message,
        );
      }
      return {
        text: text.join('\n'),
        toolTrail: [trail],
        ...(policyDownload ? { policyDownload } : {}),
      };
    },
  };
}
