// @ts-expect-error Node built-in types are provided by the Vitest runner.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('animation target source boundary', () => {
  it('registers animation target components before hello-skin writeback instantiates glTF', () => {
    const source = readFileSync(
      new URL('../../../../apps/hello/skin/scripts/smoke-writeback-dawn.mjs', import.meta.url),
      'utf8',
    );
    const registration = source.indexOf("await import('@forgeax/engine-animation')");
    const instantiate = source.indexOf('assets.instantiate(sceneHandle, world)');

    expect(registration).toBeGreaterThanOrEqual(0);
    expect(instantiate).toBeGreaterThan(registration);
  });

  it('does not discover animation targets through Skin, Name, or targetPath', () => {
    const source = readFileSync(
      new URL('../systems/advance-animation-player.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/\bSkin\b/);
    expect(source).not.toMatch(/\bName\b/);
    expect(source).not.toContain('targetPath');
    expect(source).toContain('AnimationTargets');
    expect(source).toContain('AnimationTargetId');
  });

  it('keeps Skin joints limited to palette and post-spawn joint wiring', () => {
    const evaluator = readFileSync(
      new URL('../systems/advance-animation-player.ts', import.meta.url),
      'utf8',
    );
    const palette = readFileSync(
      new URL('../../../render/src/systems/skin-palette-allocator.ts', import.meta.url),
      'utf8',
    );
    const jointWiring = readFileSync(
      new URL('../../../render/src/scene-instances/post-spawn-resolve-joints.ts', import.meta.url),
      'utf8',
    );

    expect(evaluator).not.toMatch(/\bSkin\.joints\b|world\.get\([^)]*,\s*Skin\b/);
    expect(palette).toContain('Skin.joints');
    expect(jointWiring).toContain('Skin');
    expect(jointWiring).toContain('joints');
  });
});
