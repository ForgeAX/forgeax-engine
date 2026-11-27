import { afterAll, assert, expect, it, vi } from 'vitest';
import { isNativePlacementMaterial } from '../../raytracing/scene-field-projection';
import {
  cookCustomCardPublication,
  customCardPublicationFixture,
  preparePublishedCards,
} from './custom-card-publication.fixture';

vi.hoisted(() => vi.stubEnv('FORGEAX_SHADER_COMPILE_WORKERS', '1'));
afterAll(() => vi.unstubAllEnvs());
let publication: ReturnType<typeof cookCustomCardPublication> | undefined;
const prepared = () => (publication ??= cookCustomCardPublication());

it('admits a genuinely published static custom textured Surface into retained Field rows', async () => {
  const fixture = await customCardPublicationFixture(await prepared());
  try {
    expect(
      fixture.acceptedMaterial.materialSurfacePrograms?.['card-capture'],
      'the actual cooked publication must provide its accepted Card derivative before Field admission',
    ).toBeDefined();
    const projected = fixture.project();
    expect(
      projected.ok,
      projected.ok
        ? ''
        : JSON.stringify({
            error: projected.error,
            accepted: {
              shader: fixture.acceptedMaterial.materialShaderId,
              keys: fixture.acceptedMaterial.materialProgramKeys,
              surfaces: fixture.acceptedMaterial.materialSurfacePrograms,
            },
            published: fixture.projection?.passes.map((pass) => ({
              name: pass.name,
              module: pass.module,
              slots: pass.moduleSlots,
              programs: pass.programs.map(({ context, specializationKey }) => ({
                context,
                specializationKey,
              })),
            })),
          }),
    ).toBe(true);
    if (!projected.ok) return;
    const source = projected.value.sources[0];
    assert(source);
    expect(source?.materials[0]?.snapshot.materialSurfacePrograms?.['card-capture']).toBeDefined();
    expect(source?.materials[0]?.snapshot.textureHandles?.get('baseColorTexture')).toBe(
      fixture.texture,
    );
    expect(source?.materials[0]?.snapshot.paramSnapshot?.roughness).toBe(0.375);
    expect(source?.materials[0]?.alphaCoverageOmitted).toBe(true);
    expect(projected.value.instances[0]?.surfaceCoverage).toBe('unknown');
    const prepared = await preparePublishedCards(fixture);
    try {
      const accepted = source?.materials[0];
      assert(accepted);
      const key = accepted.snapshot.materialSurfacePrograms?.['card-capture']?.programKey;
      assert(key);
      const artifact = fixture.shaders.findMaterialArtifact(key).unwrap();
      expect(prepared.codes).toContain(artifact.source);
      const instance = projected.value.instances[0];
      assert(instance);
      const lowered = prepared.cards.lower(source, instance, instance.instanceId);
      expect(lowered.sections[0]?.material.snapshot).toBe(accepted.snapshot);
      expect(lowered.sections[0]?.material.program.source).toBe(artifact.source);
      expect(prepared.cards.capture.textureReads).toHaveLength(1);
      expect(prepared.cards.capture.entries.length).toBe(1);
      expect(prepared.cards.projections.size).toBeGreaterThan(0);
      expect(prepared.cards.capture.allocatedTiles).toBe(source.mesh.cardLayout?.cards.length);
      const encoder = prepared.device.createCommandEncoder({}).unwrap();
      prepared.cards.capture.record(encoder).unwrap();
      encoder.finish().unwrap();
      expect(prepared.cards.capture.materialWork.rasterDraws).toBeGreaterThan(0);
    } finally {
      prepared.cards.release();
    }
  } finally {
    fixture.dispose();
  }
}, 60_000);

it('keeps the accepted raster and Card keys in the same published family and exact context', async () => {
  const fixture = await customCardPublicationFixture(await prepared());
  try {
    const material = fixture.acceptedMaterial;
    const projection = fixture.projection;
    assert(projection);
    assert(material.materialShaderId);
    expect(isNativePlacementMaterial(material, projection)).toBe(true);
    expect(
      isNativePlacementMaterial({ ...material, materialSurfacePrograms: undefined }, projection),
    ).toBe(false);
    expect(
      isNativePlacementMaterial(
        {
          ...material,
          materialSurfacePrograms: {
            'card-capture': { programKey: material.materialShaderId },
          },
        },
        projection,
      ),
    ).toBe(false);
    expect(
      isNativePlacementMaterial({ ...material, materialShaderId: 'unpublished' }, projection),
    ).toBe(false);
    expect(
      isNativePlacementMaterial(material, {
        ...projection,
        surface: {
          ...projection.surface,
          model: 'standard',
          module: 'game::published_card',
          dynamicInput: {
            name: 'events',
            fields: [{ name: 'time', type: 'f32' }],
            maxRecords: 1,
            maxDomains: 1,
            maxPageBytes: 16,
            maxBindings: 1,
            maxEventsPerSample: 1,
          },
        },
      }),
    ).toBe(false);
    for (const context of [
      { backend: 'webgl2' },
      { capability: 'uniform' },
      { pipeline: 'deferred' },
      { geometry: 'skinned' },
      { pass: 'ray-hit' },
      { profile: 'forgeax-material-card-v3' },
      { toolchain: 'foreign' },
      { instrumentation: 'debug' },
    ]) {
      const mismatched = {
        ...projection,
        passes: projection.passes.map((pass) => ({
          ...pass,
          programs: pass.programs.map((program) =>
            program.context?.pipeline === 'ray'
              ? { ...program, context: { ...program.context, ...context } }
              : program,
          ),
        })),
      } as typeof projection;
      expect(isNativePlacementMaterial(material, mismatched), JSON.stringify(context)).toBe(false);
    }
  } finally {
    fixture.dispose();
  }
}, 60_000);

it('refuses a genuinely published time-dependent Surface with no static Card derivative', async () => {
  const fixture = await customCardPublicationFixture(await cookCustomCardPublication(true));
  try {
    expect(fixture.acceptedMaterial.materialSurfacePrograms?.['card-capture']).toBeUndefined();
    expect(fixture.project()).toMatchObject({
      ok: false,
      error: {
        detail: {
          cause: 'retained field requires accepted native Standard material provenance',
        },
      },
    });
  } finally {
    fixture.dispose();
  }
}, 60_000);
