import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import {
  gpuDrivenMaterialProgramSelection,
  prepareHiddenGpuDrivenPipelines,
} from '../gpu-driven/material-artifacts';
import type { PreparedGpuDrivenDraw } from '../gpu-driven/prepared-draw';
import type { ValidatedRenderable } from '../record/frame-snapshot';
import type { MaterialShaderPipelineEntry, RenderSystemInternals } from '../record/render-context';
import { defaultMaterialSnapshot } from '../render-system-extract';
import {
  mesh,
  preparedPbrSnapshot,
  snapshot,
  standardPbrInputs,
} from './gpu-driven-production-fixture';

const prepared = {
  identity: { material: 'game::surface', geometry: 'box', deformation: 'rigid' },
} as PreparedGpuDrivenDraw;
const material = {
  ...defaultMaterialSnapshot(1),
  materialShaderId: 'game::surface',
  materialProgramKeys: { Forward: 'game::surface', Shadow: 'game::shadow' },
  materialSceneIndexProgramKeys: {
    Forward: { pass: 'forward' as const, specializationKey: 'game::surface-scene' },
    Shadow: { pass: 'shadow' as const, specializationKey: 'game::shadow-scene' },
  },
};

it('selects the direct and scene program pair for the actual pass', () => {
  expect(
    gpuDrivenMaterialProgramSelection(material, prepared, 'forward', undefined, {
      logicalMaterialShaderId: '',
      sceneIndexProgramKey: undefined,
      materialShaderId: '',
    }),
  ).toEqual({
    logicalMaterialShaderId: 'game::surface',
    materialShaderId: 'game::surface-scene',
    sceneIndexProgramKey: 'game::surface-scene',
  });
  expect(
    gpuDrivenMaterialProgramSelection(
      material,
      prepared,
      'shadow',
      {
        materialShaderId: 'game::shadow',
      },
      { logicalMaterialShaderId: '', sceneIndexProgramKey: undefined, materialShaderId: '' },
    ),
  ).toEqual({
    logicalMaterialShaderId: 'game::surface',
    materialShaderId: 'game::shadow-scene',
    sceneIndexProgramKey: 'game::shadow-scene',
  });
});

it('does not reinterpret a direct shadow program when its publication has no scene pair', () => {
  expect(
    gpuDrivenMaterialProgramSelection(
      {
        ...material,
        materialSceneIndexProgramKeys: { Forward: material.materialSceneIndexProgramKeys.Forward },
      },
      prepared,
      'shadow',
      { materialShaderId: 'game::shadow' },
      { logicalMaterialShaderId: '', sceneIndexProgramKey: undefined, materialShaderId: '' },
    ),
  ).toBeUndefined();
});

it('fills the supplied selection only after finding an accepted program pair', () => {
  const out = {
    logicalMaterialShaderId: '',
    materialShaderId: '',
    sceneIndexProgramKey: undefined as string | undefined,
  };
  expect(gpuDrivenMaterialProgramSelection(material, prepared, 'forward', undefined, out)).toBe(
    out,
  );
  expect(out.materialShaderId).toBe('game::surface-scene');
  expect(
    gpuDrivenMaterialProgramSelection(material, prepared, 'shadow', undefined, out),
  ).toBeUndefined();
  expect(out.materialShaderId).toBe('game::surface-scene');
  expect(
    gpuDrivenMaterialProgramSelection(
      material,
      prepared,
      'shadow',
      { materialShaderId: 'game::shadow' },
      out,
    ),
  ).toBe(out);
  expect(out.materialShaderId).toBe('game::shadow-scene');
});

