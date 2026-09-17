#!/usr/bin/env node

/**
 * Declarative reward vocabulary: the closed set of reward terms a task pack may
 * declare, and the ops that decide how each one pays.
 *
 * ## Why this exists
 *
 * The reward a policy optimises used to be a fixed five-key expression written
 * into each engine. A pack could tune the numbers but not the terms, so whole
 * classes of hard-won reward-engineering lessons -- potential-based shaping,
 * rate-limited goal payment, hardening smoothness only after a skill exists --
 * were inexpressible. Worse, the two engines disagreed about a *missing* key:
 * `starter-ppo` raised `KeyError` while `mjx-adapter` silently treated the term
 * as zero, and nothing in the platform noticed.
 *
 * This module makes the reward a *validated declaration*:
 *
 * - a pack names `rewardFormula`, or keeps the legacy `reward` map, which is
 *   expanded into the equivalent formula;
 * - every `op` / `term` / `params` / `curriculum` key is checked closed --
 *   unknown anything is an error, never ignored;
 * - each term declares the physical quantity it needs, and a pack is refused
 *   when the target engine cannot measure it.
 *
 * The last point is the load-bearing one: a term the engine cannot observe must
 * fail at validation, because the alternative is a reward that looks like it
 * penalises something and in fact contributes nothing.
 *
 * ## Sign convention, encoded instead of documented
 *
 * With a bare key map, getting a sign wrong turns a penalty into a payment for
 * the violation, and the policy farms it. Here the `op` decides the direction
 * (`potential`/`shaping` pay improvement, `penalty` charges, `bonus` pays), so a
 * pack author supplies a positive magnitude and never reasons about signs.
 */

/** Physical quantity a term measures; used for engine capability matching. */
export const REWARD_QUANTITIES = Object.freeze([
  'action',
  'goal',
  'heading',
  'pose',
  'attitude',
  'contact',
  'body_rate',
]);

/**
 * Which quantities an engine can actually measure.
 *
 * `starter-ppo` drives a 2D kinematic model: distance, heading and the action are
 * observable, but there is no attitude and no contact, so an attitude-shaped
 * reward is not merely unimplemented there -- it is unmeasurable. The MJX
 * adapter runs real contact dynamics and already computes projected gravity and
 * body rates, so it can serve those.
 */
export const REWARD_ENGINE_QUANTITIES = Object.freeze({
  'starter-ppo': Object.freeze(['action', 'goal', 'heading']),
  'mjx-ppo': Object.freeze(['action', 'goal', 'heading', 'attitude', 'contact', 'body_rate']),
});

/**
 * The closed set of measurable terms, each with the quantity it needs.
 *
 * `progress` and `heading` are shaping signals: they pay for improvement and are
 * zero when the policy holds still, which is what makes them unfarmable.
 * `goal_reach` is declared here so a pack can name it under a rate limit -- an
 * ungated repeated goal payment is the jackpot pattern.
 */
export const REWARD_TERMS = Object.freeze({
  // `improves` states which direction of the measurement is progress. It is not
  // decoration: `progress` is a DISTANCE that improves by falling, while
  // `proximity` improves by rising, and a shaping term that gets this backwards
  // pays the policy for walking away from the goal. The historical formula
  // encoded the direction as `prev - curr`; declaring it per term keeps that
  // information in the vocabulary instead of in one expression's algebra.
  progress: { quantity: 'goal', improves: 'falls', describes: 'distance to the goal' },
  heading: { quantity: 'heading', improves: 'rises', describes: 'alignment with the goal bearing' },
  goal_reach: { quantity: 'goal', improves: 'rises', describes: 'reaching the goal radius' },
  goal_hold: { quantity: 'goal', improves: 'rises', describes: 'remaining inside the goal radius' },
  proximity: { quantity: 'goal', improves: 'rises', describes: 'goal proximity, in [0, 1]' },
  collision: {
    quantity: 'goal',
    improves: 'falls',
    describes: 'contact with an obstacle or bound',
  },
  action_magnitude: { quantity: 'action', improves: 'falls', describes: 'mean absolute action' },
  action_rate: {
    quantity: 'action',
    improves: 'falls',
    describes: 'squared change between actions',
  },
  upright: {
    quantity: 'attitude',
    improves: 'rises',
    describes: 'cosine of the tilt angle from vertical',
  },
  accel_z: { quantity: 'contact', improves: 'falls', describes: 'vertical impact acceleration' },
  body_rate: { quantity: 'body_rate', improves: 'falls', describes: 'body angular rate magnitude' },
});

/**
 * Operator semantics.
 *
 * - `potential` / `shaping` pay *improvement*: the term is evaluated for the
 *   previous and current state and the weight multiplies the difference. Holding
 *   still pays zero, so neither can be farmed. `shaping` is the same arithmetic
 *   declared for a directional signal, so a pack states its intent instead of
 *   relying on a reader to know which terms are frame-invariant.
 * - `penalty` charges an instantaneous magnitude; `bonus` pays one. Both take a
 *   positive magnitude -- the op carries the direction.
 * - `rate_limit` makes a repeated payment monotone through a slewed internal
 *   target, so arriving early buys nothing and no jackpot exists.
 * - `smoothness` is a penalty that may be scheduled: a regulariser introduced
 *   before the skill exists makes "do nothing" the argmax.
 */
