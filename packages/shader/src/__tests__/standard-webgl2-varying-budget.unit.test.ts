import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectShaderConditionals } from '../../../shader-compiler/src/conditionals.js';

const shaderFiles = ['default-standard-pbr.wgsl', 'default-standard-pbr-skin.wgsl'] as const;

describe('Standard WebGL2 inter-stage varying budget', () => {
  it.each(
    shaderFiles,
  )('%s carries Surface position only and reads view depth from position', (file) => {
    const source = readFileSync(resolve(import.meta.dirname, '..', file), 'utf8');

    expect(source).toContain('@location(7) positionOS : vec3<f32>');
    expect(source).not.toMatch(/@location\(15\)\s+positionOS\s*:/u);
    expect(source).toContain('out.positionOS = localPosition;');
    expect(source).toContain('let positionOS = in.positionOS;');
    expect(source).toContain('sceneFragmentViewZ(in.clip, view.temporalProjection)');
  });

  // Keep all UV, tangent, object-position and basis inputs in this worst case.
  // front_facing consumes one of WebGPU's 16 inter-stage variables.
  it.each(
    shaderFiles,
  )('%s keeps ordinary and Water variants within WebGPU inter-stage limits', (file) => {
    const source = readFileSync(resolve(import.meta.dirname, '..', file), 'utf8');
    const vsOut = /struct VsOut \{([\s\S]*?)\n\};/u.exec(source)?.[1] ?? '';

    for (const water of [false, true]) {
      for (const sceneIndex of [false, true]) {
        for (const vertexColor of [false, true]) {
          for (const lodDither of [false, true]) {
            const defines = {
              WATER_WAVES_AVAILABLE: water,
              GPU_DRIVEN_SCENE_INDEX_AVAILABLE: sceneIndex,
              VERTEX_COLOR_AVAILABLE: vertexColor,
              LOD_DITHER: lodDither,
            };
            const projected = projectShaderConditionals(vsOut, defines, 'all');
            const locations = [...projected.matchAll(/@location\((\d+)\)/gu)].map(
              (match) => match[1],
            );
            const label = JSON.stringify(defines);

            expect(locations.length, label).toBeGreaterThan(0);
            expect(new Set(locations).size, label).toBe(locations.length);
            expect(locations.length + 1, label).toBeLessThanOrEqual(16);
          }
        }
      }
    }
  });

  it('keeps the coverage/grid lane and its consumers exclusive to Water', () => {
    const source = readFileSync(resolve(import.meta.dirname, '..', shaderFiles[0]), 'utf8');
    const ordinary = projectShaderConditionals(source, { WATER_WAVES_AVAILABLE: false }, 'all');
    const water = projectShaderConditionals(source, { WATER_WAVES_AVAILABLE: true }, 'all');

    expect(ordinary).not.toContain('waterCoverageAndGridXZ');
    expect(ordinary).not.toMatch(/@location\(\d+\)\s+(ndc|worldPos)\s*:/u);
    expect(ordinary).toContain('standardFragmentNdc(in)');
    expect(ordinary).toContain('view.inverseViewProj * vec4<f32>(standardFragmentNdc(in), 1.0)');
    expect(water).not.toMatch(/@location\(6\)\s+ndc\s*:/u);
    expect(water).toContain('view.inverseViewProj * vec4<f32>(standardFragmentNdc(in), 1.0)');
    expect(water).toContain('vec3<f32>(in.objectBasis1.zw, in.objectBasis2)');
    expect(water).toContain('@location(1) worldNormal : vec4<f32>');
    expect(water).toContain('in.worldNormal.w <= 0.0');
    expect(water).toContain('@location(11) waterCoverageAndGridXZ : vec4<f32>');
    expect(water).toContain(
      'out.waterCoverageAndGridXZ = vec4<f32>(waterCoverageXZ, waterMeshVertex.gridXZ)',
    );
    expect(water).toContain(
      'waterMeshCoverageContains(in.surfaceData.w, in.waterCoverageAndGridXZ.xy)',
    );
    expect(water).toContain('waterMeshWireColor(in.surfaceData.w, in.waterCoverageAndGridXZ.zw)');
  });
});
