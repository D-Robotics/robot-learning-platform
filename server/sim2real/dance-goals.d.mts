import type { Request, Response, RequestHandler, Router } from 'express';
import type { Sim2RealAuthPort } from './sim2real-auth.js';
import type { findSim2RealRunByIdempotency } from './sim2real-store.js';

export function setupDanceGoals(options: {
  callerAuth: Sim2RealAuthPort;
  prefix: string;
  storageDirectory: string;
  defaultPort: number;
  findRun: typeof findSim2RealRunByIdempotency;
}): {
  auth: Sim2RealAuthPort;
  register(
    router: Router,
    readOwner: (req: Request, res: Response) => string | undefined | null,
    wrap: (fn: (req: Request, res: Response) => Promise<unknown>) => RequestHandler,
    mount?: string,
  ): void;
};