it('retains an explicit scene pair even when its key equals the direct identity', () => {
  const same = {
    ...material,
    materialSceneIndexProgramKeys: {
      Forward: { pass: 'forward' as const, specializationKey: 'game::surface' },
    },
  };
  expect(
    gpuDrivenMaterialProgramSelection(same, prepared, 'forward', undefined, {
      logicalMaterialShaderId: '',
      sceneIndexProgramKey: undefined,
      materialShaderId: '',
    }),
  ).toMatchObject({
    sceneIndexProgramKey: 'game::surface',
    materialShaderId: 'game::surface',
  });
});

it.each([
  { simple: true, lean: true, fragment: 'fs_opaque', expectedSimple: true, expectedLean: true },
  { simple: true, lean: false, fragment: 'fs_opaque', expectedSimple: true, expectedLean: false },
  { simple: false, lean: true, fragment: 'fs_opaque', expectedSimple: false, expectedLean: true },
  {
    simple: true,
    lean: true,
    fragment: 'fs_depth_masked',
    expectedSimple: false,
    expectedLean: false,
  },
])('matches visible GPU receiver selection ($simple/$lean/$fragment)', async ({
  simple,
  lean,
  fragment,
  expectedSimple,
  expectedLean,
}) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const base = standardPbrInputs(device, shader, layout).materialArtifact;
  if (base === undefined) throw new Error('Missing fixture artifact');
  const artifact = {
    ...base,
    program: {
      ...base.program,
      entryPoints: ['fs_main', 'fs_depth_masked'].map((name) => ({
        name,
        stage: 'fragment' as const,
        bindings: [],
        effects: {
          mayDiscard: false,
          writesDepth: false,
          writesSampleMask: false,
          writesStorage: false,
        },
      })),
    },
    variantSet:
      'ALPHA_MASK=false+ATMOSPHERE_AVAILABLE=true+CLIPPING_PLANES=false+CLUSTER_FORWARD_AVAILABLE=true+COVERAGE_ONLY=false+DIRECTIONAL_SHADOW_SIMPLE=false+EXTENDED_LIGHTING_AVAILABLE=true+GPU_DRIVEN_SCENE_INDEX_AVAILABLE=true+LEAN_LIGHTING=false+LOD_DITHER=false+PROBE_BLEND_AVAILABLE=false+PROJECTOR_AVAILABLE=true+REFLECTION_FALLBACK_AVAILABLE=false+STANDARD_LEAN_INPUTS=true+STORAGE_BUFFER_AVAILABLE=true+TRANSMISSION_AVAILABLE=false+VERTEX_COLOR_AVAILABLE=false+VISIBLE_SURFACE_AVAILABLE=false+WATER_INFO_RGBA16=false+WATER_WAVES_AVAILABLE=false',
  };
  const source = { ...preparedPbrSnapshot(snapshot(1, 10)), authorVisible: false };
  const geometry = mesh(device);
  const entry = { source, mesh: geometry } as ValidatedRenderable;
  const factory = vi.fn<NonNullable<RenderSystemInternals['getMaterialShaderPipelineEntry']>>(
    () => ({ pipeline: {} }) as MaterialShaderPipelineEntry,
  );
  try {
    expect(
      prepareHiddenGpuDrivenPipelines({
        entries: [entry],
        resolve: () => artifact,
        shaders: undefined,
        artifacts: new Map([[artifact.material, artifact]]),
        factory,
        formats: fragment === 'fs_depth_masked' ? [] : ['rgba16float'],
        sampleCount: 4,
        shaderUvSetCount: 1,
        filter: 'opaque',
        fragmentEntry: fragment,
        coverageOnly: false,
        visibleSurface: false,
        directionalShadowSimple: simple,
        leanLighting: lean,
      }),
    ).toBe(true);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0]?.[5]).toContain(`DIRECTIONAL_SHADOW_SIMPLE=${expectedSimple}`);
    expect(factory.mock.calls[0]?.[5]).toContain(`LEAN_LIGHTING=${expectedLean}`);
  } finally {
    geometry.vertexBuffer.destroy().unwrap();
    geometry.indexBuffer?.destroy().unwrap();
  }
});
