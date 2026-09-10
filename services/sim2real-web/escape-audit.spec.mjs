#!/usr/bin/env node
/**
 * Dependency-free HTML-injection audit for the workbench front-end.
 *
 * The UI is hand-written classic-script JavaScript (no framework, no bundler),
 * so nothing structurally prevents a server-provided string from reaching
 * `innerHTML`. This audit enforces one invariant:
 *
 *   every interpolation inside a template literal that is written to
 *   innerHTML / outerHTML must be produced by a reviewed escaping or
 *   formatting helper — never a raw value.
 *
 * Values that are genuinely safe but not statically provable (a local
 * formatter, a literal ternary bound to a const) must be made explicit with a
 * site-level opt-out carrying a reason:
 *
 *   // escape-audit:allow <short reason>
 *
 * The opt-out goes on the assignment line, or on the interpolation's own line
 * *after* the closing backtick/semicolon. A comment written inside a template
 * literal is rendered as text, so it does not count and will not be honoured.
 *
 * Run with `node services/sim2real-web/escape-audit.spec.mjs`.
 * This script is also wired into the `verify` chain as `verify:escape-audit`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGETS = [
  'public/app.js',
  'public/agent-chat.js',
  'public/telemetry-core.js',
  'public/onboarding.js',
  'public/originbot-dashboard.js',
];

/**
 * Callees that make an interpolation safe. Each entry records *why* it is
 * reviewed, so a future reader can re-check the claim instead of trusting a
 * bare name.
 */
const SAFE_CALLS = new Map([
  ['escapeHtml', 'escapes & < > " \' — the primary HTML text sink'],
  ['escapeAttr', 'attribute-value escaper for data-* / class payloads'],
  ['encodeURIComponent', 'URL component encoder; output cannot break out of an attribute'],
  ['encodeURI', 'URL encoder; output cannot break out of an attribute'],
  ['Number', 'coerces to a numeric literal'],
]);

/**
 * Pure formatters whose return domain is a fixed set of literals or a
 * locale-formatted date. They are reviewed here because the audit cannot see
 * through the function body; re-check these when the functions change.
 */
const REVIEWED_FORMATTERS = new Map([
  ['stateClass', 'returns one of state-success/state-partial/state-error/state-neutral'],
  ['statusLabel', 'returns a fixed label from a closed status map'],
  ['formatDate', 'returns a zh-CN locale date string or the em-dash placeholder'],
]);

const ALLOW_PATTERNS = [
  /\/\/\s*escape-audit:allow\s+(\S.*)$/,
  /\/\*\s*escape-audit:allow\s+([^*]+?)\s*\*\//,
];

/**
 * Mark every character that belongs to a template literal's *text* (as opposed
 * to code inside `${...}` or outside any template). An opt-out comment written
 * in template text would be rendered into the page, so it must not be honoured.
 */
function buildTemplateMask(source) {
  const mask = new Uint8Array(source.length);
  const walk = (from, to) => {
    let i = from;
    while (i < to) {
      const ch = source[i];
      if (ch === "'" || ch === '"') {
        i = skipString(source, i);
        continue;
      }
      if (ch === '`') {
        const { end, interpolations } = scanTemplate(source, i);
        let cursor = i + 1;
        for (const interpolation of interpolations) {
          for (let k = cursor; k < interpolation.at; k += 1) mask[k] = 1;
          walk(interpolation.at + 2, Math.max(interpolation.at + 2, interpolation.endAt - 1));
          cursor = interpolation.endAt;
        }
        for (let k = cursor; k <= Math.min(end, source.length - 1); k += 1) mask[k] = 1;
        i = end + 1;
        continue;
      }
      i += 1;
    }
  };
  walk(0, source.length);
  return mask;
}

class Violation {
  constructor(line, expression, reason) {
    this.line = line;
    this.expression = expression;
    this.reason = reason;
  }
}

/* ------------------------------------------------------------------ *
 * Small lexical helpers. They intentionally avoid a real parser: the
 * inputs are a handful of known call sites, and every helper below is
 * covered by the self-test at the bottom of this file.
 * ------------------------------------------------------------------ */

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

