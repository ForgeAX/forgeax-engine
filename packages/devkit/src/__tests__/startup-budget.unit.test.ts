import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';

it.each([
  [true, undefined],
  [false, undefined],
  [true, 12345],
  [false, null],
])('passes the generated App startup budget to its Engine root (development=%s, project=%s)', async (development, startupTimeoutMs) => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-startup-budget-'));
  try {
    await mkdir(resolve(root, 'assets'));
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({ id: 'budget-game', name: 'Budget Game', schemaVersion: '3.0.0', roots: {} }),
    );
    await writeFile(
      resolve(root, 'package.json'),
      JSON.stringify({
        name: 'budget-game',
        ...(startupTimeoutMs === undefined ? {} : { forgeax: { startupTimeoutMs } }),
      }),
    );
    await writeFile(resolve(root, 'main.ts'), 'export default () => undefined;');
    const facts = await readProjectFacts(root);
    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    await createViteConfig(facts.value, 'build');
    const generated = await readFile(resolve(root, '.forgeax/generated/main.ts'), 'utf8');
    const execution = generated.match(/startupTimeoutMs:\s*([^\n]+),\s*bootstrap: new URL/)?.[1];
    const activation = generated.match(
      /const mounted = await activateExecutionRoot\(ctx, \{\s*guid: engineRoot,\s*\}, (.+)\);/,
    )?.[1];
    expect(execution).toBeDefined();
    expect(activation).toBeDefined();
    if (execution === undefined || activation === undefined) return;
    const evaluate = (source: string) =>
      runInNewContext(`(${source.replaceAll('import.meta.env.DEV', String(development))})`);
    expect(evaluate(activation).timeoutMs).toBe(evaluate(execution));
    if (startupTimeoutMs !== undefined) expect(evaluate(execution)).toBe(startupTimeoutMs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
