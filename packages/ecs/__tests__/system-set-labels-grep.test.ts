import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

const schedulerSources = [
  'packages/ecs/src/schedule.ts',
  'packages/scene/src/systems/propagate-transforms.ts',
  'packages/animation/src/systems/advance-animation-player.ts',
  'packages/input/src/frame-start-scan-system.ts',
  'packages/state/src/register-plugin.ts',
  'packages/physics-rapier2d/src/rapier-physics-world-2d.ts',
  'packages/physics-rapier3d/src/rapier-physics-world-3d.ts',
];

describe('SystemDescriptor labels removal', () => {
  it('has no labels property in scheduler descriptors or builtin registrar sources', () => {
    for (const source of schedulerSources) {
      const text = readFileSync(resolve(repoRoot, source), 'utf8');
      expect(text, source).not.toMatch(/\blabels\s*:/);
    }
  });
});