export const REWARD_OPS = Object.freeze({
  potential: { pays: 'improvement', curriculum: false },
  shaping: { pays: 'improvement', curriculum: false },
  penalty: { pays: 'instant', curriculum: false },
  bonus: { pays: 'instant', curriculum: false },
  rate_limit: { pays: 'slewed', curriculum: false },
  smoothness: { pays: 'instant', curriculum: true },
});

/** Parameters each term accepts, closed. */
const TERM_PARAMS = Object.freeze({
  upright: ['axis'],
  accel_z: ['smooth'],
});

const MAX_FORMULA_TERMS = 24;
const MAX_WEIGHT = 1000;

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Validates a declared formula against the vocabulary and one engine's
 * capabilities. Returns every problem found rather than throwing, so a caller
 * can report them together.
 */
export function validateRewardFormula(value, engine) {
  const errors = [];
  if (!Array.isArray(value)) {
    return { terms: [], errors: ['rewardFormula must be an array of terms'] };
  }
  if (value.length > MAX_FORMULA_TERMS) {
    errors.push(`rewardFormula must contain at most ${MAX_FORMULA_TERMS} terms`);
  }
  const available = REWARD_ENGINE_QUANTITIES[engine];
  if (!available) {
    return { terms: [], errors: [`unknown engine ${JSON.stringify(engine)}`] };
  }
  const terms = [];
  value.slice(0, MAX_FORMULA_TERMS).forEach((raw, index) => {
    const where = `rewardFormula[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${where} must be an object`);
      return;
    }
    const allowed = new Set(['op', 'term', 'weight', 'params', 'curriculum']);
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) errors.push(`${where} has unknown field ${JSON.stringify(key)}`);
    }
    const op = raw.op;
    if (typeof op !== 'string' || !(op in REWARD_OPS)) {
      errors.push(
        `${where}.op must be one of ${Object.keys(REWARD_OPS).join(', ')} (got ${JSON.stringify(op)})`,
      );
      return;
    }
    const spec = REWARD_TERMS[raw.term];
    if (!spec) {
      errors.push(
        `${where}.term must be one of ${Object.keys(REWARD_TERMS).join(', ')} (got ${JSON.stringify(raw.term)})`,
      );
      return;
    }
    // Engine capability. A term whose quantity cannot be measured is refused
    // here: letting it through would produce a reward term that reads as
    // meaningful and contributes nothing.
    if (!available.includes(spec.quantity)) {
      errors.push(
        `${where}.term ${JSON.stringify(raw.term)} measures ${spec.quantity} (${spec.describes}), ` +
          `which ${engine} cannot observe`,
      );
      return;
    }
    if (!isFiniteNumber(raw.weight) || raw.weight <= 0 || raw.weight > MAX_WEIGHT) {
      // A non-positive weight is rejected rather than reinterpreted: the op
      // already carries the direction, so zero or negative is a mistake about
      // intent, not a sign to honour.
      errors.push(`${where}.weight must be a positive magnitude at most ${MAX_WEIGHT}`);
      return;
    }
    let params;
    if (raw.params !== undefined) {
      if (!raw.params || typeof raw.params !== 'object' || Array.isArray(raw.params)) {
        errors.push(`${where}.params must be an object`);
        return;
      }
      const accepted = TERM_PARAMS[raw.term] || [];
      params = {};
      for (const [key, param] of Object.entries(raw.params)) {
        if (!accepted.includes(key)) {
          errors.push(
            `${where}.params has unknown key ${JSON.stringify(key)} for term ${JSON.stringify(raw.term)}` +
              (accepted.length ? ` (accepts ${accepted.join(', ')})` : ' (accepts none)'),
          );
          return;
        }
        if (typeof param === 'string') {
          if (key === 'axis' && !['x', 'y', 'z'].includes(param)) {
            errors.push(`${where}.params.axis must be "x", "y" or "z"`);
            return;
          }
          params[key] = param;
        } else if (typeof param === 'boolean') {
          params[key] = param ? 1 : 0;
        } else if (isFiniteNumber(param)) {
          params[key] = param;
        } else {
          errors.push(`${where}.params.${key} must be a number, string or boolean`);
          return;
        }
      }
    }
    let curriculum;
    if (raw.curriculum !== undefined) {
      if (!REWARD_OPS[op].curriculum) {
        errors.push(`${where}.curriculum is only meaningful for a "smoothness" term`);
        return;
      }
      if (!raw.curriculum || typeof raw.curriculum !== 'object' || Array.isArray(raw.curriculum)) {
        errors.push(`${where}.curriculum must be an object`);
        return;
      }
      for (const key of Object.keys(raw.curriculum)) {
        if (key !== 'introduceAfterIteration') {
          errors.push(`${where}.curriculum has unknown field ${JSON.stringify(key)}`);
          return;
        }
      }
      const after = raw.curriculum.introduceAfterIteration;
      if (!isFiniteNumber(after) || !Number.isSafeInteger(after) || after < 0) {
        errors.push(`${where}.curriculum.introduceAfterIteration must be a non-negative integer`);
        return;
      }
      curriculum = { introduceAfterIteration: after };
    }
    terms.push({
      op,
      term: raw.term,
      weight: raw.weight,
      ...(params && Object.keys(params).length ? { params } : {}),
      ...(curriculum ? { curriculum } : {}),
    });
  });
  // Direction is attached here, at the single exit, so the declared path and the
  // legacy-expansion path cannot disagree about it. Attaching it in only one of
  // them is exactly how `progress` briefly paid the policy for walking away.
  return { terms: terms.map(withDirection), errors };
}

