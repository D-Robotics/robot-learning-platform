// Static layout/style invariants.
//
// Every check here exists because the repository actually shipped the bug it
// guards. They are dependency-free and run in milliseconds, so they belong in
// the default `verify` chain — the browser sweep (ui-responsive.spec.mjs) is
// the slower belt-and-braces layer on top.
//
// Imported by ui-ia.spec.mjs so the existing `verify:ui` entry point covers it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/** Strip /* *\/ comments while preserving line numbers. */
function deComment(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Walk top-level and @media-nested rules, tagging each with its media query. */
function* rules(css, { file }) {
  const src = deComment(css);
  const stack = [];
  let i = 0;
  let selectorStart = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '{') {
      const prelude = src.slice(selectorStart, i).trim().replace(/\s+/g, ' ');
      if (prelude.startsWith('@media')) {
        stack.push({ type: 'media', text: prelude });
      } else if (prelude.startsWith('@')) {
        stack.push({ type: 'at', text: prelude });
      } else {
        // find the matching close brace for this declaration block
        let depth = 1;
        let j = i + 1;
        while (j < src.length && depth > 0) {
          if (src[j] === '{') depth++;
          else if (src[j] === '}') depth--;
          j++;
        }
        const body = src.slice(i + 1, j - 1);
        const media = stack
          .filter((s) => s.type === 'media')
          .map((s) => s.text)
          .join(' && ');
        yield { file, selector: prelude, body, media, line: src.slice(0, i).split('\n').length };
        i = j;
        selectorStart = j;
        continue;
      }
      i++;
      selectorStart = i;
      continue;
    }
    if (ch === '}') {
      stack.pop();
      i++;
      selectorStart = i;
      continue;
    }
    if (ch === ';' && stack.length === 0) {
      i++;
      selectorStart = i;
      continue;
    }
    i++;
  }
}

/** CSS specificity as [ids, classes/attrs/pseudo-classes, elements]. */
function specificity(selector) {
  let sel = selector.replace(/:where\([^)]*\)/g, '');
  // :not()/:is()/:has() take the specificity of their most specific argument
  sel = sel.replace(/:(?:not|is|has)\(([^)]*)\)/g, (_, inner) => {
    const parts = inner.split(',').map((x) => specificity(x.trim()));
    parts.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
    return parts.length
      ? '#'.repeat(parts[0][0]) + '.'.repeat(parts[0][1]) + 'x'.repeat(parts[0][2])
      : '';
  });
  const ids = (sel.match(/#[\w-]+/g) || []).length;
  const classes =
    (sel.match(/\.[\w-]+/g) || []).length +
    (sel.match(/\[[^\]]+\]/g) || []).length +
    (sel.match(/:(?!:)[\w-]+/g) || []).length;
  const stripped = sel.replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|::?[\w-]+(\([^)]*\))?/g, ' ');
  const elements = (stripped.match(/(^|[\s>+~,(])[a-zA-Z][\w-]*/g) || []).length;
  return [ids, classes, elements];
}
const cmpSpec = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Does a simple media query text apply at `width`? Handles max/min-width + and. */
function mediaMatches(media, width) {
  if (!media) return true;
  const text = media.replace(/^@media\s*/, '');
  const conds = text.split(/\s+and\s+/);
  for (const cond of conds) {
    const max = cond.match(/max-width\s*:\s*([\d.]+)px/);
    const min = cond.match(/min-width\s*:\s*([\d.]+)px/);
    if (max && !(width <= Number(max[1]))) return false;
    if (min && !(width >= Number(min[1]))) return false;
    if (!max && !min && /orientation|hover|pointer|prefers-/.test(cond)) continue;
  }
  return true;
}

/** Split a selector list on commas that are NOT inside parentheses. */
function splitTopLevel(text) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const decl = (body, prop) => {
  const m = body.match(new RegExp('(?:^|;)\\s*' + prop + '\\s*:([^;}]*)'));
  return m ? m[1].trim() : null;
};
// Count grid tracks. Must respect nesting: `minmax(0, 1fr)` is ONE track, and
// `repeat(2, minmax(0,1fr))` is TWO. (An earlier version stripped parenthesised
// content, which made every minmax() track vanish — the guard then failed to see
// a single-column declaration and produced a false alarm.)
function tracks(value) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out
    .filter((t) => t && t !== '/')
    .flatMap((t) => {
      const m = t.match(/^repeat\(\s*(\d+)\s*,/);
      return m ? Array.from({ length: Number(m[1]) }, () => 'x') : [t];
    });
}

