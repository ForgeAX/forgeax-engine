// @perf-budget-skip: real Vite rebundling of a minified preload binding.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { bundleSingleHtmlEntry } from '../single-html.js';

it('rewrites the imported preload binding while preserving shadowed function arguments', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-single-html-bindings-'));
  const probe = globalThis as typeof globalThis & {
    singleHtmlBindings?: unknown;
    singleHtmlDeps?: unknown;
  };
  try {
    await writeFile(resolve(root, 'package.json'), '{"type":"module"}');
    await writeFile(
      resolve(root, 'preload-helper-production.js'),
      'export function __vitePreload(loader, deps) { globalThis.singleHtmlDeps = deps; return loader(); }',
    );
    await writeFile(
      resolve(root, 'main.js'),
      `
import { __vitePreload as P } from './preload-helper-production.js';
const group = { rules: [1, 2, 3] };
function nested() { return P({}, group); function P(e, d) { return d.rules.length; } }
function parameter(P) { return P({}, group); }
let block;
{ const P = (e, d) => d.rules[1]; block = P({}, group); }
const loaded = await P(() => Promise.resolve(42), ['dependency.js']);
globalThis.singleHtmlBindings = [nested(), parameter((e, d) => d.rules[0]), block, loaded];
`,
    );
    await import(pathToFileURL(resolve(root, 'main.js')).href);
    expect(probe.singleHtmlBindings).toEqual([3, 1, 2, 42]);
    expect(probe.singleHtmlDeps).toEqual(['dependency.js']);
    delete probe.singleHtmlBindings;
    delete probe.singleHtmlDeps;
    const bundled = await bundleSingleHtmlEntry(
      root,
      '<script type="module" src="./main.js"></script>',
    );
    if (!bundled.ok) throw bundled.error;
    const output = resolve(root, 'single-html-entry.mjs');
    await writeFile(output, bundled.value.entrySource);
    await import(pathToFileURL(output).href);
    expect(probe.singleHtmlBindings).toEqual([3, 1, 2, 42]);
    expect(probe.singleHtmlDeps).toBeUndefined();
  } finally {
    delete probe.singleHtmlBindings;
    delete probe.singleHtmlDeps;
    await rm(root, { recursive: true, force: true });
  }
});