/** Index just past a quoted string starting at `start` (source[start] is the quote). */
function skipString(source, start) {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (ch === '\n' && quote !== '`') return i; // unterminated single-line string
    i += 1;
  }
  return source.length;
}

/**
 * Index of the backtick closing the template that starts at `start`, plus the
 * top-level interpolations found inside it.
 */
function scanTemplate(source, start) {
  const interpolations = [];
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') return { end: i, interpolations };
    if (ch === '$' && source[i + 1] === '{') {
      const exprStart = i + 2;
      let depth = 1;
      let j = exprStart;
      while (j < source.length && depth > 0) {
        const inner = source[j];
        if (inner === '\\') {
          j += 2;
          continue;
        }
        if (inner === '{') depth += 1;
        else if (inner === '}') depth -= 1;
        else if (inner === "'" || inner === '"') {
          j = skipString(source, j) - 1;
        } else if (inner === '`') {
          const nested = scanTemplate(source, j);
          j = nested.end;
        }
        j += 1;
      }
      interpolations.push({
        text: source.slice(exprStart, Math.max(exprStart, j - 1)),
        at: i,
        endAt: j,
      });
      i = j;
      continue;
    }
    i += 1;
  }
  return { end: source.length, interpolations };
}

/** Every template literal inside a snippet, as { start, end, interpolations }. */
function templatesIn(source, from, to) {
  const found = [];
  let i = from;
  while (i < to) {
    const ch = source[i];
    if (ch === "'" || ch === '"') {
      i = skipString(source, i);
      continue;
    }
    if (ch === '`') {
      const scanned = scanTemplate(source, i);
      found.push({ start: i, end: scanned.end, interpolations: scanned.interpolations });
      i = scanned.end + 1;
      continue;
    }
    i += 1;
  }
  return found;
}

/** Split `expr` on a top-level binary operator, ignoring brackets and strings. */
function splitTopLevel(expr, operator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === "'" || ch === '"') {
      i = skipString(expr, i);
      continue;
    }
    if (ch === '`') {
      i = scanTemplate(expr, i).end + 1;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (depth === 0 && expr.startsWith(operator, i)) {
      // Do not mistake `??` for a lone `?`, or `||` inside `??=`-like forms.
      if (operator === '?' && (expr[i + 1] === '?' || expr[i + 1] === '.')) {
        i += 1;
        continue;
      }
      parts.push(expr.slice(start, i));
      i += operator.length;
      start = i;
      continue;
    }
    i += 1;
  }
  parts.push(expr.slice(start));
  return parts;
}

function stripParens(expr) {
  let value = expr.trim();
  for (;;) {
    if (!value.startsWith('(') || !value.endsWith(')')) return value;
    let depth = 0;
    let closesAtEnd = true;
    for (let i = 0; i < value.length; i += 1) {
      const ch = value[i];
      if (ch === "'" || ch === '"') {
        i = skipString(value, i) - 1;
        continue;
      }
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0 && i !== value.length - 1) {
          closesAtEnd = false;
          break;
        }
      }
    }
    if (!closesAtEnd) return value;
    value = value.slice(1, -1).trim();
  }
}

/** If `expr` is exactly `callee(...)`, return the callee name. */
function wholeCallCallee(expr) {
  const match = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/.exec(expr);
  if (!match) return null;
  const open = match[0].length - 1;
  let depth = 0;
  for (let i = open; i < expr.length; i += 1) {
    const ch = expr[i];
    if (ch === "'" || ch === '"') {
      i = skipString(expr, i) - 1;
      continue;
    }
    if (ch === '`') {
      i = scanTemplate(expr, i).end;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i === expr.length - 1 ? match[1] : null;
    }
  }
  return null;
}

