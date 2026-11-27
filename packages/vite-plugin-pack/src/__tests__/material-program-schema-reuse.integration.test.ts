import { createHash } from 'node:crypto';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { Materials } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  captureMaterialSourceSnapshot,
  createMaterialPackCooker,
} from '../../../shader-compiler/src/index';

// Keep Pack admission observable in this realm while real shader programs use
// the existing bounded compiler workers. Every portable variant is still cooked.
vi.mock('../../../shader-compiler/src/material/node-material-cooker', () => ({
  withNodeMaterialWorkers: (cooker: unknown) => cooker,
}));

type CompilerModule = typeof import('../../../shader-compiler/src/material/node-program-compiler');
const { compilers } = vi.hoisted(() => ({
  compilers: [] as Array<
    ReturnType<CompilerModule['createNodeMaterialProgramCompiler']> & {
      readonly compileCalls: number;
    }
  >,
}));
vi.mock('../../../shader-compiler/src/material/node-program-compiler', async (importOriginal) => {
  const actual = await importOriginal<CompilerModule>();
  return {
    ...actual,
    createNodeMaterialProgramCompiler: () => {
      const compiler = actual.createNodeMaterialProgramCompiler();
      // Count the real requests without retaining their shader sources or promise results.
      let compileCalls = 0;
      const observed = {
        ...compiler,
        get compileCalls() {
          return compileCalls;
        },
        compile(...args: Parameters<typeof compiler.compile>) {
          compileCalls++;
          return compiler.compile(...args);
        },
      };
      compilers.push(observed);
      return observed;
    },
  };
});

// The three schemas share immutable shipped WGSL. Separate source-edit cases
// own live filesystem invalidation.
const sourceSnapshot = await captureMaterialSourceSnapshot([]);

describe.sequential('Standard program reuse across material schemas', () => {
  const compiler = compilers[0];
  if (compiler === undefined) throw new Error('Pack program compiler was not initialized');
  const cooker = createMaterialPackCooker([], { sourceSnapshot });
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
  let baselineCooked: unknown;
  beforeAll(async () => {
    const first = await cooker.cook({ guid: 'mixed-standard-first', source: standard });
    baseline = hashes(first);
    baselineCooked = (first.payload as { cooked: unknown }).cooked;
    expect(compiler.compileCalls).toBeGreaterThan(0);
  }, 30_000);

  it('reuses the complete Standard publication after a clearcoat schema', async () => {
    const before = compiler.compileCalls;
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
    const compilations = compiler.compileCalls;
    expect(compilations).toBeGreaterThan(before);
    const repeated = await cooker.cook({
      guid: 'mixed-standard-after-clearcoat',
      source: standard,
    });
    expect(compiler.compileCalls).toBe(compilations);
    expect(hashes(repeated)).toEqual(baseline);
  }, 30_000);

  it('reuses the complete Standard publication after a skinned schema in the same cooker', async () => {
    // The cold beforeAll publication is the baseline even when this case runs
    // alone. A second warm Standard cook adds no new coverage to the transition.
    const before = compiler.compileCalls;
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
    const compilations = compiler.compileCalls;
    expect(compilations).toBeGreaterThan(before);
    const repeated = await cooker.cook({ guid: 'mixed-standard-return', source: standard });
    expect(compiler.compileCalls).toBe(compilations);
    expect(hashes(repeated)).toEqual(baseline);
  }, 30_000);

  // Leave portable record validation and byte comparison after the timed schema transitions.
  it('retains complete portable programs when only the authored color changes', async () => {
    const compilations = compiler.compileCalls;
    const updated = await cooker.cook({
      guid: 'mixed-standard-green',
      source: Materials.standard({ baseColor: [0, 1, 0, 1], metallic: 0, roughness: 0.5 }),
    });
    const baselineRecord = validateCookedMaterialRecord(baselineCooked).unwrap();
    const record = validateCookedMaterialRecord(
      (updated.payload as { cooked: unknown }).cooked,
    ).unwrap();
    const selections = baselineRecord.programs.flatMap((program) => program.selections);
    expect(new Set(selections.map((selection) => selection.context.backend))).toEqual(
      new Set(['webgpu', 'webgl2']),
    );
    expect(
      selections.some((selection) => selection.context.capability === 'uniform-fallback'),
    ).toBe(true);
    expect(record.programs).toHaveLength(baselineRecord.programs.length);
    for (const [index, current] of record.programs.entries()) {
      const original = baselineRecord.programs[index];
      if (original === undefined) throw new Error('compiled program count changed');
      const { bytes: currentBytes, ...currentArtifact } = current.artifact;
      const { bytes: originalBytes, ...originalArtifact } = original.artifact;
      expect(Buffer.compare(currentBytes, originalBytes)).toBe(0);
      expect({ ...current, artifact: currentArtifact }).toEqual({
        ...original,
        artifact: originalArtifact,
      });
    }
    expect(record.resolved.values.baseColor).not.toEqual(baselineRecord.resolved.values.baseColor);
    expect(compiler.compileCalls).toBe(compilations);
  });
});
