import type { Request, Response, Router } from 'express';
import { OriginmanSimulator } from '../sim2real/originman-simulator.js';
import { sendApiError, wrapAsync } from '../sim2real/http-helpers.js';

type Policy = { bytes: Buffer; sha256: string; sourceRunId: string };
const simulator = new OriginmanSimulator();
export function registerOriginmanSimulatorRoutes(
  router: Router,
  deps: {
    api: (path: string) => string;
    owner: (request: Request, response: Response) => string | undefined | null;
    policy: (runId: string, owner: string | undefined) => Promise<Policy | null>;
  },
) {
  const fail = (response: Response, error: unknown) => {
    const code = error instanceof Error ? error.message : '';
    const status =
      code === 'simulation_not_found'
        ? 404
        : code === 'simulation_quota'
          ? 429
          : code === 'invalid_command'
            ? 400
            : code === 'simulation_busy'
              ? 409
              : 503;
    sendApiError(
      response,
      status,
      'SIM2REAL_ORIGINMAN_SIMULATION_ERROR',
      status === 404
        ? '仿真会话不存在、已过期或不属于当前账号。'
        : status === 400
          ? '仿真命令或参数不合法。'
          : status === 429
            ? '交互仿真资源已满，请停止一个会话后重试。'
            : '仿真暂不可用，请重新启动；已有训练和评测记录仍保留。',
    );
  };
  router.post(
    deps.api('/workshops/originman/sessions'),
    wrapAsync(async (request, response) => {
      const owner = deps.owner(request, response);
      if (owner === null) return;
      response.setHeader('Cache-Control', 'no-store');
      const body = request.body;
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).some((k) => !['sourceRunId', 'renderMode'].includes(k)) ||
        (body.renderMode !== undefined && !['jpeg', 'webgl'].includes(body.renderMode)) ||
        (body.sourceRunId !== undefined &&
          (typeof body.sourceRunId !== 'string' ||
            !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(body.sourceRunId)))
      ) {
        fail(response, new Error('invalid_command'));
        return;
      }
      try {
        const policy = body.sourceRunId ? await deps.policy(body.sourceRunId, owner) : null;
        if (body.sourceRunId && !policy) {
          sendApiError(
            response,
            409,
            'SIM2REAL_WORKSHOP_SOURCE_INVALID',
            '所选训练的权重不可读取或校验未通过；不会改用其他模型。',
          );
          return;
        }
        const result = await simulator.create(
          owner ?? 'local-dev',
          policy ?? undefined,
          body.renderMode ?? 'jpeg',
        );
        response
          .status(201)
          .json({ ...result, sourceRunId: policy?.sourceRunId ?? null, simulationOnly: true });
      } catch (error) {
        fail(response, error);
      }
    }),
  );
  router.post(
    deps.api('/workshops/originman/sessions/:id/command'),
    wrapAsync(async (request, response) => {
      const owner = deps.owner(request, response);
      if (owner === null) return;
      response.setHeader('Cache-Control', 'no-store');
      try {
        response.json(
          await simulator.command(String(request.params.id), owner ?? 'local-dev', request.body),
        );
      } catch (error) {
        fail(response, error);
      }
    }),
  );
  router.post(
    deps.api('/workshops/originman/sessions/:id/teleop-rehearsal'),
    wrapAsync(async (request, response) => {
      const owner = deps.owner(request, response);
      if (owner === null) return;
      response.setHeader('Cache-Control', 'no-store');
      try {
        const [status, payload] = simulator.teleop(
          String(request.params.id),
          owner ?? 'local-dev',
          request.body,
        );
        response.status(status).json(payload);
      } catch (error) {
        fail(response, error);
      }
    }),
  );
  router.delete(
    deps.api('/workshops/originman/sessions/:id'),
    wrapAsync(async (request, response) => {
      const owner = deps.owner(request, response);
      if (owner === null) return;
      if (!simulator.close(String(request.params.id), owner ?? 'local-dev')) {
        fail(response, new Error('simulation_not_found'));
        return;
      }
      response.setHeader('Cache-Control', 'no-store');
      response.json({ ok: true });
    }),
  );
}
