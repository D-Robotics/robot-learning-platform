/**
 * Type declarations for scripts/reward-vocabulary.mjs (allowJs is off; the
 * vocabulary stays a plain .mjs because `resolve-task-pack.mjs` is executed
 * directly by Node and imports it, so its surface is declared here instead).
 */

export type RewardQuantity =
  'action' | 'goal' | 'heading' | 'pose' | 'attitude' | 'contact' | 'body_rate';

export type RewardEngine = 'starter-ppo' | 'mjx-ppo';

export type RewardOp = 'potential' | 'shaping' | 'penalty' | 'bonus' | 'rate_limit' | 'smoothness';

export interface RewardFormulaTerm {
  op: RewardOp;
  term: string;
  /** Positive magnitude; the `op` decides the direction of payment. */
  weight: number;
  params?: Record<string, number | string>;
  /** Only for `smoothness`: keep the term off until the skill exists. */
  curriculum?: { introduceAfterIteration: number };
}

export interface RewardTermSpec {
  quantity: RewardQuantity;
  describes: string;
}

export const REWARD_QUANTITIES: readonly RewardQuantity[];
export const REWARD_ENGINE_QUANTITIES: Readonly<Record<RewardEngine, readonly RewardQuantity[]>>;
export const REWARD_TERMS: Readonly<Record<string, RewardTermSpec>>;
export const REWARD_OPS: Readonly<Record<RewardOp, { pays: string; curriculum: boolean }>>;

export function validateRewardFormula(
  value: unknown,
  engine: RewardEngine,
): { terms: RewardFormulaTerm[]; errors: string[] };

export function normalizeRewardFormula(value: unknown, engine: RewardEngine): RewardFormulaTerm[];

export function expandLegacyRewardMap(
  reward: Readonly<Record<string, unknown>> | undefined,
  engine: RewardEngine,
): RewardFormulaTerm[];

export function resolveRewardFormula(
  pack: { reward?: Record<string, unknown>; rewardFormula?: unknown },
  engine: RewardEngine,
): RewardFormulaTerm[];
