import { createHash } from 'node:crypto';
import { Materials } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMaterialPackCooker } from '../../../shader-compiler/src/index';

// Keep Pack admission observable in this realm while real shader programs use
// the existing bounded compiler workers. Every portable variant is still cooked.
vi.mock('../../../shader-compiler/src/material/node-material-cooker', () => ({
  withNodeMaterialWorkers: (cooker: unknown) => cooker,
}));

type CompilerModule = typeof import('../../../shader-compiler/src/material/node-program-compiler');
const { compilers } = vi.hoisted(() => ({
  compilers: [] as Array<ReturnType<CompilerModule['createNodeMaterialProgramCompiler']>>,
}));
vi.mock('../../../shader-compiler/src/material/node-program-compiler', async (importOriginal) => {
  const actual = await importOriginal<CompilerModule>();
  return {
    ...actual,
    createNodeMaterialProgramCompiler: () => {
      const compiler = actual.createNodeMaterialProgramCompiler();
      const observed = { ...compiler, compile: vi.fn(compiler.compile) };
      compilers.push(observed);
      return observed;
    },
  };
});

describe.sequential('Standard program reuse across material schemas', () => {
  const compiler = compilers[0];
  if (compiler === undefined) throw new Error('Pack program compiler was not initialized');
  const compilation = vi.mocked(compiler.compile);
  const cooker = createMaterialPackCooker();
  const standard = Materials.standard({ baseColor: [1, 1, 1, 1], metallic: 0, roughness: 0.5 });

  afterAll(async () => {
    await Promise.all(compilers.map((compiler) => compiler.close()));
  });

  const hashes = (draft: Awaited<ReturnType<typeof cooker.cook>>) =>
    Object.entries(draft.artifacts).map(([key, artifact]) => [
      key,
      createHash('sha256').update(artifact.bytes).digest('hex'),
    ]);

  let baseline: ReturnType<typeof hashes>;
  beforeAll(async () => {
    const first = await cooker.cook({ guid: 'mixed-standard-first', source: standard });
    baseline = hashes(first);
    expect(compilation).toHaveBeenCalled();
  }, 30_000);

  it('reuses the complete Standard publication after a clearcoat schema', async () => {
    const before = compilation.mock.calls.length;
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
    const compilations = compilation.mock.calls.length;
    expect(compilations).toBeGreaterThan(before);
    const repeated = await cooker.cook({
      guid: 'mixed-standard-after-clearcoat',
      source: standard,
    });
    expect(compilation).toHaveBeenCalledTimes(compilations);
    expect(hashes(repeated)).toEqual(baseline);
  }, 30_000);

  it('reuses the complete Standard publication after a skinned schema in the same cooker', async () => {
    // The cold beforeAll publication is the baseline even when this case runs
    // alone. A second warm Standard cook adds no new coverage to the transition.
    const before = compilation.mock.calls.length;
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
    const compilations = compilation.mock.calls.length;
    expect(compilations).toBeGreaterThan(before);
    const repeated = await cooker.cook({ guid: 'mixed-standard-return', source: standard });
    expect(compilation).toHaveBeenCalledTimes(compilations);
    expect(hashes(repeated)).toEqual(baseline);
  }, 30_000);
});