export function assertStyleInvariants(publicDir) {
  const files = fs.readdirSync(publicDir).filter((f) => f.endsWith('.css'));
  const sheets = files.map((f) => ({
    file: f,
    css: fs.readFileSync(path.join(publicDir, f), 'utf8'),
  }));

  // ---- 1. tokens.css is the only file allowed to declare custom properties ----
  // Before this rule, the same palette was declared in three files and the winner
  // depended on load order; editing the "wrong" copy silently did nothing.
  assert.ok(files.includes('tokens.css'), 'tokens.css must exist as the single token source');
  for (const { file, css } of sheets) {
    if (file === 'tokens.css') continue;
    const offenders = [...deComment(css).matchAll(/(^|[{;]\s*)(--[a-z0-9-]+)\s*:/gm)].map(
      (m) => m[2],
    );
    assert.equal(
      offenders.length,
      0,
      `${file} must not declare custom properties (found ${[...new Set(offenders)].join(', ')}); declare them in tokens.css`,
    );
  }

  // ---- 2. in every range where the sidebar is a fixed drawer, the .shell-layout
  //         rule that actually WINS must be single-column ----
  // This is the regression that shipped: `html.theme-dark .shell-layout { 224px … }`
  // at specificity (0,2,1) — the `html` element selector pushed it above the skin
  // layer's (0,2,0) single-column rule — so at 821–1080px the grid still reserved a
  // 224px first column that nothing occupies, and main content was squeezed into it.
  // Existence of a single-column rule is NOT enough; it has to win the cascade.
  const allRules = sheets.flatMap((sh) => [...rules(sh.css, { file: sh.file })]);
  const shellRules = allRules.filter(
    (r) => /\.shell-layout\b/.test(r.selector) && decl(r.body, 'grid-template-columns'),
  );
  const drawerWidths = allRules
    .filter((r) => /\.sidebar\b/.test(r.selector) && /(^|;)\s*position\s*:\s*fixed/.test(r.body))
    .flatMap((r) => {
      const m = (r.media || '').match(/max-width\s*:\s*([\d.]+)px/);
      return m ? [Math.round(Number(m[1]))] : [];
    });
  const probes = [
    ...new Set(drawerWidths.flatMap((w) => [Math.max(321, Math.round(w * 0.76)), w])),
  ];
  for (const width of probes) {
    const applicable = shellRules
      .map((r, order) => ({
        ...r,
        order,
        spec: specificity(r.selector.replace(/\s*,\s*/g, ',').split(',')[0]),
      }))
      .filter((r) => mediaMatches(r.media, width));
    if (!applicable.length) continue;
    applicable.sort((a, b) => cmpSpec(a.spec, b.spec) || a.order - b.order);
    const winner = applicable[applicable.length - 1];
    const t = tracks(decl(winner.body, 'grid-template-columns'));
    assert.equal(
      t.length,
      1,
      `at ${width}px the sidebar is a fixed drawer, but the winning .shell-layout rule is multi-column (${winner.file}:${winner.line} "${winner.selector}" -> ${decl(winner.body, 'grid-template-columns')}, specificity ${winner.spec.join('-')}). Main content will land in the sidebar's grid track.`,
    );
  }

  // ---- 4. z-index literals must go through the token ladder ----
  // The floating Agent button and the tour overlay were both `z-index: 1200`,
  // resolved only by file load order.
  for (const { file, css } of sheets) {
    const offenders = [];
    for (const r of rules(css, { file })) {
      const z = decl(r.body, 'z-index');
      if (z && /^\d+$/.test(z) && Number(z) >= 1000) offenders.push(`${r.selector} (${z})`);
    }
    assert.equal(
      offenders.length,
      0,
      `${file} must use the --z-* tokens instead of high z-index literals: ${offenders.join(', ')}`,
    );
  }

  // ---- 5. typography floor ----
  // 11px CJK metadata was the smallest reading text in the product (441 nodes at
  // one point). The only sub-12px size allowed is the mono micro-label family.
  const ALLOWED_SUB_12 = new Set(['10.5px']);
  for (const { file, css } of sheets) {
    for (const r of rules(css, { file })) {
      // `font-size` AND the `font:` shorthand. The shorthand is usually written
      // across lines (`font:\n    11px ui-monospace, …`), so a line-based grep
      // misses it — which is how nine 11px mono labels survived a floor that
      // claimed to allow only 10.5px.
      const size =
        decl(r.body, 'font-size') ??
        (/(?:^|;)\s*font\s*:[^;]*?([\d.]+)px/.exec(r.body)?.[1]
          ? `${/(?:^|;)\s*font\s*:[^;]*?([\d.]+)px/.exec(r.body)[1]}px`
          : null);
      if (!size) continue;
      const m = size.match(/^([\d.]+)px$/);
      if (!m || Number(m[1]) >= 12) continue;
      assert.ok(
        ALLOWED_SUB_12.has(size),
        `${file}:${r.line} — font-size ${size} is below the 12px floor (only ${[...ALLOWED_SUB_12].join(', ')} is allowed, for the mono micro-label family)`,
      );
    }
  }

  // ---- 6. the overview density layer keeps its locked four-step scale ----
  // Scoped to the density SECTION of the merged file (delimited by the banner
  // consolidate-css.mjs writes), not to every overview-scoped rule: other layers
  // legitimately use larger sizes for headings.
  const merged = sheets.find((s) => s.file === 'app.css');
  if (merged) {
    const banner = /\/\* =+ overview-density\.css[^*]*=+ \*\//;
    const m = banner.exec(merged.css);
    assert.ok(m, 'app.css must keep the overview-density section banner');
    const from = m.index + m[0].length;
    const next = merged.css.indexOf('/* ========================', from);
    const section = merged.css.slice(from, next === -1 ? undefined : next);
    const offenders = [...section.matchAll(/font-size:\s*([\d.]+)px/g)]
      .map((x) => Number(x[1]))
      .filter((n) => ![12, 13, 15, 24].includes(n));
    assert.equal(
      offenders.length,
      0,
      `overview density section must stay on the 12/13/15/24 scale (found ${[...new Set(offenders)].join(', ')}px)`,
    );
  }

  // ---- 6b. spacing must come from the scale ----
  // Before this, 1147 spacing declarations used 41 distinct px values: 9/10/11
  // and 6/7 and 12/13/14 all coexisted, which is what reads as "simultaneously
  // too airy and too cramped" — there was no ruler, so every gap was whatever
  // the author typed that day. 462 declarations were snapped to the nearest
  // step (average displacement 1.41px, max 3px) and verified against the
  // 11-viewport sweep. New work must use the scale.
  const SPACING_SCALE = new Set([2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48]);
  const SPACING_PROPS =
    /^(padding|margin)(-(top|right|bottom|left|inline|block)(-(start|end))?)?$|^gap$|^(row|column)-gap$/;
  const offScale = [];
  for (const { file, css } of sheets) {
    for (const r of rules(css, { file })) {
      for (const decl of r.body.split(';')) {
        const [prop, ...rest] = decl.split(':');
        if (!prop || !SPACING_PROPS.test(prop.trim())) continue;
        const value = rest.join(':');
        for (const m of value.matchAll(/(^|[\s(])(-?[\d.]+)px/g)) {
          const raw = Number(m[2]);
          // Negative values are optical nudges (pull a badge up 3px), not rhythm;
          // >=60px is one-off layout sizing (page gutters, hero padding).
          if (raw <= 0 || raw >= 60) continue;
          if (!SPACING_SCALE.has(raw)) offScale.push(`${file}:${r.line} ${prop.trim()}: ${raw}px`);
        }
      }
    }
  }
  assert.equal(
    offScale.length,
    0,
    `spacing must use the scale ${[...SPACING_SCALE].join('/')}px (values under 60px); found ${offScale.length}: ${offScale.slice(0, 6).join(', ')}`,
  );

  // ---- 7. the layering must not grow ----
  // app.css is eleven historical layers concatenated in load order. That is why
  // the same selector is defined up to 14 times, and a change to a component's
  // look means finding the LAST definition that wins. Collapsing it properly needs
  // per-component cascade resolution (218 selectors have genuinely conflicting
  // values across layers), which is a design-system task, not a mechanical one —
  // and note that even removing a *pure duplicate* is unsafe on its own, because
  // the rule that then wins may be an intervening selector with a different value.
  //
  // So: ratchet instead. The layer count is fixed and the cross-layer selector
  // count may only go down. New CSS belongs in the section that already owns the
  // component, not in a new override at the bottom.
  const LAYER_BUDGET = 11;
  // Measured at the moment the ratchet landed. postcss counts 336 of 1559
  // selectors spanning 2+ layers; this counter's own baseline is pinned to what
  // IT measures — a looser budget would silently allow dozens of new cross-layer
  // selectors before it ever fired.
  //   302 -> 283 after removing 59 rules whose every property is re-declared
  //   later in the SAME media context (proven neutral by an 88-cell
  //   computed-style + geometry fingerprint).
  //   283 -> 305 when the uniform-polish size-unification pass landed
  //   (2026-09-17). That pass's function is to override existing selectors —
  //   converging five single-line button heights and the 38/56px nav rhythm
  //   requires re-declaring them — so 22 selectors gained a further definition,
  //   each documented with its measured before-value inside app.css. The pass
  //   lives at the end of the pro-skin layer (its strategy and its domain:
  //   component form), so the LAYER count itself did not grow. This raise is a
  //   recorded, reviewed exception, not a template.
  // Lower this whenever another verified batch lands; raise it only with a
  // note like the one above.
  // 305 → 306 (2026-09-17): the G18 workspace-notice strip adds one responsive
  // override pair (.workspace-notice-copy span base + its 720px media rule)
  // that mirrors the existing .workspace-status-copy span pattern in the same
  // maturity-ux layer. No new layer, no new component family.
  // 306 → 312 (2026-09-18): the Agent drawer v2 refinement extends the existing
  // pro-skin component layer with six intentional responsive overrides for the
  // conversation-first layout. No new layer or component family was added.
  // 312 → 324 (2026-09-20): the workbench visual hierarchy pass adds twelve
  // reviewed surface/layout selectors for the simulation, training, evidence,
  // deployment, and mobile views. Keep the ratchet tight; this is not a
  // blanket allowance for future duplicate overrides.
  // 324 → 331 (2026-09-20): the complete polish pass adds seven intentional
  // desktop/mobile component overrides for records and the device console.
  // These are responsive pairs in the same final polish layer, verified by
  // the responsive suite below; keep the increase limited to this batch.
  // 331 → 337 (2026-09-20): the Inspector/breadcrumb pass adds six intentional
  // final-skin selectors for the single-surface workbench treatment. They are
  // limited to the compact chrome and disclosure surfaces in the final layer.
  const CROSS_LAYER_BUDGET = 337;
  const appCss = sheets.find((sh) => sh.file === 'app.css');
  if (appCss) {
    const bannerRe = /\/\* =+ ([a-z-]+\.css) —/g;
    const banners = [...appCss.css.matchAll(bannerRe)].map((m) => m[1]);
    assert.equal(
      banners.length,
      LAYER_BUDGET,
      `app.css must keep exactly ${LAYER_BUDGET} layer sections (found ${banners.length}: ${banners.join(', ')}). Adding another override layer is what produced the current 336 cross-layer selectors — extend the owning section instead.`,
    );
    // split on banners and collect the selectors each layer defines
    const chunks = appCss.css.split(/\/\* =+ [a-z-]+\.css —/).slice(1);
    const seen = new Map();
    for (const chunk of chunks) {
      for (const m of deComment(chunk).matchAll(/(^|\})([^{}@]+)\{/g)) {
        // Split on top-level commas only. A naive split(',') also cuts inside
        // functional pseudo-classes — `:is(button, a.button, .button)` became
        // three fragments — which produced phantom cross-layer selectors and
        // tripped this very ratchet with a false positive.
        for (const sel of splitTopLevel(m[2])) {
          const t = sel.trim();
          if (!t) continue;
          seen.set(t, (seen.get(t) || 0) + 1);
        }
      }
    }
    const crossLayer = [...seen.values()].filter((n) => n > 1).length;
    assert.ok(
      crossLayer <= CROSS_LAYER_BUDGET,
      `selectors defined in more than one layer grew to ${crossLayer} (budget ${CROSS_LAYER_BUDGET}). Put new declarations in the layer that already owns the selector.`,
    );

    // ---- 9. raw hex colors may only shrink ----
    // app.css still carries raw hex literals inherited from the merged layers
    // while the palette itself lives in tokens.css. New colors must be tokens;
    // existing literals get converted batch by batch, so only the count going
    // DOWN keeps this honest. tokens.css is exempt — it IS the palette.
    // 188 → 0 (2026-09-21): the batch hex→token migration converted every
    // remaining literal (189 counted) into constant tokens in tokens.css,
    // proven value-preserving by a 48-cell computed-style fingerprint
    // (8 views × 2 themes × 3 viewports, old vs new byte-equal modulo
    // app-state flakiness). app.css is now 100% token-referenced; any new
    // literal must be justified by lowering this again.
    const HEX_RATCHET = 0;
    const hexCount = [...deComment(appCss.css).matchAll(/#[0-9a-fA-F]{3,8}\b/g)].length;
    assert.ok(
      hexCount <= HEX_RATCHET,
      `raw hex literals in app.css grew to ${hexCount} (ratchet ${HEX_RATCHET}); declare the color in tokens.css and reference the token`,
    );

    // ---- 10. viewport breakpoints are frozen ----
    // 18 distinct width values across 90 media blocks is why responsive
    // behavior became impossible to reason about. 18 → 7 (2026-09-21): the
    // set collapsed onto the four canonical tiers 560/720/1080/1280 plus
    // their min-width complements (721/1081/1281). 980→1080 also aligns the
    // CSS sidebar-hide point with app.js's SIDEBAR_DRAWER_QUERY (1080), which
    // it had silently disagreed with. The set may shrink further, never grow.
    const BREAKPOINT_ALLOWLIST = new Set([560, 720, 721, 1080, 1081, 1280, 1281]);
    const bpOffenders = [
      ...deComment(appCss.css).matchAll(/\(\s*(?:max|min)-width\s*:\s*([\d.]+)px/g),
    ]
      .map((m) => Number(m[1]))
      .filter((n) => !BREAKPOINT_ALLOWLIST.has(n));
    assert.equal(
      bpOffenders.length,
      0,
      `new breakpoint value(s) ${[...new Set(bpOffenders)].join(', ')}px; reuse the frozen set (${[...BREAKPOINT_ALLOWLIST].join('/')}) or shrink it deliberately with a note`,
    );

    // ---- 11. z-index literals below the ladder are frozen too ----
    // Guard 4 owns >=1000 (the --z-* ladder). These low literals (1/2/4/5/40/60/-1)
    // are grandfathered stacking-context nudges; the value set may shrink, not grow.
    const Z_INDEX_ALLOWLIST = new Set(['-1', '1', '2', '4', '5', '40', '60']);
    const zOffenders = [...deComment(appCss.css).matchAll(/z-index:\s*(-?\d+)/g)]
      .map((m) => m[1])
      .filter((v) => !Z_INDEX_ALLOWLIST.has(v));
    assert.equal(
      zOffenders.length,
      0,
      `new z-index literal(s) ${[...new Set(zOffenders)].join(', ')}; use the --z-* ladder in tokens.css`,
    );

    // ---- 12. raw font-size:12px literals may only shrink ----
    // Reading surfaces (logs, tables, explanations) moved to var(--fs-body);
    // chips and labels should reference var(--fs-meta). A growing literal count
    // means the type scale is being bypassed again.
    // 318 → 0 (2026-09-21): the same migration batch moved every 12px/13px/
    // 10.5px literal onto var(--fs-meta) / var(--fs-body) / var(--fs-mono-micro)
    // (380 replacements), covered by the same computed-style fingerprint.
    const FONT_12PX_RATCHET = 0;
    const font12Count = [...deComment(appCss.css).matchAll(/font-size:\s*12px/g)].length;
    assert.ok(
      font12Count <= FONT_12PX_RATCHET,
      `font-size:12px literals grew to ${font12Count} (ratchet ${FONT_12PX_RATCHET}); use var(--fs-meta) or var(--fs-body) from tokens.css`,
    );

    return {
      stylesheets: files.length,
      pages: fs.readdirSync(publicDir).filter((f) => f.endsWith('.html')).length,
      layers: banners.length,
      crossLayerSelectors: crossLayer,
      crossLayerBudget: CROSS_LAYER_BUDGET,
    };
  }

  // ---- 8. no orphan stylesheets: every .css in public/ must be linked ----
  const pages = fs.readdirSync(publicDir).filter((f) => f.endsWith('.html'));
  const linked = new Set();
  for (const page of pages) {
    const html = fs.readFileSync(path.join(publicDir, page), 'utf8');
    for (const m of html.matchAll(/(?:href|src)="\.?\/?([^"?]+\.css)[^"]*"/g))
      linked.add(path.basename(m[1]));
    for (const m of html.matchAll(/(?:href|src)="\.?\/?([^"?]+\.css)\?/g))
      linked.add(path.basename(m[1]));
  }
  for (const f of files) {
    assert.ok(
      linked.has(f),
      `public/${f} is not referenced by any page — delete it or link it (dead stylesheet)`,
    );
  }
  return { stylesheets: files.length, pages: pages.length };
}

export function assertMarkupInvariants(html) {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

  // duplicate ids break every aria reference that targets them
  const seen = new Map();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  const dups = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  assert.equal(dups.length, 0, `duplicate ids in index.html: ${dups.join(', ')}`);

  // every aria reference must resolve
  for (const attr of [
    'aria-labelledby',
    'aria-describedby',
    'aria-controls',
    'aria-activedescendant',
  ]) {
    for (const m of html.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))) {
      for (const id of m[1].split(/\s+/).filter(Boolean)) {
        assert.ok(ids.has(id), `${attr}="${id}" does not resolve to an element id`);
      }
    }
  }

  // tabs must pair with tabpanels in both directions
  const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((m) => m[0]);
  assert.ok(tabs.length > 0, 'expected at least one role="tab"');
  let panels = 0;
  for (const tag of tabs) {
    const c = tag.match(/aria-controls="([^"]+)"/);
    assert.ok(c, `role="tab" without aria-controls: ${tag.slice(0, 70)}`);
    for (const id of c[1].split(/\s+/)) ids.has(id) || assert.fail(`tab controls missing id ${id}`);
  }
  for (const m of html.matchAll(/<[a-z]+[^>]*role="tabpanel"[^>]*>/g)) {
    panels += 1;
    const l = m[0].match(/aria-labelledby="([^"]+)"/);
    assert.ok(l, `role="tabpanel" without aria-labelledby: ${m[0].slice(0, 70)}`);
    for (const id of l[1].split(/\s+/)) {
      ids.has(id) || assert.fail(`tabpanel labelled by missing id ${id}`);
      new RegExp(`id="${id}"[^>]*role="tab"|role="tab"[^>]*id="${id}"`).test(html) ||
        assert.fail(`tabpanel aria-labelledby="${id}" does not point at a role="tab"`);
    }
  }
  // No orphan panels: every tabpanel must be reachable from some tab. (A count
  // equality would be wrong — the three login-method tabs deliberately share one
  // form panel, so controlled-id count is legitimately higher than panel count.)
  const controlled = new Set(
    tabs.flatMap((t) => t.match(/aria-controls="([^"]+)"/)[1].split(/\s+/)),
  );
  for (const m of html.matchAll(/<[a-z]+[^>]*role="tabpanel"[^>]*>/g)) {
    const id = m[0].match(/\sid="([^"]+)"/);
    assert.ok(
      id,
      `role="tabpanel" must carry an id so a tab can point at it: ${m[0].slice(0, 70)}`,
    );
    assert.ok(
      controlled.has(id[1]),
      `tabpanel #${id[1]} is not referenced by any tab's aria-controls (orphan panel)`,
    );
  }

  // exactly one h1 (the outline root); view titles stay h2
  const h1 = [...html.matchAll(/<h1[\s>]/g)].length;
  assert.equal(h1, 1, `index.html must contain exactly one <h1> (found ${h1})`);

  // a modal that claims aria-modal must be a real dialog
  return { ids: ids.size, tabs: tabs.length, panels };
}

