import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { sourceHits, sourceHitsFallback } from './source-scan.fixture';

it('finds authored violations while excluding nested build and dependency outputs on both scan paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-source-scan-'));
  try {
    for (const directory of [
      'packages/owner/src',
      'packages/owner/dist',
      'packages/owner/node_modules/dependency',
      'apps/demo/src',
      'templates/game/assets',
    ]) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    for (const name of [
      'packages/owner/src/authored.ts',
      'apps/demo/src/authored.mjs',
      'templates/game/assets/authored.ts',
      'packages/owner/dist/generated.ts',
      'packages/owner/node_modules/dependency/generated.mjs',
    ]) {
      writeFileSync(join(root, name), 'retiredCall();\n');
    }
    const expected = [
      'apps/demo/src/authored.mjs:1:retiredCall();',
      'packages/owner/src/authored.ts:1:retiredCall();',
      'templates/game/assets/authored.ts:1:retiredCall();',
    ];
    expect(sourceHits(root, 'retiredCall').sort()).toEqual(expected);
    expect(sourceHitsFallback(root, 'retiredCall').sort()).toEqual(expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
