import { describe, expect, it } from 'vitest';
// @ts-expect-error Vite provides raw text imports to the test runner.
import readme from '../../README.md?raw';
import type { BindAnimationTargetsErrorCode } from '../animation-target';

const BIND_ERROR_CODES = [
  'animation-target-player-invalid',
  'animation-target-invalid',
  'animation-target-outside-player-root',
  'animation-target-name-missing',
  'animation-target-id-invalid',
  'animation-target-id-duplicate',
  'animation-target-player-conflict',
  'animation-target-capacity-reserve-failed',
  'animation-target-bind-failed',
] as const satisfies readonly BindAnimationTargetsErrorCode[];

describe('animation target documentation contract', () => {
  it('puts a self-contained direct playback flow first', () => {
    const quickStart = readme.indexOf('## Quick start');
    expect(quickStart).toBeGreaterThan(0);
    expect(quickStart).toBeLessThan(readme.indexOf('## Identity and ownership'));
    const firstSection = readme.slice(quickStart, readme.indexOf('## Identity and ownership'));
    for (const literal of [
      "import { createWorldContext, World } from '@forgeax/engine-ecs'",
      "import { ChildOf, Name, Transform } from '@forgeax/engine-scene'",
      "import type { AnimationClip } from '@forgeax/engine-types'",
      'AnimationTargetId',
      'bindAnimationTargets',
      'AnimationPlayer',
      'const world = new World()',
      'const player =',
      'const target =',
      'const clip =',
      'const clipHandle =',
      'const slots =',
    ]) {
      expect(firstSection).toContain(literal);
    }
    for (const externalName of [
      'sceneInstance',
      'repair',
      'directSlots',
      'clipHandle)',
      'defineAnimationGraph',
    ]) {
      expect(firstSection).not.toContain(externalName);
    }
  });

  it('documents wire, structured recovery, demo, and explicit boundaries', () => {
    for (const literal of [
      '32 lowercase hexadecimal',
      'BLAKE3',
      'UUID v8',
      'from the player through the',
      'asset root through each target',
      'synthetic runtime controller',
      'error.code',
      'error.hint',
      'error.detail',
      'animation-target-outside-player-root',
      'animation-target-name-missing',
      'animation-target-id-duplicate',
      'animation-target-player-conflict',
      'apps/bevy/animated-transform',
      'arbitrary component properties',
      'animation FSM',
      'editor UI',
      'targetId',
      'targetPath',
    ]) {
      expect(readme).toContain(literal);
    }

    const errorRecovery = readme.slice(
      readme.indexOf('## Error recovery'),
      readme.indexOf('## Example and boundaries'),
    );
    const documentedCodes = [...errorRecovery.matchAll(/\| `(animation-target-[a-z-]+)` \|/g)].map(
      (match) => match[1],
    );
    expect(documentedCodes).toEqual(BIND_ERROR_CODES);

    // Rejected review-round-1 spellings stay here only as negative contract fixtures.
    for (const staleCode of [
      'animation-player-invalid',
      'animation-target-outside-root',
      'animation-target-owner-conflict',
    ]) {
      expect(readme).not.toContain(staleCode);
    }
  });
});
