import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';

it('ignores keyless modifier events without interrupting the simulation input handlers', async () => {
  const base = new URL('./public/', import.meta.url);
  const [html, teleop, simulator] = await Promise.all(
    ['index.html', 'originman-teleop-link.js', 'originman-simulator.js'].map((name) =>
      readFile(new URL(name, base), 'utf8'),
    ),
  );
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/' });
  const errors: unknown[] = [];
  const request = vi.fn();
  try {
    dom.window.addEventListener('error', (event) => {
      errors.push(event.error);
      event.preventDefault();
    });
    dom.window.eval(teleop);
    dom.window.eval(simulator);
    dom.window.eval('OriginmanSimulator').mount({ request, getSource: () => null });
    const canvas = dom.window.document.getElementById('originman-sim-canvas')!;
    canvas.dispatchEvent(new dom.window.Event('keydown'));
    dom.window.dispatchEvent(new dom.window.Event('keyup'));
    canvas.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Shift' }));
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key: 'Shift' }));
    expect(errors).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  } finally {
    dom.window.close();
  }
});
