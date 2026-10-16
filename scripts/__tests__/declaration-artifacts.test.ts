import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const engineRoot = resolve(import.meta.dirname, '..', '..');

function packageArtifacts(name: string): string[] {
  const dist = resolve(engineRoot, 'packages', name, 'dist');
  return ['index.mjs', 'index.d.ts', 'index.d.ts.map'].map((file) => resolve(dist, file));
}

describe('engine declaration graph', () => {
  it('declares the NPC project in the root composite graph', () => {
    const config = JSON.parse(readFileSync(resolve(engineRoot, 'tsconfig.json'), 'utf8')) as {
      references?: Array<{ path?: string }>;
    };
    expect(config.references?.map((reference) => reference.path)).toContain('./packages/npc');
  });

  it.each([
    'npc',
    'ecs',
    'runtime',
    'types',
  ])('emits paired runtime and declaration artifacts for %s', (name) => {
    for (const artifact of packageArtifacts(name)) {
      expect(existsSync(artifact), `missing declaration artifact: ${artifact}`).toBe(true);
    }
  });
});
