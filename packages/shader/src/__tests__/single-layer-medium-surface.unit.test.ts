import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function source(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
}

describe('single-layer medium shader model', () => {
  it('publishes a separate Surface ABI and one Engine-owned template slot', () => {
    const template = source('single-layer-medium.wgsl');
    const abi = source('single-layer-medium-surface_v1.wgsl');
    expect(template).toContain('#define_import_path forgeax::single-layer-medium');
    expect(template).toContain('#pragma material_slot surface');
    expect(template).toContain('fn vs_scene_index');
    expect(template).toContain('view.worldViewProj');
    expect(template).toContain('fn mediumSurfaceToCameraDirection(');
    expect(template).toContain('view.inverseViewProj');
    expect(template).toContain('view.temporalProjection.z >= 0.5');
    expect(template).toContain('view.lightDir');
    expect(template).toContain('surfaceInput.frameTime = frame.frameTime');
    expect(template).toContain('surfaceInput.eventRangeStart = frame.eventRangeStart');
    expect(template).toContain('surfaceInput.instanceIndex = frame.instanceIndex');
    expect(template).toContain('@group(3) @binding(6) var<uniform> surfaceDirectAddress');
    expect(template).toContain('return surfaceDirectAddress.frameBase + instanceIndex;');
    expect(template).toContain(
      'return surfaceVertex(vertex, meshes[0u].worldFromLocal, instances[instanceIndex].localFromInstance, view.worldViewProj, view.cameraPos, view.inverseViewProj, view.temporalProjection.z >= 0.5, surfaceInstanceIndex, 0u, vec2<u32>(0u));',
    );
    expect(template).toContain(
      'return surfaceVertex(vertex, draw.world, SCENE_INDEX_LOCAL_IDENTITY, view.worldViewProj, view.cameraPos, view.inverseViewProj, view.temporalProjection.z >= 0.5, visibleItem.z, visibleItem.y, draw.probe);',
    );
    expect(template).toContain(
      'return select(cameraPos - worldPosition, nearWorld - farWorld, orthographic);',
    );
    expect(template).not.toContain('surfaceInstanceIndex, visibleItem.y');
    expect(template).not.toContain('sceneMaterials[input.materialIndex].payload[0].w');
    expect(template).not.toContain('materialAlpha');
    expect(template).toContain('surfaceFrameInputs[index].words');
    expect(template).toContain('let result = foamColor * (1.0 - fresnel) + reflection * fresnel;');
    expect(template).toContain('surface.roughness');
    expect(template).toContain('surface.phaseG');
    expect(template).toContain('textureLoad(surfaceRawDepthTexture');
    expect(template).toContain('surface.maxDistanceMeters');
    expect(template).toContain('fn surfacePixelOffset');
    expect(template).toContain('fn surfacePixelInBounds');
    expect(template).toContain('if (inBounds) {');
    expect(template).toContain('let originalOffset = all(abs(offset) < vec2<f32>(0.000001));');
    expect(template).toContain('(footprintValid || (originalOffset && centerValid))');
    expect(template).toContain('if (footprintValid && !originalOffset)');
    expect(template).toContain('textureLoad(surfaceBackdropTexture, centerPixel, 0).rgb');
    expect(template).toContain('SURFACE_BACKGROUND_REASON_FOREGROUND');
    expect(template).toContain('fn fs_nearest_layer');
    expect(template).toContain('fn fs_color');
    expect(template).toContain('textureLoad(surfaceNearestDepthTexture');
    expect(template).toContain(
      '@group(1) @binding(14) var surfaceNearestDepthTexture: texture_2d<f32>',
    );
    expect(template).not.toContain('surfaceNearestDepthTexture: texture_depth_2d');
    expect(template).toContain('length(acceptedEndpoint - input.positionWS)');
    expect(template).toContain('validateSurfaceBackgroundEndpoint');
    expect(template).toContain('let geometricPlaneNormal = normalize(input.geometricNormalWS);');
    expect(template).toContain('orientedPlaneNormal,');
    expect(template).not.toContain('input.positionWS,\n    orientedNormal,');
    expect(template).toContain('dot(endpoint - surfacePosition, surfaceNormal)');
    expect(template).toContain('mediumOneMinusExpNeg');
    expect(template).toContain('if (extinction <= 0.0)');
    expect(template).toContain('sampleIblDiffuse');
    expect(template).toContain('evaluateProbeDiffuse');
    expect(template).toContain('u32(probeHeader.x) + 1u == probeIdentity.x');
    expect(template).toContain('u32(probeHeader.y) == probeIdentity.y');
    expect(template).toContain('let probeBase = probeIdentity.x * 16u');
    expect(template).toContain('evalDirectionalShadowFactor');
    expect(template).toContain('@group(2) @binding(7) var ssaoBlurredTexture');
    expect(template).toContain('get_ssao_intensity()');
    expect(template).toContain('acceptedBackground = centerBackground');
    expect(template).not.toContain('input.clipPosition.z / max(abs(input.clipPosition.w)');
    expect(template).not.toContain('sceneMaterialFactor * 0.0');
    expect(abi).toContain('struct SingleLayerMediumSurfaceInput');
    expect(abi).toContain('struct SingleLayerMediumSurfaceData');
    expect(abi).toContain('frameTime : f32');
    expect(abi).toContain('eventRangeCount : u32');
    expect(abi).not.toMatch(/@(?:vertex|fragment|compute)\b/);
    expect(abi).not.toMatch(/@group\s*\(/);
    expect(abi).not.toContain('customDataStart');
  });

  it('fails closed when graph-paired raw depth is unavailable', () => {
    const template = source('single-layer-medium.wgsl');
    expect(template).toContain('if (surface.coverage <= 0.0 || frame.backgroundAvailable == 0u)');
    expect(template).toContain(
      'return vec4<f32>(0.0, 0.0, 0.0, clamp(surface.coverage, 0.0, 1.0));',
    );
    expect(template).toContain('let skyMissDistance = surfaceSkyMissDistance(surface);');
    expect(template).toContain(
      'let acceptedEndpoint = reconstructBackgroundWorld(acceptedBackground.uv, acceptedBackground.depth);',
    );
    expect(template).toContain('if (frame.backgroundAvailable != 0u && acceptedBackground.valid)');
  });

  it('keeps Standard SurfaceData and module identity unchanged', () => {
    const standard = source('surface_v1.wgsl');
    expect(standard).toContain('struct SurfaceData');
    expect(standard).toContain('alphaClipThreshold');
    expect(standard).not.toContain('SingleLayerMediumSurfaceData');
  });
});
