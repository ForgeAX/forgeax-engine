import { ok } from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { MaterialRenderState } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  createRasterPipelines,
  type RasterPipelineShape,
} from '../gpu-driven/production-raster-classes';
import { maskedInEarlyPassVariantSet } from '../material-alpha-mask';
import { seededDepthRenderState } from '../material-render-state';

// A published scene-index Standard row of the masked forward lane.
const MASKED =
  'ALPHA_MASK=true+CLIPPING_PLANES=true+DIRECTIONAL_SHADOW_SIMPLE=false+GPU_DRIVEN_SCENE_INDEX_AVAILABLE=true+LEAN_LIGHTING=false+LOD_DITHER=false';
const OPAQUE =
  'ALPHA_MASK=false+CLIPPING_PLANES=false+DIRECTIONAL_SHADOW_SIMPLE=false+GPU_DRIVEN_SCENE_INDEX_AVAILABLE=true+LEAN_LIGHTING=false+LOD_DITHER=false';
const OPAQUE_SIMPLE = OPAQUE.replace(
  'DIRECTIONAL_SHADOW_SIMPLE=false',
  'DIRECTIONAL_SHADOW_SIMPLE=true',
).replace('LEAN_LIGHTING=false', 'LEAN_LIGHTING=true');

const seeded = (state: MaterialRenderState | undefined, alphaMask = true) =>
  seededDepthRenderState(state, alphaMask);

describe('alpha test only in the depth prepass (UE r.EarlyZPassOnlyMaterialMasking)', () => {
  it('drops the alpha discard only for a seeded masked writer tested equal', () => {
    expect(maskedInEarlyPassVariantSet(MASKED, undefined, seeded(undefined), undefined)).toBe(
      OPAQUE,
    );
    for (const entry of ['fs_main', 'fs_opaque', 'fs_forward_screen'])
      expect(maskedInEarlyPassVariantSet(MASKED, {}, seeded({}), entry)).toBe(OPAQUE);
  });

  it('keeps the discard when the main pass is not seeded by the same alpha test', () => {
    // Not seeded: the authored `less` + write state.
    expect(maskedInEarlyPassVariantSet(MASKED, undefined, undefined, undefined)).toBe(MASKED);
    expect(maskedInEarlyPassVariantSet(MASKED, {}, {}, undefined)).toBe(MASKED);
    // Seeded as opaque (`less-equal`): the prepass did not alpha-test this draw.
    expect(maskedInEarlyPassVariantSet(MASKED, {}, seeded({}, false), undefined)).toBe(MASKED);
    // An authored `equal` is not the seed: nothing proves the prepass ran its alpha test.
    const authoredEqual: MaterialRenderState = { depthCompare: 'equal', depthWriteEnabled: false };
    expect(maskedInEarlyPassVariantSet(MASKED, authoredEqual, authoredEqual, undefined)).toBe(
      MASKED,
    );
    // A no-write material is not in the prepass.
    const noWrite: MaterialRenderState = { depthWriteEnabled: false };
    expect(maskedInEarlyPassVariantSet(MASKED, noWrite, seeded(noWrite), undefined)).toBe(MASKED);
  });

  it('keeps the discard for alpha-to-coverage, blending and non-colour entries', () => {
    const a2c: MaterialRenderState = { alphaToCoverageEnabled: true };
    expect(maskedInEarlyPassVariantSet(MASKED, a2c, seeded(a2c), undefined)).toBe(MASKED);
    // A transparent override of the seeded state (blend after seeding).
    const blended = { ...seeded({}), blend: {} } as MaterialRenderState;
    expect(maskedInEarlyPassVariantSet(MASKED, {}, blended, undefined)).toBe(MASKED);
    // Depth write restored after seeding (transparent depth write).
    const rewrite = { ...seeded({}), depthWriteEnabled: true } as MaterialRenderState;
    expect(maskedInEarlyPassVariantSet(MASKED, {}, rewrite, undefined)).toBe(MASKED);
    for (const entry of ['fs_ao_input', 'fs_gbuffer', 'fs_temporal', 'fs_nearest_layer'])
      expect(maskedInEarlyPassVariantSet(MASKED, {}, seeded({}), entry)).toBe(MASKED);
  });

  it('leaves opaque, authored and LOD cross-fade keys to their own discard axes', () => {
    expect(maskedInEarlyPassVariantSet(OPAQUE, {}, seeded({}), undefined)).toBe(OPAQUE);
    // A cooked custom Surface does not declare the axis.
    expect(maskedInEarlyPassVariantSet('', {}, seeded({}), undefined)).toBe('');
    expect(maskedInEarlyPassVariantSet(undefined, {}, seeded({}), undefined)).toBeUndefined();
    // LOD cross-fade keeps LOD_DITHER and its bound CLIPPING_PLANES.
    const lod = MASKED.replace('LOD_DITHER=false', 'LOD_DITHER=true');
    expect(maskedInEarlyPassVariantSet(lod, {}, seeded({}), undefined)).toBe(
      lod.replace('ALPHA_MASK=true', 'ALPHA_MASK=false'),
    );
  });
});