/** Split a top-level ternary into { whenTrue, whenFalse }, or null. */
function splitTernary(expr) {
  const parts = splitTopLevel(expr, '?');
  if (parts.length < 2) return null;
  const head = parts[0];
  const rest = expr.slice(head.length + 1);
  let depth = 0;
  let i = 0;
  while (i < rest.length) {
    const ch = rest[i];
    if (ch === "'" || ch === '"') {
      i = skipString(rest, i);
      continue;
    }
    if (ch === '`') {
      i = scanTemplate(rest, i).end + 1;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (depth === 0 && ch === '?')
      depth += 1000; // nested ternary: keep looking
    else if (depth === 0 && ch === ':') break;
    else if (depth >= 1000 && ch === ':') depth -= 1000;
    i += 1;
  }
  if (i >= rest.length) return null;
  return { whenTrue: rest.slice(0, i), whenFalse: rest.slice(i + 1) };
}

function classify(expr) {
  const value = stripParens(expr);
  if (!value) return 'empty interpolation';
  if (/^(true|false|null|undefined)$/.test(value)) return null;
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return null;
  if (/^'(?:[^'\\]|\\.)*'$/s.test(value) || /^"(?:[^"\\]|\\.)*"$/s.test(value)) return null;
  if (value.startsWith('`')) {
    const scanned = scanTemplate(value, 0);
    for (const nested of scanned.interpolations) {
      const reason = classify(nested.text);
      if (reason) return reason;
    }
    return null;
  }
  for (const operator of ['+', '??', '||', '&&']) {
    const parts = splitTopLevel(value, operator);
    if (parts.length > 1) {
      for (const part of parts) {
        const reason = classify(part);
        if (reason) return reason;
      }
      return null;
    }
  }
  const ternary = splitTernary(value);
  if (ternary) {
    for (const branch of [ternary.whenTrue, ternary.whenFalse]) {
      const reason = classify(branch);
      if (reason) return reason;
    }
    return null;
  }
  const callee = wholeCallCallee(value);
  if (callee) {
    if (SAFE_CALLS.has(callee) || REVIEWED_FORMATTERS.has(callee)) return null;
    if (/^Math\./.test(callee)) return null;
    return `call to ${callee}() is not a reviewed escaping/formatter helper`;
  }
  // A trailing `.length` is a number by construction.
  if (/\.length$/.test(value)) return null;
  return 'raw value interpolated without an escaping helper';
}

/* ------------------------------------------------------------------ *
 * Assignment-site scanning
 * ------------------------------------------------------------------ */

/** Index just past the `;` closing the statement that starts at `from`. */
function statementEnd(source, from) {
  let depth = 0;
  let i = from;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'" || ch === '"') {
      i = skipString(source, i);
      continue;
    }
    if (ch === '`') {
      i = scanTemplate(source, i).end + 1;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ';' && depth === 0) return i;
    i += 1;
  }
  return source.length;
}

function auditSource(source) {
  const violations = [];
  const lines = source.split('\n');
  const lineStarts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') lineStarts.push(i + 1);
  }
  const templateMask = buildTemplateMask(source);
  const allowNear = (index) => {
    const line = lineOf(source, index);
    for (const candidate of [line, line - 1]) {
      const text = lines[candidate - 1] ?? '';
      const lineStart = lineStarts[candidate - 1] ?? 0;
      for (const pattern of ALLOW_PATTERNS) {
        const match = pattern.exec(text);
        if (!match || !match[1] || !match[1].trim()) continue;
        // A comment that sits in template *text* is rendered as output and
        // therefore cannot serve as an opt-out.
        if (templateMask[lineStart + match.index] === 0) return true;
      }
    }
    return false;
  };

  const site = /\.(innerHTML|outerHTML)\s*(\+?=)\s*/g;
  let match;
  while ((match = site.exec(source))) {
    const rhsStart = match.index + match[0].length;
    const end = statementEnd(source, rhsStart);
    const rhs = source.slice(rhsStart, end).trim();
    const templates = templatesIn(source, rhsStart, end);

    if (templates.length === 0) {
      const literalOnly =
        /^(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")(?:\s*\+\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"))*$/s.test(
          rhs,
        );
      if (
        !literalOnly &&
        !/(escapeHtml|escapeAttr|encodeURIComponent)\(/.test(rhs) &&
        !allowNear(match.index)
      ) {
        violations.push(
          new Violation(
            lineOf(source, match.index),
            `${match[1]} assignment`,
            'non-literal HTML expression without a reviewed escaping helper',
          ),
        );
      }
      site.lastIndex = Math.max(end, site.lastIndex);
      continue;
    }

    for (const template of templates) {
      for (const interpolation of template.interpolations) {
        // An opt-out may sit on the assignment line or on the interpolation's
        // own line — but it must be *outside* the template literal, otherwise
        // the comment text itself would be rendered. Placing it after the
        // closing backtick/semicolon is the supported form.
        if (allowNear(match.index) || allowNear(interpolation.at)) continue;
        const reason = classify(interpolation.text);
        if (reason) {
          violations.push(
            new Violation(
              lineOf(source, interpolation.at),
              interpolation.text.replace(/\s+/g, ' ').trim().slice(0, 120),
              reason,
            ),
          );
        }
      }
    }
    site.lastIndex = Math.max(end, site.lastIndex);
  }
  return violations;
}

