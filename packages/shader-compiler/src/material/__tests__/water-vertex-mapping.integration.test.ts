import {
  type MaterialAsset,
  type MaterialParameter,
  type MaterialRootAsset,
  type MaterialStaticSwitches,
  standardSurfaceParameters,
  WATER_DEFORMATION_INPUTS,
  WATER_DEFORMATION_VERSION,
  waterDeformationInputLayout,
  waterDeformationInputLayoutHash,
} from '@forgeax/engine-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { cookMaterialAsset } from '../cook.js';
import { collectMaterialSources, materialShaderSourceRoots } from '../pack-cooker.js';
import { buildMaterialSourceCatalog, type MaterialSourceCatalog } from '../source-catalog.js';

const surface = `#define_import_path test::water_mapping_surface
#import forgeax_material::single_layer_water_surface_v1::{SingleLayerWaterSurfaceInput, SingleLayerWaterSurfaceData}
#import forgeax_material::water_waves::{waterBodyHeightDepth, waterBodyVelocity, waterMaterialDrawData}
fn evaluate_surface(input: SingleLayerWaterSurfaceInput) -> SingleLayerWaterSurfaceData {
  let body = waterMaterialDrawData.bodyIndex;
  let heightDepth = waterBodyHeightDepth(body, input.positionWS.xz, vec3<f32>(0.0));
  let flow = waterBodyVelocity(body, input.positionWS.xz, input.vertexFlowXZ);
  return SingleLayerWaterSurfaceData(normalize(input.geometricNormalWS),
    clamp(abs(heightDepth.y) * 0.01, 0.02, 1.0), 1.0, 0.0,
    vec3<f32>(1.25, 0.0833333333, 0.0357142857), vec3<f32>(0.05 + length(flow) * 0.001),
    1.30990195, 0.1, 1000.0, 1.15, 0.0, vec3<f32>(1.0), vec3<f32>(0.85), 0.0, vec3<f32>(0.0));
}`;

let sources: MaterialSourceCatalog;
beforeAll(async () => {
  const roots = materialShaderSourceRoots();
  const collected = await collectMaterialSources(roots, roots);
  sources = buildMaterialSourceCatalog({
    roots,
    engine: collected.engine,
    project: [
      ...collected.project,
      { source: surface, path: 'test/water_mapping_surface.wgsl' },
      {
        path: 'test/water_mapping_deformation.wgsl',
        source: `#define_import_path test::water_mapping_deformation
#import forgeax_material::water_deformation_v1::{WaterDeformationInput, WaterDeformationOutput}
fn deform_water_vertex(input: WaterDeformationInput) -> WaterDeformationOutput {
  return WaterDeformationOutput(input.positionM, input.previousPositionM, input.normalYUp,
    input.normalYUp, 1.0, input.bodyRenderIndex);
}`,
      },
    ],
  }).unwrap();
});

function material(
  switches: MaterialStaticSwitches,
  parameters: readonly MaterialParameter[] = [],
): MaterialRootAsset {
  return {
    kind: 'material',
    parameters,
    surface: {
      model: 'single-layer-water',
      module: 'test::water_mapping_surface',
      deformation: {
        module: 'forgeax_material::water_deformation_default',
        version: WATER_DEFORMATION_VERSION,
        inputs: WATER_DEFORMATION_INPUTS,
      },
    },
    staticSwitches: {
      waterWaves: false,
      waterInfo: false,
      waterBakedSimulation: false,
      waterFixedHeight: false,
      waterFixedDepth: false,
      ...switches,
    },
    passes: [{ name: 'forward', program: { module: 'forgeax::single-layer-water' } }],
  };
}

async function cook(switches: MaterialStaticSwitches, parameters?: readonly MaterialParameter[]) {
  const asset = material(switches, parameters);
  const result = await cookMaterialAsset({ material: 'root', table: { root: asset }, sources });
  expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
  if (!result.ok) throw result.error;
  const pass = result.value.passes.find((entry) => entry.pass === 'forward');
  if (pass === undefined) throw new Error('Missing compiled Water forward pass');
  expect(pass.abi.systemInputs).toEqual({ water: 'water-frame/3' });
  expect(pass.abi.surface?.deformation?.inputLayout).toEqual(waterDeformationInputLayout());
  expect(pass.abi.surface?.deformation?.inputLayoutHash).toBe(waterDeformationInputLayoutHash());
  return pass.compile.reflection.entryPoints ?? [];
}

