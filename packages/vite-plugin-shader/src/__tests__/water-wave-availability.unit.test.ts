import { projectShaderConditionals } from '@forgeax/engine-shader-compiler';
import { expect, it } from 'vitest';
import { compileMaterialSources } from '../engine-inputs/compile-material-sources.js';
import { loadEngineShaderEntries } from '../engine-inputs/load-engine-shader-entries.js';

const BASE_DEFINES = {
  ATMOSPHERE_AVAILABLE: false,
  CLUSTER_FORWARD_AVAILABLE: false,
  COVERAGE_ONLY: false,
  DIRECTIONAL_PCSS_AVAILABLE: false,
  EXTENDED_LIGHTING_AVAILABLE: false,
  GPU_DRIVEN_SCENE_INDEX_AVAILABLE: false,
  PER_INSTANCE_REGION: false,
  PROBE_BLEND_AVAILABLE: false,
  PROJECTOR_AVAILABLE: false,
  REFLECTION_FALLBACK_AVAILABLE: false,
  STORAGE_BUFFER_AVAILABLE: true,
  TERRAIN_GEOMETRY_AVAILABLE: false,
  TRANSMISSION_AVAILABLE: false,
  VERTEX_COLOR_AVAILABLE: false,
  VISIBLE_SURFACE_AVAILABLE: false,
  WATER_INFO_RGBA16: false,
} as const;

it.each(
  [false, true].flatMap((waterWavesAvailable) =>
    [false, true].flatMap((sceneIndex) =>
      [false, true].map((vertexColor) => ({ waterWavesAvailable, sceneIndex, vertexColor })),
    ),
  ),
)('compiles Standard PBR with Water=$waterWavesAvailable, scene-index=$sceneIndex, vertex-color=$vertexColor', async ({
  waterWavesAvailable,
  sceneIndex,
  vertexColor,
}) => {
  const engine = await loadEngineShaderEntries();
  const defines = {
    ...BASE_DEFINES,
    GPU_DRIVEN_SCENE_INDEX_AVAILABLE: sceneIndex,
    VERTEX_COLOR_AVAILABLE: vertexColor,
    WATER_WAVES_AVAILABLE: waterWavesAvailable,
  };
  const file = {
    ...engine.defaultStandardPbr,
    source: projectShaderConditionals(engine.defaultStandardPbr.source, defines),
  };
  const [result] = await compileMaterialSources(
    [
      {
        defines,
        file,
        options: {
          id: `standard-pbr-water-waves-${waterWavesAvailable}-scene-${sceneIndex}-color-${vertexColor}`,
          imports: engine.imports,
          defines,
        },
      },
    ],
    engine.imports,
  );

  expect(result?.ok, result?.ok === false ? result.error.message : undefined).toBe(true);
  if (result?.ok !== true) return;

  expect(result.value.wgsl).toContain('fn vs_temporal');
  if (waterWavesAvailable) {
    // This default Standard root carries WaterMesh inputs; WPO requires a
    // separately authored deformation slot, covered by the full-catalog cooker.
    expect(result.value.wgsl).toContain('waterMeshTileVertex');
    expect(result.value.wgsl).toContain('waterMeshCoverageContains');
    expect(result.value.wgsl).toContain('waterMeshWireColor');
    expect(result.value.wgsl).toContain('waterCoverageAndGridXZ');
    expect(result.value.wgsl).toContain('waterMaterialDrawData');
  } else {
    expect(result.value.wgsl).not.toContain('waterMeshTileVertex');
    expect(result.value.wgsl).not.toContain('waterMaterialDrawData');
    expect(result.value.wgsl).not.toContain('waterCoverageAndGridXZ');
  }
});