/* ------------------------------------------------------------------ *
 * Self-test: the classifier is the guard, so it must itself be guarded.
 * ------------------------------------------------------------------ */

const FIXTURES = [
  ['escapeHtml(item.label)', true],
  ['escapeAttr(value)', true],
  ["'✓'", true],
  ['42', true],
  ["entry.state === 'done' ? '✓' : '·'", true],
  ['run.events.length', true],
  ["command.view ? '打开' : '执行'", true],
  ['stateClass(item.status)', true],
  ['statusLabel(run.status)', true],
  ['formatDate(run.createdAt)', true],
  ['String(item.label)', false],
  ['item.label', false],
  ['run.summary || taskId', false],
  ["'<b>' + item.name + '</b>'", false],
  ['JSON.stringify(payload)', false],
  ['renderRow(item)', false],
  ['`${item.a}`', false],
  ['`${escapeHtml(item.a)}`', true],
  ['banner ? renderBanner(x) : escapeHtml(y)', false],
];

function selfTest() {
  const failures = [];
  for (const [expr, expectedSafe] of FIXTURES) {
    const reason = classify(expr);
    const actualSafe = reason === null;
    if (actualSafe !== expectedSafe) {
      failures.push(
        `  ${expr} → ${actualSafe ? 'safe' : `unsafe (${reason})`}, expected ${expectedSafe ? 'safe' : 'unsafe'}`,
      );
    }
  }
  if (failures.length) {
    console.error('escape-audit self-test failed:');
    console.error(failures.join('\n'));
    process.exit(1);
  }
  // The allow-comment mechanism must also be exercised end to end.
  const allowed = auditSource(
    'node.innerHTML = `<b>${raw}</b>`; // escape-audit:allow reviewed literal\n',
  );
  if (allowed.length !== 0) {
    console.error('escape-audit self-test failed: allow comment was not honoured');
    process.exit(1);
  }
  const blocked = auditSource('node.innerHTML = `<b>${raw}</b>`;\n');
  if (blocked.length !== 1) {
    console.error('escape-audit self-test failed: unescaped interpolation was not reported');
    process.exit(1);
  }
  const concatenated = auditSource("node.innerHTML = '<b>' + raw + '</b>';\n");
  if (concatenated.length !== 1) {
    console.error('escape-audit self-test failed: unescaped concatenation was not reported');
    process.exit(1);
  }
  // A comment placed in template *text* is rendered into the page, so it must
  // not be accepted as an opt-out.
  const insideTemplate = auditSource(
    'node.innerHTML = `\n  // escape-audit:allow not a real comment\n  ${raw}\n`;\n',
  );
  if (insideTemplate.length !== 1) {
    console.error('escape-audit self-test failed: a comment in template text was honoured');
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ */

selfTest();

const allViolations = [];
for (const target of TARGETS) {
  const absolute = path.join(HERE, target);
  let source;
  try {
    source = readFileSync(absolute, 'utf8');
  } catch {
    continue; // optional asset
  }
  for (const violation of auditSource(source)) {
    allViolations.push({ file: target, ...violation });
  }
}

if (allViolations.length) {
  console.error(`escape-audit: ${allViolations.length} unescaped interpolation(s) found`);
  for (const violation of allViolations) {
    console.error(`  ${violation.file}:${violation.line}  ${violation.expression}`);
    console.error(`      ${violation.reason}`);
  }
  console.error('Wrap the value in escapeHtml()/escapeAttr(), or add a reasoned opt-out:');
  console.error('  // escape-audit:allow <reason>');
  process.exit(1);
}

console.log(`escape-audit: ok (${TARGETS.join(', ')})`);
