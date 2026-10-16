// @ts-expect-error The package test tsconfig intentionally omits Node globals.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('SceneInstance structure characterization', () => {
  it('records the current instance state surface', async () => {
    const source = readFileSync(
      new URL('../instances/scene-instances.ts', import.meta.url),
      'utf8',
    );
    const snapshot = {
      lines: source.split('\n').length - 1,
      exportedFunctions: (source.match(/^export function\b/gm) ?? []).length,
      hasStatePayload: source.includes('export interface SceneInstanceState'),
      hasWorldStateWeakMap: source.includes('const sceneWorldStates = new WeakMap'),
    };

    // The keyed authoring compiler lives in keyed.ts; this is the post-migration
    // runtime projection baseline, with a small guard against re-growing the
    // former numeric/mount implementation.
    expect(snapshot.lines).toBeLessThan(1700);
    expect(snapshot.exportedFunctions).toBe(24);
    expect(snapshot.hasStatePayload).toBe(false);
    expect(snapshot.hasWorldStateWeakMap).toBe(false);
  });
});
