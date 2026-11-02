import * as naga from '@forgeax/engine-naga';
import { Materials } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-types';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createMaterialPackCooker } from '../../../shader-compiler/src/index';

// Observe the real inline compiler in a fresh consumer realm, retaining every
// portable backend/context. Each schema transition has its own thirty-second budget.
vi.hoisted(() => vi.stubEnv('FORGEAX_SHADER_COMPILE_WORKERS', '1'));

import { createHash } from 'node:crypto';

describe.sequential('Standard program reuse across material schemas', () => {
  const composition = vi.spyOn(naga, 'composeShader');
  const cooker = createMaterialPackCooker();
  const standard = Materials.standard({ baseColor: [1, 1, 1, 1], metallic: 0, roughness: 0.5 });

  afterAll(() => {
    composition.mockRestore();
    vi.unstubAllEnvs();
  });

  const hashes = (draft: Awaited<ReturnType<typeof cooker.cook>>) =>
    Object.entries(draft.artifacts).map(([key, artifact]) => [
      key,
      createHash('sha256').update(artifact.bytes).digest('hex'),
    ]);

  it('reuses the complete Standard publication after a clearcoat schema', async () => {
    const first = await cooker.cook({ guid: 'mixed-standard-first', source: standard });
    await cooker.cook({
      guid: 'mixed-painted',
      source: Materials.standard({
        staticSwitches: { clearcoat: true },
        baseColor: [0.28, 0.035, 0.075, 1],
        metallic: 0.12,
        roughness: 0.18,
        clearcoat: 0.82,
        clearcoatRoughness: 0.08,
      }),
    });
    const compositions = composition.mock.calls.length;
    expect(compositions).toBeGreaterThan(0);
    const repeated = await cooker.cook({
      guid: 'mixed-standard-after-clearcoat',
      source: standard,
    });
    expect(composition).toHaveBeenCalledTimes(compositions);
    expect(hashes(repeated)).toEqual(hashes(first));
  }, 30_000);

  it('reuses the complete Standard publication after a skinned schema in the same cooker', async () => {
    const first = await cooker.cook({ guid: 'mixed-standard-before-skin', source: standard });
    const body = Materials.standard({
      baseColor: [0.72, 0.78, 0.73, 1],
      metallic: 0.22,
      roughness: 0.36,
    });
    if (body.passes === undefined) throw new Error('Standard passes required');
    const [bodyFirst, ...bodyRest] = body.passes;
    const skin = (pass: NonNullable<MaterialAsset['passes']>[number]) =>
      pass.name === 'shadow-caster'
        ? pass
        : { ...pass, program: { ...pass.program, module: 'forgeax::pbr-skin' } };
    await cooker.cook({
      guid: 'mixed-skinned',
      source: { ...body, passes: [skin(bodyFirst), ...bodyRest.map(skin)] },
    });
    const compositions = composition.mock.calls.length;
    expect(compositions).toBeGreaterThan(0);
    const repeated = await cooker.cook({ guid: 'mixed-standard-return', source: standard });
    expect(composition).toHaveBeenCalledTimes(compositions);
    expect(hashes(repeated)).toEqual(hashes(first));
  }, 30_000);
});
