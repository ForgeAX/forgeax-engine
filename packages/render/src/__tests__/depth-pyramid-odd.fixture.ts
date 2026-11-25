import { readFileSync } from 'node:fs';

export function readShader(name: string): string {
  return readFileSync(new URL(`../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
}

export function depthPyramidProbeImports(): Record<string, string> {
  return {
    'forgeax_view::common': readShader('common'),
    'forgeax_depth_pyramid::sample': readShader('depth-pyramid-sample'),
  };
}

export type Probe = {
  readonly uv: readonly [number, number];
  /** Coarsest trace level whose cell must still hold the probed pixel's depth. */
  readonly coarseLevel: number;
};

// Level zero reads scene depth. Higher levels use the same viewport-to-cell
// mapping as the HZB consumers, including the overlap of unpadded odd mips.
export function createTraceProbeCode(probes: readonly Probe[]): string {
  const calls = probes
    .map(
      (probe, index) => `
  levelProbe[${index}] = vec4<f32>(
    sampleDepthLevel(vec2<f32>(${probe.uv[0]}, ${probe.uv[1]}), 0u),
    sampleDepthLevel(vec2<f32>(${probe.uv[0]}, ${probe.uv[1]}), 1u),
    sampleDepthLevel(vec2<f32>(${probe.uv[0]}, ${probe.uv[1]}), 2u),
    sampleDepthLevel(vec2<f32>(${probe.uv[0]}, ${probe.uv[1]}), 3u));`,
    )
    .join('');
  return `
#define_import_path forgeax_depth_pyramid::odd_probe
#import forgeax_view::common::{View}
#import forgeax_depth_pyramid::sample::{depthPyramidViewportCell, linearizeViewDepth}
@group(0) @binding(0) var sceneDepth: texture_depth_2d;
@group(0) @binding(3) var depthPyramid: texture_2d<f32>;
@group(0) @binding(5) var<uniform> view: View;
@group(1) @binding(0) var<storage, read_write> levelProbe: array<vec4<f32>>;
fn sampleDepthLevel(uv: vec2f, traceLevel: u32) -> f32 {
  let size = textureDimensions(sceneDepth);
  if (traceLevel == 0u) {
    let pixel = min(vec2u(uv * vec2f(size)), size - 1u);
    return linearizeViewDepth(textureLoad(sceneDepth, vec2i(pixel), 0), view.temporalProjection);
  }
  let level = min(traceLevel, textureNumLevels(depthPyramid)) - 1u;
  let cell = depthPyramidViewportCell(uv, depthPyramid, level, size);
  return textureLoad(depthPyramid, vec2i(cell), level).r;
}
@compute @workgroup_size(1) fn probe_levels() {${calls}
}`;
}