describe('independent Water vertex mapping', () => {
  it.each([
    'none',
    'default',
    'custom',
    'inherited',
  ] as const)('selects stock pixel deformation helpers from the resolved %s deformation', async (selection) => {
    const asset = material({});
    if (asset.surface?.deformation === undefined) throw new Error('Missing fixture deformation');
    const { deformation, ...surface } = asset.surface;
    const root: MaterialAsset = {
      ...asset,
      surface: {
        ...surface,
        ...(selection === 'none'
          ? {}
          : {
              deformation: {
                ...deformation,
                module:
                  selection === 'custom'
                    ? 'test::water_mapping_deformation'
                    : 'forgeax_material::water_deformation_default',
              },
            }),
      },
    };
    await expect(
      cookMaterialAsset(
        {
          material: selection === 'inherited' ? 'child' : 'root',
          table: { root, child: { kind: 'material', parent: 'root' } },
          sources,
        },
        async (_source, options) => {
          expect(options?.defines?.WATER_DEFAULT_DEFORMATION_AVAILABLE).toBe(
            selection === 'default' || selection === 'inherited',
          );
          throw new Error('Resolved deformation define checked');
        },
      ),
    ).rejects.toThrow('Resolved deformation define checked');
  });

  it.each([
    { model: 'standard', waves: false },
    { model: 'standard', waves: true },
    { model: 'single-layer-water', waves: false },
    { model: 'single-layer-water-fluid', waves: false },
  ] as const)('cooks stock $model textures with waves=$waves and the shared default deformation provider', async ({
    model,
    waves,
  }) => {
    const stockWaterParameters: MaterialParameter[] = [
      ...[
        'maximumFlowVelocityMPerSec',
        'normalFarStartM',
        'normalFarRangeM',
        'normalTilingM',
        'distantNormalTilingM',
        'normalSpeed',
        'normalStrength',
        'distantNormalStrength',
        'roughness',
        'fresnelRoughness',
        'specular',
        'criticalAngleWidth',
        'criticalAngleBendWidth',
        'criticalAngleDot',
        'refractionBottomAmount',
        'refractionPixelNormalStrength',
        'distantRefractionPixelNormalStrength',
        'refractionDistanceM',
        'lipRefraction',
        'opacityMaskDepthOffsetM',
        'simulationWaterDepthM',
        'fluidNormalStrength',
        'fluidDisplacementMultiplier',
        'maximumFluidDisplacementM',
        'showFluidSimulation',
        'coefficientMask',
        'phaseG',
        'maximumOpticalDistanceM',
        'refractionDepthBias',
        'causticsMaxIntensity',
        'foamRoughness',
      ].map((name) => ({ name, type: 'f32' as const, default: 1 })),
      ...[
        'absorptionPerM',
        'scatteringPerM',
        'foamScatteringPerM',
        'colorScaleBehindWater',
        'waterAlbedo',
      ].map((name) => ({ name, type: 'vec3' as const, default: [1, 1, 1] as const })),
      ...[
        'waterNormalTexture',
        'waterFlowTexture',
        'waterFlowNormalTexture',
        'waterFoamTexture',
        'waterFoamNormalTexture',
        'waterNoiseTexture',
        'waterVolumeNoiseTexture',
      ].map((name) => ({ name, type: 'texture' as const })),
    ];
    const fluid = model === 'single-layer-water-fluid';
    const stock = material({
      waterVertexMapping: false,
      waterWaves: waves,
      waterNormalTexture: !fluid,
      waterFluidSimulation: fluid,
    });
    if (stock.surface === undefined) throw new Error('Missing fixture Surface');
    const result = await cookMaterialAsset({
      material: 'stock-textured-deformation',
      table: {
        'stock-textured-deformation': {
          ...stock,
          parameters:
            model === 'standard'
              ? standardSurfaceParameters([{ name: 'normalTexture', type: 'texture' }])
              : stockWaterParameters,
          surface: {
            ...stock.surface,
            model: model === 'standard' ? 'standard' : 'single-layer-water',
            module:
              model === 'standard'
                ? 'forgeax_material::default_standard_surface'
                : 'forgeax_material::water_surface',
          },
          passes: [
            {
              name: 'forward',
              program: {
                module:
                  model === 'standard'
                    ? 'forgeax_material::standard'
                    : 'forgeax::single-layer-water',
              },
            },
          ],
        },
      },
      sources,
    });
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;
    const pass = result.value.passes[0];
    expect(pass?.sceneCompile).toBeDefined();
    expect(pass?.abi.positionBounds).toBeUndefined();
    if (pass?.sceneCompile === undefined) throw new Error('Missing stock scene-index program');
    for (const compiled of [pass.compile, pass.sceneCompile]) {
      const bindings = compiled.reflection.boundGlobals.map(
        (binding) => `${binding.group}:${binding.binding}`,
      );
      expect(new Set(bindings).size).toBe(bindings.length);
      expect(
        compiled.reflection.boundGlobals.some(
          (binding) => binding.group === 1 && binding.binding > 0,
        ),
      ).toBe(true);
      expect(compiled.wgsl).toContain('textureSample');
    }
  });

  it.each([
    { missing: 'waveVelocityMaskThresholdMPerSec', parameters: [] },
    {
      missing: 'waveVelocityMaskThresholdMPerSec',
      parameters: [{ name: 'waveVelocityMaskThresholdMPerSec', type: 'vec2', default: [1, 1] }],
    },
    {
      missing: 'maximumFlowVelocityMPerSec',
      parameters: [{ name: 'waveVelocityMaskThresholdMPerSec', type: 'f32', default: 1 }],
    },
    {
      missing: 'maximumFlowVelocityMPerSec',
      parameters: [
        { name: 'waveVelocityMaskThresholdMPerSec', type: 'f32', default: 1 },
        { name: 'maximumFlowVelocityMPerSec', type: 'vec2', default: [10.24, 10.24] },
      ],
    },
  ] satisfies readonly {
    missing: string;
    parameters: readonly MaterialParameter[];
  }[])('rejects missing or incompatible transition flow contract before compilation: $missing', async ({
    missing,
    parameters,
  }) => {
    const asset = material({ waterTransitionLake: true, waterInfo: true }, parameters);
    const result = cookMaterialAsset(
      { material: 'root', table: { root: asset }, sources },
      async () => {
        throw new Error('Compiler must not run for an incomplete transition contract');
      },
    );
    await expect(result).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'material-derived-interface-mismatch',
        detail: { stage: 'cook', parameter: missing, expected: { type: 'f32' } },
      },
    });
  });

  it.each([
    { waterWaves: true, waterTransitionLake: true },
    { waterTransitionLake: false, waterTransitionOcean: false },
  ])('does not impose transition parameters on an inactive branch: %j', async (switches) => {
    const asset = material(switches);
    await expect(
      cookMaterialAsset({ material: 'root', table: { root: asset }, sources }, async () => {
        throw new Error('Selected branch reached compilation');
      }),
    ).rejects.toThrow('Selected branch reached compilation');
  });

  it.each([
    undefined,
    false,
    true,
  ])('selects dynamic clipping=%s without texture or mapping requirements', async (clip) => {
    const points = await cook({
      waterVertexMapping: false,
      ...(clip === undefined ? {} : { waterDynamicBoundsClip: clip }),
    });
    expect(
      points.some(
        (point) =>
          point.stage === 'fragment' &&
          point.bindings.some(
            (read) =>
              read.group === 2 &&
              read.binding === 16 &&
              read.fields?.includes('dynamicBoundsCenterExtentXZ'),
          ),
      ),
    ).toBe(clip === true);
    expect(
      points.some((point) =>
        point.bindings.some((read) => read.group === 2 && [18, 19, 20].includes(read.binding)),
      ),
    ).toBe(false);
  });

  it.each([
    'fixed',
    'baked',
    'vertex',
  ] as const)('compiles selected transition %s flow with the derived contract', async (source) => {
    const parameters: MaterialParameter[] = [
      { name: 'waveVelocityMaskThresholdMPerSec', type: 'f32', default: 0.5 },
      ...(source === 'vertex'
        ? [{ name: 'maximumFlowVelocityMPerSec', type: 'f32' as const, default: 10.24 }]
        : []),
    ];
    const points = await cook(
      {
        waterTransitionLake: true,
        waterVertexMapping: false,
        waterFixedVelocity: source === 'fixed',
        waterBakedSimulation: source === 'baked',
      },
      parameters,
    );
    expect(
      points.some(
        (point) =>
          point.stage === 'vertex' &&
          point.bindings.some(
            (read) => read.group === 1 && read.fields?.includes('waveVelocityMaskThresholdMPerSec'),
          ),
      ),
    ).toBe(true);
    expect(
      points.some(
        (point) =>
          point.stage === 'vertex' &&
          point.bindings.some((read) => read.group === 2 && read.binding === 17),
      ),
    ).toBe(true);
  });

  it.each([
    { waterInfo: true, vertex: true, binding: 18 },
    { waterInfo: true, waterVertexMapping: false, vertex: false, binding: 18 },
    { waterInfo: true, waterVertexMapping: true, vertex: true, binding: 18 },
    { waterBakedSimulation: true, waterVertexMapping: false, vertex: false, binding: 24 },
    { waterBakedSimulation: true, waterVertexMapping: true, vertex: true, binding: 24 },
  ])('preserves fragment sampling with authored mapping: %j', async (selection) => {
    const { vertex, binding, ...switches } = selection;
    const points = await cook(switches);
    const reads = (stage: 'vertex' | 'fragment') =>
      points.some(
        (point) =>
          point.stage === stage &&
          point.bindings.some((read) => read.group === 2 && read.binding === binding),
      );
    expect(reads('vertex')).toBe(vertex);
    expect(reads('fragment')).toBe(true);
  });

  it.each([
    false,
    true,
  ])('keeps authored waves=%s independent of disabled mapping', async (waves) => {
    const points = await cook({
      waterVertexMapping: false,
      waterWaves: waves,
      waterFixedHeight: true,
      waterFixedDepth: true,
    });
    const vertex = points.filter((point) => point.stage === 'vertex');
    expect(
      vertex.some((point) =>
        point.bindings.some((read) => read.group === 2 && read.binding === 17),
      ),
    ).toBe(waves);
    expect(
      vertex.some((point) =>
        point.bindings.some((read) => read.group === 2 && read.binding === 18),
      ),
    ).toBe(false);
    expect(
      points.some(
        (point) =>
          point.stage === 'fragment' &&
          point.bindings.some(
            (read) =>
              read.group === 2 &&
              read.binding === 16 &&
              read.fields?.includes('fixedHeightDepthVelocity'),
          ),
      ),
    ).toBe(true);
  });

  it.each([false, true])('maps fixed height only when authored mapping is %s', async (mapping) => {
    const points = await cook({
      waterVertexMapping: mapping,
      waterFixedHeight: true,
      waterFixedDepth: true,
    });
    const readsFixed = (stage: 'vertex' | 'fragment') =>
      points.some(
        (point) =>
          point.stage === stage &&
          point.bindings.some(
            (read) =>
              read.group === 2 &&
              read.binding === 16 &&
              read.fields?.includes('fixedHeightDepthVelocity'),
          ),
      );
    expect(readsFixed('vertex')).toBe(mapping);
    expect(readsFixed('fragment')).toBe(true);
  });

  it('does not map vertices when no authored height source is available', async () => {
    const points = await cook({ waterVertexMapping: true });
    expect(
      points.some(
        (point) =>
          point.stage === 'vertex' &&
          point.bindings.some(
            (read) =>
              read.group === 2 &&
              read.binding === 16 &&
              read.fields?.includes('fixedHeightDepthVelocity'),
          ),
      ),
    ).toBe(false);
  });
});
