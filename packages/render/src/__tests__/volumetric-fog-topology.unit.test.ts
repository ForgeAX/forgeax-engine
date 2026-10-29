import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deriveVolumetricFogResolvedExtent } from '../volume/resources';

const pipelineSource = readFileSync(
  fileURLToPath(new URL('../pipeline/standard-deferred-lane.ts', import.meta.url)),
  'utf8',
);
const forwardPipelineSource = readFileSync(
  fileURLToPath(new URL('../pipeline/standard-forward-lane.ts', import.meta.url)),
  'utf8',
);
const opaqueFogSource = readFileSync(
  fileURLToPath(new URL('../pipeline/analytic-fog-pass.ts', import.meta.url)),
  'utf8',
);
const shaderSource = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../shader/src/volume/${name}`, import.meta.url)),
    'utf8',
  );

describe('volumetric fog RenderGraph topology', () => {
  it('uses the official quarter-resolution high-quality resolve lane', () => {
    expect(deriveVolumetricFogResolvedExtent({ width: 1920, height: 1080 }, 4)).toEqual({
      width: 480,
      height: 270,
      depth: 1,
    });
    expect(deriveVolumetricFogResolvedExtent({ width: 1920, height: 1080 }, 16)).toEqual({
      width: 240,
      height: 135,
      depth: 1,
    });
  });

  it('keeps denoise soft while retaining depth-boundary rejection', () => {
    const composite = shaderSource('volume-composite.wgsl');
    expect(composite).toContain('abs(neighbor_depth - center_depth)');
    expect(composite).toContain('abs(neighbor.a - center.a) * 6.0');
  });

  it('integrates the ray independently of packed visibility depth', () => {
    const integrate = shaderSource('volume-integrate.wgsl');
    expect(integrate).toContain('for (var step = 0u; step < ray_step_count; step = step + 1u)');
    expect(integrate).toContain('let visibility_depth = max(owner_layers * 4u, 1u);');
  });

  it('keeps the Beer-Lambert extinction input physically non-negative', () => {
    const integrate = shaderSource('volume-integrate.wgsl');
    expect(integrate).toContain(
      'let optical_sample = volume_optical_sample(world_position, volume_params.simulation.x);',
    );
    expect(integrate).toContain('let density_value = optical_sample.a;');
    expect(integrate).toContain('let density_value = max(field.a, 0.0);');
    expect(integrate).toContain('return vec4<f32>(max(field.r, 0.0));');
    expect(integrate).toContain('return vec4<f32>(max(2.0 * grain - 1.0, 0.0));');
  });

  it('packs four logical visibility slices per rgba8 array texel', () => {
    const resources = readFileSync(
      fileURLToPath(new URL('../volume/resources.ts', import.meta.url)),
      'utf8',
    );
    expect(resources).toContain("VOLUME_FROXEL_FORMAT = 'rgba8unorm'");
    expect(
      readFileSync(fileURLToPath(new URL('../volume/programs.ts', import.meta.url)), 'utf8'),
    ).toContain('format: VOLUME_FROXEL_FORMAT');
    expect(shaderSource('volume-inject.wgsl')).toContain(
      'texture_storage_2d_array<rgba8unorm, write>',
    );
    expect(shaderSource('volume-inject.wgsl')).not.toContain('var density : texture_3d');
    expect(shaderSource('volume-integrate.wgsl')).toContain('texture_2d_array<f32>');
    expect(shaderSource('volume-integrate.wgsl')).toContain('texture_3d<f32>');
    expect(shaderSource('volume-integrate.wgsl')).toContain('slice_group');
  });

  it('uploads the camera depth convention consumed by volume CSM selection', () => {
    const viewUbo = readFileSync(
      fileURLToPath(new URL('../record/view-ubo.ts', import.meta.url)),
      'utf8',
    );
    expect(viewUbo).toContain('viewPayload[228] = camera.near');
    expect(viewUbo).toContain('viewPayload[229] = camera.far');
    expect(viewUbo).toContain("camera.projection === 'orthographic' ? 1 : 0");
  });

  it('composites analytic fog before translucency and the integrated volume after it', () => {
    // The resolved volume is one camera-to-opaque-depth integral per pixel, so
    // composited before translucency every blended surface behind the medium
    // would replace the medium's in-scatter and cut its silhouette out of it.
    const opaque = opaqueFogSource.slice(
      opaqueFogSource.indexOf('export function addOpaqueFogPasses('),
      opaqueFogSource.indexOf('export function addTranslucencyVolumetricFogPasses('),
    );
    expect(opaque).toContain('addAnalyticFogPass(');
    expect(opaque).not.toContain('addAuthoredVolumetricFogPasses(');
    expect(
      opaqueFogSource.slice(
        opaqueFogSource.indexOf('export function addTranslucencyVolumetricFogPasses('),
      ),
    ).toContain('addAuthoredVolumetricFogPasses(');
    for (const source of [pipelineSource, forwardPipelineSource]) {
      const fog = source.indexOf('addOpaqueFogPasses(graph');
      const volume = source.indexOf('addTranslucencyVolumetricFogPasses(graph');
      const lastTransparent = source.lastIndexOf('addStandardTransparentPasses(graph');
      expect(fog).toBeGreaterThan(0);
      expect(fog).toBeLessThan(source.indexOf('addStandardTransparentPasses(graph'));
      expect(volume).toBeGreaterThan(lastTransparent);
      expect(volume).toBeLessThan(source.indexOf('contributeStandardSceneFeatures('));
      expect(source).not.toContain('addAuthoredVolumetricFogPasses(');
    }
    expect(pipelineSource.indexOf('addOpaqueFogPasses(graph')).toBeLessThan(
      pipelineSource.indexOf('addTransmissionBackdropPasses({'),
    );
  });

  it('keeps mesh CSM visibility on the shared volume owner in both Standard lanes', () => {
    expect(opaqueFogSource).toContain('input.directionalShadow');
    for (const source of [pipelineSource, forwardPipelineSource]) {
      expect(source).toContain('addTranslucencyVolumetricFogPasses');
      expect(source).toMatch(/shadows(?:\.value)?\.directional\?\.view/);
    }
    expect(shaderSource('volume-inject.wgsl')).toContain('fn volume_cascade');
    expect(shaderSource('volume-inject.wgsl')).toContain('sample_shadow_2d_kernel');
  });

  it('encodes real volume work and non-constant optical semantics', () => {
    const passes = readFileSync(
      fileURLToPath(new URL('../volume/passes.ts', import.meta.url)),
      'utf8',
    );
    expect(passes).toContain('pass.dispatchWorkgroups(dispatchX, dispatchY, packedLayers)');
    expect(passes).toContain('pass.dispatchWorkgroups(resolvedDispatchX, resolvedDispatchY, 1)');
    expect(passes).toContain('resolvedExtent');
    expect(passes).toContain('pass.draw(3)');
    expect(shaderSource('volume-inject.wgsl')).not.toContain('scene_depth');
    expect(shaderSource('volume-inject.wgsl')).not.toContain('depth_weight');
    expect(shaderSource('volume-inject.wgsl')).not.toContain('scene_world');
    expect(shaderSource('volume-inject.wgsl')).toContain('fn volume_cascade');
    expect(shaderSource('volume-inject.wgsl')).toContain('fn ray_box_interval');
    expect(shaderSource('volume-inject.wgsl')).toContain('view.inverseViewProj');
    expect(shaderSource('volume-inject.wgsl')).not.toContain('textureSampleLevel(density');
    expect(shaderSource('volume-inject.wgsl')).not.toContain('stratified32');
    expect(shaderSource('volume-inject.wgsl')).not.toContain('dither_unorm8');
    expect(shaderSource('volume-integrate.wgsl')).toContain('exp(-extinction * sample_length)');
    expect(shaderSource('volume-integrate.wgsl')).toContain('textureSampleLevel(froxel');
    expect(shaderSource('volume-integrate.wgsl')).toContain('textureStore(resolved');
    expect(shaderSource('volume-temporal.wgsl')).toContain('var lower');
    expect(shaderSource('volume-temporal.wgsl')).toContain('fn bilinear');
    expect(shaderSource('volume-integrate.wgsl')).not.toContain('previous_ndc.z');
    expect(shaderSource('volume-composite.wgsl')).toContain('textureSampleLevel');
    expect(shaderSource('volume-composite.wgsl')).toContain('edge_aware_resolved_volume');
    expect(shaderSource('volume-composite.wgsl')).toContain('textureDimensions(resolved_volume)');
    expect(passes).toContain("{ resource: inputs.density, usage: 'sampled-read' }");
    expect(
      readFileSync(fileURLToPath(new URL('../volume/programs.ts', import.meta.url)), 'utf8'),
    ).toContain("viewDimension: '2d-array'");
    expect(shaderSource('volume-composite.wgsl')).toContain('linear_scene_depth');
    expect(shaderSource('volume-composite.wgsl')).toContain('depth_weight');
    expect(shaderSource('volume-temporal.wgsl')).toContain('temporalPreviousViewProj');
    expect(shaderSource('volume-temporal.wgsl')).toContain('fn reproject_uv');
    expect(shaderSource('volume-temporal.wgsl')).toContain(
      'temporalPreviousViewProj * vec4<f32>(world, 1.0)',
    );
    expect(shaderSource('volume-temporal.wgsl')).toContain('var lower');
    expect(shaderSource('volume-composite.wgsl')).not.toContain('/ 64.0');
  });

  it('uses fixed logical-slice centers for injection and integration', () => {
    const inject = shaderSource('volume-inject.wgsl');
    const integrate = shaderSource('volume-integrate.wgsl');
    expect(inject).toContain('(f32(logical_slice) + 0.5) / f32(logical_depth)');
    expect(inject).not.toContain('depth_phase');
    expect(integrate).not.toContain('fn stratified32');
    expect(integrate).toContain('segment_start + segment_length * 0.5');
  });

  it('keeps temporal history graph-owned and slot-selectable', () => {
    const passes = readFileSync(
      fileURLToPath(new URL('../volume/passes.ts', import.meta.url)),
      'utf8',
    );
    const frameSource = readFileSync(
      fileURLToPath(new URL('../record/frame.ts', import.meta.url)),
      'utf8',
    );
    expect(passes).toContain('historyReadSlot');
    expect(passes).toContain('historyWriteSlot');
    expect(passes).toContain("usage: 'sampled-storage-read-write'");
    expect(passes).not.toContain('temporalInit');
    expect(passes).not.toContain('volume_temporal_init');
    expect(passes).not.toContain('textureStore(volume_history');
    expect(frameSource).toContain('volumetricFogHistoryGraph');
    expect(frameSource).toContain('volumetricFogHistorySlot');
    expect(frameSource).toContain('volumetricFogHistorySignature');
    expect(frameSource).toContain('promoteVolumetricFogHistory(');
    expect(
      readFileSync(fileURLToPath(new URL('../record/volume-params.ts', import.meta.url)), 'utf8'),
    ).toContain('params[32] = fog.worldTimeSeconds ?? 0');
    expect(
      readFileSync(fileURLToPath(new URL('../volume/temporal.ts', import.meta.url)), 'utf8'),
    ).toContain("reason: 'simulation-time'");
  });

  it('advances temporal history only after the accepted queue submit', () => {
    const recordSource = readFileSync(
      fileURLToPath(new URL('../record/frame.ts', import.meta.url)),
      'utf8',
    );
    const submitSource = readFileSync(
      fileURLToPath(new URL('../record/typed-frame-graph.ts', import.meta.url)),
      'utf8',
    );
    expect(recordSource).toContain('temporalFrameTransaction.stage');
    expect(recordSource).toContain('promoteVolumetricFogParams(frameState.volumetricFogParams)');
    expect(recordSource).toContain('hasVolumetricFogCapability');
    expect(submitSource).toContain('yield* recordFrameTransaction(steps,');
    expect(submitSource).not.toContain('queue.submit(');
    expect(submitSource).toContain('commitStagedTemporalGpuState(frameState');
  });

  it('requires the manifest-owned shader bundle in addition to compute/storage caps', async () => {
    const { hasVolumetricFogCapability } = await import('../volume/capability');
    expect(hasVolumetricFogCapability({ compute: true, storageTexture: true }, {})).toBe(true);
    expect(hasVolumetricFogCapability({ compute: true, storageTexture: true }, undefined)).toBe(
      false,
    );
    expect(hasVolumetricFogCapability({ compute: false, storageTexture: true }, {})).toBe(false);
    expect(hasVolumetricFogCapability({ compute: true, storageTexture: false }, {})).toBe(false);
  });

  it('clears device-bound volume parameter slots during recovery without destroying old handles', () => {
    const renderSystemSource = readFileSync(
      fileURLToPath(new URL('../render-system.ts', import.meta.url)),
      'utf8',
    );
    const recoverStart = renderSystemSource.indexOf(
      'resetForRecover(retiringPipelineState?: PipelineState, replacementDevice?: RhiDevice): void {',
    );
    expect(recoverStart).toBeGreaterThanOrEqual(0);
    const recoverEnd = renderSystemSource.indexOf(
      'restorePostProcessResources(): void',
      recoverStart,
    );
    expect(recoverEnd).toBeGreaterThan(recoverStart);
    const recoverSource = renderSystemSource.slice(recoverStart, recoverEnd);
    expect(recoverSource).toContain('frameState.volumetricFogParams = emptyVolumetricFogParams()');
    expect(recoverSource).not.toContain('destroyBuffer(buffer)');
  });
});
