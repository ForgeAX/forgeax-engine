import { readFileSync } from 'node:fs';
import { mat4 } from '@forgeax/engine-math';
import { compileShader } from '../../../../shader-compiler/src/compile';
import {
  screenContactCoverageCases,
  screenContactCoverageCode,
} from './screen-probe-contact-coverage.fixture';
import { endpointFunction } from './sdf-surface-endpoint-aggregation.fixture';

const identity = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
// Native CCW perspective: camera (0,0,3), near1/far3, unit focal scales.
// Every matrix coefficient is dyadic; the selected triangle is at world z=.5.
const perspective = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1.5, -1, 0, 0, 3, 3);
const positions = Float32Array.of(-2, -2, 0.5, 2, -2, 0.5, 0, 2, 0.5);

export async function rasterReceiverPrograms() {
  const standard = readFileSync(
    new URL('../../../../shader/src/default-standard-pbr.wgsl', import.meta.url),
    'utf8',
  );
  const alpha = endpointFunction(standard, 'alphaTestSurface');
  const rejected = endpointFunction(standard, 'standardSurfaceRejected');
  const raster = `
struct SurfaceData { opacity:f32, alphaClipThreshold:f32 }
${rejected}
${alpha}
@group(0) @binding(0) var<uniform> matrix:mat4x4f;
@group(0) @binding(1) var<uniform> surface:vec4f;
@vertex fn receiverVertex(@location(0) position:vec3f)->@builtin(position)vec4f{return matrix*vec4f(position,1);}
@fragment fn receiverFragment(@builtin(front_facing) front:bool)->@location(0)vec4u{
 alphaTestSurface(SurfaceData(surface.x,surface.y));
 return vec4u(1u,0u,0u,1u|select(0u,2u,front));
}`;
  const rasterCompiled = (
    await compileShader(raster, {
      id: 'raster-alpha-receiver-raster',
      defines: {
        ALPHA_MASK: true,
        STANDARD_STOCK_SURFACE_AVAILABLE: true,
        ALPHA_CLIPPING_AVAILABLE: true,
      },
    })
  ).unwrap();
  const compute = (
    await compileShader(screenContactCoverageCode().code, { id: 'raster-alpha-receiver-compute' })
  ).unwrap();
  return { raster: rasterCompiled, compute };
}

export async function rasterReceiverCases() {
  const transforms = {
    identity,
    mirror: Float32Array.of(-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1),
    nonuniform: Float32Array.of(2, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1),
    back: Float32Array.of(-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 1, 1),
  };
  const inputs = await Promise.all(
    Object.entries(transforms).map(async ([name, transform]) => {
      const rows = await screenContactCoverageCases({
        receiverProof: 'raster-alpha-local',
        reconstruction: 'current-support',
        transform,
        twoSided: true,
      });
      const row = rows.find((r) => r.name === 'unknown-selected');
      if (!row) throw Error('Actual partial UNKNOWN receiver packet required');
      return [name, { row, transform }] as const;
    }),
  );
  const byName = Object.fromEntries(inputs);
  const make = (
    name: string,
    transform: keyof typeof transforms,
    opacity: number,
    direction: readonly [number, number, number],
    token: number,
    status: 1 | 4,
    view = perspective,
  ) => {
    const selected = byName[transform];
    if (!selected) throw Error('Complete authored transform fixture required');
    return {
      name,
      row: selected.row,
      opacity,
      direction,
      token,
      status,
      positions,
      viewProjection: view,
      rasterMatrix: mat4.multiply(mat4.create(), view, selected.transform),
    };
  };
  const cases = [
    make('local-alpha-front-outward', 'identity', 1, [0, 0, 1], 3, 1),
    make('alpha-hole', 'identity', 0, [0, 0, 1], 0, 4),
    make('alpha-equal-cutoff', 'identity', 0.5, [0, 0, 1], 0, 4),
    make('opposite-side', 'identity', 1, [0, 0, -1], 3, 4),
    make('tangent', 'identity', 1, [1, 0, 0], 3, 4),
    make('mirror-outward', 'mirror', 1, [0, 0, 1], 3, 1),
    make('nonuniform-outward', 'nonuniform', 1, [0, 0, 1], 3, 1),
    make('double-sided-back-outward', 'back', 1, [0, 0, 1], 2, 1),
    make('double-sided-back-inward', 'back', 1, [0, 0, -1], 2, 4),
  ];
  const mirroredProjection = perspective.slice();
  mirroredProjection[0] = -1;
  cases.push(
    make('unsupported-mirrored-projection', 'identity', 1, [0, 0, 1], 0, 4, mirroredProjection),
  );
  cases.push(make('unsupported-orthographic', 'identity', 1, [0, 0, 1], 0, 4, identity));
  for (const old of ['strict-reference', 'old-source-version'] as const) {
    const control = make(old, 'identity', 1, [0, 0, 1], 0, 4);
    control.row = {
      ...control.row,
      frame: control.row.frame.slice(),
      source: { ...control.row.source, words: control.row.source.words.slice() },
    };
    if (old === 'strict-reference') new Uint32Array(control.row.frame.buffer)[10] = 0;
    else control.row.source.words[1] = 1;
    cases.push(control);
  }
  return cases;
}

export async function rasterReceiverPipelines(
  device: GPUDevice,
  programs: Awaited<ReturnType<typeof rasterReceiverPrograms>>,
) {
  const module = device.createShaderModule({ code: programs.compute.wgsl });
  return {
    prepare: await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'prepareScreenReceivers' },
    }),
    world: await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'traceWorldProbes' },
    }),
    raster: await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: {
        module: device.createShaderModule({ code: programs.raster.wgsl }),
        entryPoint: 'receiverVertex',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
        ],
      },
      fragment: {
        module: device.createShaderModule({ code: programs.raster.wgsl }),
        entryPoint: 'receiverFragment',
        targets: [{ format: 'rgba32uint' }],
      },
      primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
    }),
  };
}
