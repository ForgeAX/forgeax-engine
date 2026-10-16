import type { RhiComputePassEncoder, RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { GlobalSdfQueryInputs } from './global-sdf-query';
import { PROBE_PLACEMENT_DIAGNOSTIC_STRIDE, PROBE_PLACEMENT_STRIDE } from './probe-placement';
import { RAY_INPUT_STRIDE, RAY_REFERENCE_LIMIT } from './scene';

/** Emission facts only. Masked lanes are not traced misses or lighting validity. */
export const ProbeRayStatus = {
  emitted: 0,
  untraced: 1,
  invalidProbe: 2,
  invalidRange: 3,
} as const;

export interface ProbeRayInputs {
  /** Existing 32-byte PlacementProbe and matching, current-attempt PlacementState. */
  readonly probes: GlobalSdfQueryInputs['rays'];
  readonly candidate: GlobalSdfQueryInputs['rays'];
  /** f32 tMax followed by three zero f32 words; TMin is always zero. */
  readonly settings: GlobalSdfQueryInputs['settings'];
  /** Existing 48-byte Global query rays; mask.yzw remain zero. */
  readonly rays: GlobalSdfQueryInputs['rays'];
  /** 16 bytes/probe: u32 id/generation/ProbeRayStatus/emittedCount. */
  readonly diagnostics: GlobalSdfQueryInputs['hits'];
}

export const PROBE_RAYS_WGSL = `
struct Probe { baseCell: vec4f, key: vec4u }
struct Candidate { offset: vec4f, key: vec4u }
struct Ray { origin: vec3f, tMin: f32, direction: vec3f, tMax: f32, mask: vec4u }
@group(0) @binding(0) var<storage,read> probes: array<Probe>;
@group(0) @binding(1) var<storage,read> candidate: array<Candidate>;
@group(0) @binding(2) var<uniform> settings: vec4f;
@group(0) @binding(3) var<storage,read_write> rays: array<Ray>;
@group(0) @binding(4) var<storage,read_write> diagnostics: array<vec4u>;

// Clarberg 2008 square-to-sphere mapping; UE's MonteCarlo.ush uses this
// equal-area parameterization for Lumen probe texel centers, without jitter.
fn probeRayDirection(uv: vec2f) -> vec3f {
  let p = 2.0 * uv - 1.0;
  let d = 1.0 - abs(p.x) - abs(p.y);
  let r = 1.0 - abs(d);
  var phi = 0.0;
  if (r != 0.0) { phi = 0.7853981633974483 * ((abs(p.y) - abs(p.x)) / r + 1.0); }
  let f = r * sqrt(2.0 - r * r);
  return vec3f(f * sign(p.x) * abs(cos(phi)), f * sign(p.y) * abs(sin(phi)), sign(d) * (1.0 - r * r));
}

fn probeRayInputStatus(probe: Probe, state: Candidate) -> u32 {
  let cell = probe.baseCell.w;
  if (any(probe.key.xy == vec2u(0u)) || any(probe.key.xy != state.key.xy) ||
      probe.key.z > 1u || probe.key.w != 0u || any(state.key.zw != vec2u(0u)) ||
      !all(abs(probe.baseCell.xyz) < vec3f(1e30)) || !(cell > 1e-20 && cell < 1e20) ||
      !all(abs(state.offset.xyz) <= vec3f(cell * 0.25)) || state.offset.w != 0.0) {
    return ${ProbeRayStatus.invalidProbe}u;
  }
  let origin = probe.baseCell.xyz + state.offset.xyz;
  // A conservative finite endpoint bound for every unit direction. This is
  // numerical admission, never a field-coverage or solid-exterior classifier.
  if (!(settings.x >= 1.1754943508222875e-38 && settings.x < 1e30) ||
      any(settings.yzw != vec3f(0.0)) || !all(abs(origin) + vec3f(settings.x) < vec3f(1e30))) {
    return ${ProbeRayStatus.invalidRange}u;
  }
  return select(${ProbeRayStatus.untraced}u, ${ProbeRayStatus.emitted}u, probe.key.z == 1u);
}

@compute @workgroup_size(64) fn emitProbeRays(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&rays)) { return; }
  // Exact CPU-admitted ranges are the count authority; there is no second
  // caller-writable count hidden in the settings buffer.
  let perProbe = arrayLength(&rays) / arrayLength(&probes);
  // sqrt may approximate an exact integer root from below; round before cast.
  let resolution = u32(round(sqrt(f32(perProbe))));
  let probeIndex = id.x / perProbe;
  let texel = id.x % perProbe;
  let probe = probes[probeIndex];
  let state = candidate[probeIndex];
  let status = probeRayInputStatus(probe, state);
  var ray = Ray(vec3f(0), 0, vec3f(0,0,1), 1, vec4u(0));
  if (status == ${ProbeRayStatus.emitted}u) {
    let uv = (vec2f(f32(texel % resolution), f32(texel / resolution)) + 0.5) / f32(resolution);
    ray = Ray(probe.baseCell.xyz + state.offset.xyz, 0, probeRayDirection(uv), settings.x, vec4u(255,0,0,0));
  }
  rays[id.x] = ray;
  if (texel == 0u) {
    diagnostics[probeIndex] = vec4u(probe.key.xy, status, select(0u, perProbe, status == ${ProbeRayStatus.emitted}u));
  }
}
`;

/** Borrowed-pass recorder. Owns no buffers, queue work or accepted placement.
 * Resolution is 1..256, and probeCount * resolution^2 must fit 65,536 rays.
 * Each probe owns a fixed row-major texel interval: identity is its diagnostic
 * id/generation plus the texel ordinal. No compaction or pretrace field mask.
 * Invalid/untraced inputs overwrite their entire interval with safe mask-zero
 * rays; consumers must inspect emission diagnostics before interpreting hits. */
export function createProbeRayRecorder(device: RhiDevice, module: ShaderModule) {
  const failure = (expected: string, code: RhiError['code'] = 'rhi-descriptor-invalid') =>
    err(
      new RhiError({
        code,
        expected,
        hint: 'Supply exact borrowed probe/candidate ranges, a bounded square direction budget and separate outputs.',
      }),
    );
  if (!device.caps.compute || !device.caps.storageBuffer)
    return failure('compute and storage-buffer support for probe rays', 'rhi-not-available');
  for (const [name, required] of [
    ['maxBindGroups', 1],
    ['maxBindingsPerBindGroup', 5],
    ['maxStorageBuffersPerShaderStage', 4],
    ['maxUniformBuffersPerShaderStage', 1],
    ['maxUniformBufferBindingSize', 16],
    ['maxComputeWorkgroupSizeX', 64],
    ['maxComputeInvocationsPerWorkgroup', 64],
  ] as const)
    if (!(device.limits[name] >= required))
      return failure(`probe rays require ${name} >= ${required}`, 'limit-exceeded');
  const layout = device.createBindGroupLayout({
    entries: [
      PROBE_PLACEMENT_STRIDE,
      PROBE_PLACEMENT_STRIDE,
      16,
      RAY_INPUT_STRIDE,
      PROBE_PLACEMENT_DIAGNOSTIC_STRIDE,
    ].map((minBindingSize, binding) => ({
      binding,
      visibility: 4,
      buffer: {
        type:
          binding === 2
            ? ('uniform' as const)
            : binding >= 3
              ? ('storage' as const)
              : ('read-only-storage' as const),
        minBindingSize,
      },
    })),
  });
  if (!layout.ok) return layout;
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout.value] });
  if (!pipelineLayout.ok) return pipelineLayout;
  const pipeline = device.createComputePipeline({
    label: 'probe-rays.emit',
    layout: pipelineLayout.value,
    compute: { module, entryPoint: 'emitProbeRays' },
  });
  if (!pipeline.ok) return pipeline;
  return ok({
    record(
      pass: RhiComputePassEncoder,
      input: ProbeRayInputs,
      probeCount: number,
      resolution: number,
    ): Result<void, RhiError> {
      const rayCount = probeCount * resolution * resolution;
      if (
        !Number.isSafeInteger(probeCount) ||
        probeCount < 1 ||
        !Number.isSafeInteger(resolution) ||
        resolution < 1 ||
        resolution > 256 ||
        !Number.isSafeInteger(rayCount) ||
        rayCount > RAY_REFERENCE_LIMIT ||
        !(Math.ceil(rayCount / 64) <= device.limits.maxComputeWorkgroupsPerDimension)
      )
        return failure(
          '1..256 square direction resolution and 1..65536 total rays within dispatch limits',
          'limit-exceeded',
        );
      if (
        input.probes.size !== probeCount * PROBE_PLACEMENT_STRIDE ||
        input.candidate.size !== input.probes.size ||
        input.settings.size !== 16 ||
        input.rays.size !== rayCount * RAY_INPUT_STRIDE ||
        input.diagnostics.size !== probeCount * PROBE_PLACEMENT_DIAGNOSTIC_STRIDE
      )
        return failure('exact probe/candidate/settings/ray/diagnostic binding sizes');
      for (const name of ['probes', 'candidate', 'settings', 'rays', 'diagnostics'] as const) {
        const range = input[name],
          offset = range.offset ?? 0,
          uniform = name === 'settings';
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset %
            (uniform
              ? device.limits.minUniformBufferOffsetAlignment
              : device.limits.minStorageBufferOffsetAlignment) !==
            0
        )
          return failure(`device-aligned nonnegative ${name} offset`);
        if (
          !Number.isSafeInteger(offset + range.size) ||
          !(offset + range.size <= device.limits.maxBufferSize) ||
          !(
            range.size <=
            (uniform
              ? device.limits.maxUniformBufferBindingSize
              : device.limits.maxStorageBufferBindingSize)
          )
        )
          return failure(`${name} range within device buffer limits`, 'limit-exceeded');
      }
      if (
        input.rays.buffer === input.diagnostics.buffer ||
        [input.probes, input.candidate, input.settings].some(
          (range) =>
            range.buffer === input.rays.buffer || range.buffer === input.diagnostics.buffer,
        )
      )
        return failure('probe ray outputs must not alias each other or borrowed inputs');
      const group = device.createBindGroup({
        layout: layout.value,
        entries: [input.probes, input.candidate, input.settings, input.rays, input.diagnostics].map(
          (value, binding) => ({ binding, resource: { kind: 'buffer' as const, value } }),
        ),
      });
      if (!group.ok) return group;
      pass.setPipeline(pipeline.value);
      pass.setBindGroup(0, group.value);
      pass.dispatchWorkgroups(Math.ceil(rayCount / 64));
      return ok(undefined);
    },
  });
}