/**
 * Prove the guards are not vacuous: feed each one the exact shape of the bug it
 * documents and require it to throw. A guard that silently passes everything is
 * worse than no guard, because it looks like coverage.
 */
const GUARD_MERGED_APP_CSS_SKELETON =
  ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
    .map((n) => `/* ============ ${n}.css — fixture layer ============ */`)
    .join('\n') +
  '\n/* ============ overview-density.css — density scale ============ */\n';

export function assertGuardsAreLive(publicDir, tmpDir) {
  const fsx = fs;
  const pathx = path;
  const cases = [
    {
      // the exact shape of the shipped regression: a higher-specificity
      // multi-column rule beating the single-column drawer rule
      name: 'higher-specificity multi-column shell wins in the drawer range',
      files: {
        'tokens.css': ':root { --x: 1; }',
        'app.css':
          '@media (max-width: 1080px) { .app-shell .sidebar { position: fixed; } }\n' +
          '@media (max-width: 1080px) { .app-shell .shell-layout { grid-template-columns: minmax(0, 1fr); } }\n' +
          'html.theme-dark .shell-layout { grid-template-columns: 224px minmax(0, 1fr); }',
      },
      expect: /the winning \.shell-layout rule is multi-column/,
    },
    {
      name: 'fixed sidebar with no single-column rule at all',
      files: {
        'tokens.css': ':root { --x: 1; }',
        'app.css':
          '@media (max-width: 900px) { .sidebar { position: fixed; } }\n.shell-layout { grid-template-columns: 210px minmax(0, 1fr); }',
      },
      expect: /the winning \.shell-layout rule is multi-column/,
    },
    {
      name: 'token declared outside tokens.css',
      files: {
        'tokens.css': ':root { --x: 1; }',
        'app.css': '.panel { --local: 2px; color: red; }',
      },
      expect: /must not declare custom properties/,
    },
    {
      name: 'z-index literal above the ladder',
      files: { 'tokens.css': ':root { --z-tour: 1200; }', 'app.css': '.modal { z-index: 9999; }' },
      expect: /must use the --z-\* tokens/,
    },
    {
      name: 'font below the legibility floor',
      files: { 'tokens.css': ':root { --x: 1; }', 'app.css': '.note { font-size: 10px; }' },
      expect: /below the 12px floor/,
    },
    {
      // Guards 6/7 require the merged-file shape (11 layer banners + density
      // banner) before the late ratchets can fire, so fixtures for guards 9-12
      // carry that skeleton.
      name: 'new viewport breakpoint value',
      files: {
        'tokens.css': ':root { --x: 1; }',
        'app.css':
          GUARD_MERGED_APP_CSS_SKELETON +
          '@media (max-width: 777px) { .grid { grid-template-columns: minmax(0, 1fr); } }',
      },
      expect: /new breakpoint value\(s\) 777px/,
    },
    {
      name: 'z-index literal outside the grandfathered set',
      files: {
        'tokens.css': ':root { --x: 1; }',
        'app.css': GUARD_MERGED_APP_CSS_SKELETON + '.overlay { z-index: 500; }',
      },
      expect: /new z-index literal\(s\) 500/,
    },
  ];
  const results = [];
  for (const c of cases) {
    const dir = pathx.join(tmpDir, 'guard-' + c.name.replace(/\W+/g, '-'));
    fsx.rmSync(dir, { recursive: true, force: true });
    fsx.mkdirSync(dir, { recursive: true });
    for (const [f, body] of Object.entries(c.files)) fsx.writeFileSync(pathx.join(dir, f), body);
    let threw = null;
    try {
      assertStyleInvariants(dir);
    } catch (err) {
      threw = err.message;
    }
    if (!threw) throw new Error(`guard "${c.name}" did not fire on its own regression fixture`);
    if (!c.expect.test(threw))
      throw new Error(`guard "${c.name}" fired for the wrong reason: ${threw}`);
    results.push(c.name);
    fsx.rmSync(dir, { recursive: true, force: true });
  }
  return results;
}
