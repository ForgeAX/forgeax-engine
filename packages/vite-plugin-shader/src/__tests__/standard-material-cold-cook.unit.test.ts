import { on } from 'node:events';
import { Worker } from 'node:worker_threads';
import type { CookedMaterialRecord } from '@forgeax/engine-pack';
import { createBuiltinMaterialAsset } from '@forgeax/engine-shader';
import { afterAll, describe, expect, it, onTestFailed } from 'vitest';

type Selection = CookedMaterialRecord['programs'][number]['selections'][number];
type SelectionEvidence = Pick<Selection, 'address' | 'context' | 'entry' | 'pass'> & {
  vertexColor: boolean | undefined;
};
type CookResult = { artifacts: number; selections: SelectionEvidence[] } | { error: string };

function startCooker() {
  const env = { ...process.env };
  delete env.NODE_V8_COVERAGE;
  // The serial fixture owns a single material at a time. Give its program
  // compiler the existing four-worker cap instead of reserving idle material lanes.
  if (Number(env.FORGEAX_SHADER_COMPILE_WORKERS) > 4) env.FORGEAX_SHADER_COMPILE_WORKERS = '4';
  const worker = new Worker(new URL('./standard-material-cold-cook.fixture.mjs', import.meta.url), {
    env,
  });
  return { worker, replies: on(worker, 'message', { close: ['exit'] }) };
}

describe.sequential('Standard material cold cook', () => {
  const storageCapabilities = [
    'storage-buffer-minimum',
    'storage-buffer-projector',
    'storage-buffer',
    'storage-buffer-atmosphere',
  ] as const;
  let cooker: ReturnType<typeof startCooker> | undefined;
  const stopCooker = async () => {
    const active = cooker;
    cooker = undefined;
    await active?.worker.terminate();
  };
  afterAll(stopCooker);
  // Exercise the smaller independent roots first so the full Standard
  // matrix can spend its case budget on compilation and artifact admission.
  // No material root reuses a previous case's cooked result.
  it.each([
    'forgeax::vfx-render.particles.mesh',
    'forgeax::vfx-render.particles.mesh-inputs',
    'forgeax_material::pbr-skin',
    'forgeax_material::standard',
  ])('retains the declared material interface without transmission: %s', async (module) => {
    onTestFailed(stopCooker);
    cooker ??= startCooker();
    const active = cooker;
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
    active.worker.postMessage({
      guid: '019f0000-0000-7000-8000-000000000101',
      source: {
        ...material,
        ...(passes === undefined ? {} : { passes }),
      },
    });
    const reply = await active.replies.next();
    if (reply.done) throw new Error('Material compiler exited without a publication');
    const [result] = reply.value as [CookResult];
    if ('error' in result) throw new Error(result.error);
    // Storage roots cover visible-surface, view clipping and both color ABIs
    // on direct/scene-index lanes. Rigid Standard additionally covers LOD
    // coverage and publishes ray-hit/Card; portable backends share source bytes.
    expect(result.artifacts).toBe(
      module === 'forgeax_material::standard'
        ? storageCapabilities.length * 32 + 6
        : module === 'forgeax_material::pbr-skin'
          ? storageCapabilities.length * 16 + 4
          : storageCapabilities.length,
    );
    const { selections } = result;
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
      const lodCoverageStates = module === 'forgeax_material::standard' ? [false, true] : [false];
      for (const capability of storageCapabilities) {
        for (const visibleSurface of [false, true]) {
          for (const viewClipping of [false, true]) {
            for (const lodCoverage of lodCoverageStates) {
              for (const vertexColor of [false, true]) {
                expect(
                  selections
                    .filter(
                      (selection) =>
                        selection.context.pipeline !== 'ray' &&
                        selection.context.capability === capability &&
                        (selection.context.visibleSurface === true) === visibleSurface &&
                        (selection.context.viewClipping === true) === viewClipping &&
                        (selection.context.lodCoverage === true) === lodCoverage &&
                        selection.vertexColor === vertexColor,
                    )
                    .map((selection) => selection.address),
                ).toEqual(['direct', 'scene-index']);
              }
            }
          }
        }
      }
      for (const backend of ['webgpu', 'webgl2']) {
        for (const viewClipping of [false, true]) {
          for (const vertexColor of [false, true]) {
            expect(
              selections
                .filter(
                  (selection) =>
                    selection.context.backend === backend &&
                    selection.context.capability === 'uniform-fallback' &&
                    (selection.context.viewClipping === true) === viewClipping &&
                    selection.context.lodCoverage !== true &&
                    selection.vertexColor === vertexColor,
                )
                .map((selection) => selection.address),
            ).toEqual(['direct']);
          }
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
