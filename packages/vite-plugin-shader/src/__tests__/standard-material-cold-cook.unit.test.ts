import { resolve } from 'node:path';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { createBuiltinMaterialAsset } from '@forgeax/engine-shader';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { describe, expect, it } from 'vitest';

describe('Standard material cold cook', () => {
  const storageCapabilities = [
    'storage-buffer-minimum',
    'storage-buffer-projector',
    'storage-buffer',
    'storage-buffer-atmosphere',
  ] as const;
  // Cold filesystem discovery and all Standard variants share the
  // explicit compiler-fixture budget used by covered Pack/Surface cooks.
  // Keep every artifact and ABI assertion inside this bounded operation.
  it.each([
    'forgeax_material::standard',
    'forgeax_material::pbr-skin',
    'forgeax::vfx-render.particles.mesh',
    'forgeax::vfx-render.particles.mesh-inputs',
  ])('retains the declared material interface without transmission: %s', async (module) => {
    const root = resolve(import.meta.dirname, '../../../shader/src');
    const particleRoot = resolve(import.meta.dirname, '../../../vfx-render/src/shaders');
    const material = createBuiltinMaterialAsset('standard');
    const passes = material.passes?.map((pass) => {
      const program = { ...pass.program, module };
      if (!module.startsWith('forgeax::vfx-render')) return { ...pass, program };
      // Particle mesh shaders own the Standard Surface ABI directly; they are
      // not Standard-root templates and therefore must not retain the root's
      // `moduleSlots.surface` selector when cold-cooked.
      const { moduleSlots: _moduleSlots, ...programWithoutSlots } = pass.program;
      return { ...pass, program: { ...programWithoutSlots, module } };
    });
    const draft = await createMaterialPackCooker([root, particleRoot]).cook({
      guid: '019f0000-0000-7000-8000-000000000101',
      source: {
        ...material,
        ...(passes === undefined ? {} : { passes }),
      },
    });
    // Standard roots publish ordinary/visible direct and scene-index artifacts;
    // for each texture capability and color ABI, plus two portable artifacts.
    // Rigid Standard additionally publishes ray-hit and Card artifacts.
    expect(Object.keys(draft.artifacts)).toHaveLength(
      module === 'forgeax_material::standard'
        ? storageCapabilities.length * 8 + 4
        : module === 'forgeax_material::pbr-skin'
          ? storageCapabilities.length * 8 + 2
          : storageCapabilities.length,
    );
    const cooked = validateCookedMaterialRecord(
      (draft.payload as Record<string, unknown>).cooked,
    ).unwrap();
    const selections = cooked.programs.flatMap((program) => program.selections);
    // Both Surface derivatives select from the same authored forward pass.
    // Skinned and particle roots retain their existing raster-only admission.
    expect(
      selections
        .filter((selection) => selection.context.pipeline === 'ray')
        .map((selection) => ({
          pass: selection.pass,
          context: selection.context.pass,
          entry: selection.entry,
        }))
        .sort((left, right) => left.context.localeCompare(right.context)),
    ).toEqual(
      module === 'forgeax_material::standard'
        ? [
            { pass: 'forward', context: 'card-capture', entry: 'vs_card' },
            { pass: 'forward', context: 'ray-hit', entry: 'cs_surface' },
          ]
        : [],
    );
    if (!module.startsWith('forgeax::vfx-render')) {
      for (const capability of storageCapabilities) {
        for (const visibleSurface of [false, true]) {
          for (const vertexColor of [false, true]) {
            expect(
              selections
                .filter(
                  (selection) =>
                    selection.context.pipeline !== 'ray' &&
                    selection.context.capability === capability &&
                    (selection.context.visibleSurface === true) === visibleSurface &&
                    selection.abi?.vertexInputs.some((input) => input.semantic === 'color') ===
                      vertexColor,
                )
                .map((selection) => selection.address),
            ).toEqual(['direct', 'scene-index']);
          }
        }
      }
      for (const backend of ['webgpu', 'webgl2']) {
        for (const vertexColor of [false, true]) {
          expect(
            selections
              .filter(
                (selection) =>
                  selection.context.backend === backend &&
                  selection.context.capability === 'uniform-fallback' &&
                  selection.abi?.vertexInputs.some((input) => input.semantic === 'color') ===
                    vertexColor,
              )
              .map((selection) => selection.address),
          ).toEqual(['direct']);
        }
      }
    } else {
      expect(
        selections.every(
          (selection) =>
            selection.context.pipeline !== 'ray' && selection.context.visibleSurface !== true,
        ),
      ).toBe(true);
    }
  }, 15_000);
});