describe('GPU-driven seeded raster class', () => {
  const shapeFor = (variantSet: string, renderState?: MaterialRenderState) => {
    const pipeline = vi.fn((..._args: unknown[]) => ok({}));
    // The adapter is opaque here: only the selected artifact and state matter.
    const shape = {
      raster: { pipeline },
      prepared: { mesh: { layoutProjection: {} }, batch: { key: { topology: 'triangle-list' } } },
      artifact: { material: 'forgeax::default-standard-pbr', variantSet },
      deformation: 'rigid',
      format: 'rgba16float',
      sampleCount: 1,
      rendererRecording: true,
      shaderUvSetCount: 1,
      stripIndexFormat: undefined,
      standardSurfaceDiscards: 0,
      layoutProjection: undefined,
      topology: undefined,
      renderState,
      standardTextureMask: undefined,
      preparationFactory: undefined,
      visibleSurface: false,
      directionalShadowSimple: true,
      leanLighting: true,
    } as unknown as RasterPipelineShape;
    const calls = () =>
      pipeline.mock.calls.map((call) => ({
        variantSet: (call[7] as MaterialShaderArtifact).variantSet,
        state: call[6] as MaterialRenderState | undefined,
      }));
    return { pipelines: createRasterPipelines(shape), calls };
  };

  it('draws a seeded masked row with the discard-free program under equal / no write', () => {
    for (const entry of [undefined, 'fs_opaque', 'fs_forward_screen']) {
      const { pipelines, calls } = shapeFor(MASKED);
      expect(pipelines.seededPipelineFor(entry)(['rgba16float']).ok).toBe(true);
      const [call] = calls();
      // The discard-free key takes the simple receiver like any opaque row.
      expect(call?.variantSet).toBe(OPAQUE_SIMPLE);
      expect(call?.state?.depthCompare).toBe('equal');
      expect(call?.state?.depthWriteEnabled).toBe(false);
    }
  });

  it('keeps the alpha discard outside the seeded pass and for alpha-to-coverage', () => {
    const plain = shapeFor(MASKED);
    expect(plain.pipelines.pipelineFor(['rgba16float']).ok).toBe(true);
    expect(plain.pipelines.opaquePipelineFor(['rgba16float']).ok).toBe(true);
    expect(plain.calls().map((call) => call.variantSet)).toEqual([MASKED, MASKED]);
    const a2c = shapeFor(MASKED, { alphaToCoverageEnabled: true });
    expect(a2c.pipelines.seededPipelineFor(undefined)(['rgba16float']).ok).toBe(true);
    expect(a2c.calls()[0]?.variantSet).toBe(MASKED);
    expect(a2c.calls()[0]?.state?.depthCompare).toBe('equal');
  });

  it('keeps an opaque seeded row on less-equal with its simple receiver', () => {
    const { pipelines, calls } = shapeFor(OPAQUE);
    expect(pipelines.seededPipelineFor(undefined)(['rgba16float']).ok).toBe(true);
    const [call] = calls();
    expect(call?.state?.depthCompare).toBe('less-equal');
    expect(call?.variantSet).toBe(OPAQUE_SIMPLE);
  });
});
