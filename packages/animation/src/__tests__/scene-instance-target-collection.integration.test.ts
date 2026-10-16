// @ts-expect-error Node built-in types are provided by the Vitest runner.
import { readFileSync } from 'node:fs';
import { ENTITY_NULL_RAW } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';

const APP_SOURCES = [
  '../../../../apps/hello/skin/src/main.ts',
  '../../../../apps/hello/fbx-skin/src/main.ts',
  '../../../../apps/hello/animation-graph/src/main.ts',
  '../../../../apps/collectathon/src/spawn/spawn-player.ts',
] as const;

describe('SceneInstance animation target collection', () => {
  it('keeps entity zero and skips only ENTITY_NULL_RAW', () => {
    const mapping = new Uint32Array([0, 7, ENTITY_NULL_RAW]);
    expect(Array.from(mapping).filter((raw) => raw !== ENTITY_NULL_RAW)).toEqual([0, 7]);
  });

  it.each(APP_SOURCES)('%s explicitly binds targets without treating zero as null', (path) => {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    expect(source).toContain('bindAnimationTargets');
    expect(source).toContain('AnimationTargetId');
    expect(source).toContain('ENTITY_NULL_RAW');
    expect(source).not.toMatch(/(?:entRaw|raw)\s*===\s*0/);
  });
});