/** Attaches the term's declared improvement direction to a validated entry. */
function withDirection(entry) {
  const spec = REWARD_TERMS[entry.term];
  return spec ? { ...entry, improves: spec.improves } : entry;
}

/** Validates and returns the normalized formula, throwing with every problem. */
export function normalizeRewardFormula(value, engine) {
  const { terms, errors } = validateRewardFormula(value, engine);
  if (errors.length) throw new Error(errors.join('; '));
  return terms;
}

/**
 * Expands the legacy fixed-key `reward` map into the equivalent formula.
 *
 * This is what keeps every pre-existing pack's behaviour unchanged while leaving
 * exactly one semantic path in the engines. The mapping is a pure function of the
 * map, so it can be checked numerically against the historical hard-coded
 * expressions (see `tests/test_reward_expansion_parity.py`).
 *
 *   progress      -> potential            (pays distance closed)
 *   goal          -> rate_limit           (an ungated repeated goal payment is a
 *                                          jackpot; the default slew reproduces
 *                                          the historical one-shot payment)
 *   collision     -> penalty
 *   actionPenalty -> penalty
 *   dwell         -> bonus                (goal_hold, inside the goal radius)
 *   fallPenalty   -> penalty
 */
export function expandLegacyRewardMap(reward, engine) {
  const map = reward || {};
  const errors = [];
  const terms = [];
  const numeric = (key) => {
    const value = map[key];
    if (value === undefined) return undefined;
    if (!isFiniteNumber(value)) {
      errors.push(`reward.${key} must be a finite number`);
      return undefined;
    }
    return value;
  };
  const magnitude = (key) => {
    const value = numeric(key);
    if (value === undefined || value === 0) return undefined;
    return Math.abs(value);
  };
  // A sign that contradicts the term's meaning is rejected rather than silently
  // reinterpreted: a positive `collision` was paying for collisions.
  const penalty = (key, term) => {
    const value = numeric(key);
    if (value === undefined) return;
    if (value > 0) {
      errors.push(`reward.${key} is a penalty but is configured positive (${value})`);
      return;
    }
    if (value === 0) return;
    terms.push({ op: 'penalty', term, weight: Math.abs(value) });
  };
  const bonus = (key, term) => {
    const value = numeric(key);
    if (value === undefined) return;
    if (value < 0) {
      errors.push(`reward.${key} is a bonus but is configured negative (${value})`);
      return;
    }
    if (value === 0) return;
    terms.push({ op: 'bonus', term, weight: value });
  };

  const progress = magnitude('progress');
  if (progress !== undefined) terms.push({ op: 'potential', term: 'progress', weight: progress });
  const goal = magnitude('goal');
  if (goal !== undefined) terms.push({ op: 'rate_limit', term: 'goal_reach', weight: goal });
  penalty('collision', 'collision');
  penalty('actionPenalty', 'action_magnitude');
  bonus('dwell', 'goal_hold');
  // `fallPenalty` lives in the engine hyperparameters rather than the pack; a
  // pack that declares one is honoured, and the engine's own default remains.
  penalty('fallPenalty', 'collision');

  for (const key of Object.keys(map)) {
    if (!['progress', 'goal', 'collision', 'actionPenalty', 'dwell', 'fallPenalty'].includes(key)) {
      errors.push(`reward has unknown key ${JSON.stringify(key)}`);
    }
  }
  if (errors.length) throw new Error(errors.join('; '));

  // Validate first (the validator accepts only author-facing fields, and
  // `improves` is engine-facing), then attach the direction.
  const { errors: capabilityErrors } = validateRewardFormula(terms, engine);
  if (capabilityErrors.length) throw new Error(capabilityErrors.join('; '));
  return terms.map(withDirection);
}

/**
 * The formula a pack will actually run: its declared `rewardFormula` when
 * present, otherwise the expansion of its legacy `reward` map.
 *
 * A pack carrying both is refused -- two sources of truth for one reward is
 * exactly the ambiguity this module exists to remove.
 */
export function resolveRewardFormula(pack, engine) {
  if (pack.rewardFormula !== undefined && pack.reward !== undefined) {
    throw new Error(
      'a pack must declare either reward (legacy) or rewardFormula, not both: the formula would be ambiguous',
    );
  }
  if (pack.rewardFormula !== undefined) return normalizeRewardFormula(pack.rewardFormula, engine);
  return expandLegacyRewardMap(pack.reward, engine);
}
