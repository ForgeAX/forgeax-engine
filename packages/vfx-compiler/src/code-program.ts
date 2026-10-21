import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import {
  createShaderProgramCompiler,
  getShaderCompilerFingerprint,
} from '@forgeax/engine-shader-compiler';
import type { MaterialParticleInput, ParticleEffectAssetV3, Result } from '@forgeax/engine-types';
import { err, ok, stripWgslComments, WGSL_NUMERIC_LAYOUT } from '@forgeax/engine-types';
import type { ParticleEmitterSourceV3 } from '@forgeax/engine-vfx';
import {
  PARTICLE_CODE_DEFAULT_MODULE_ID,
  type ParticleAttributeRef,
  type ParticleCodeSourceError,
  type ParticleRendererSemantic,
  parseParticleEffectSourceV3,
  VFX_PARTICLE_CORE_LAYOUT,
  type VfxDataInterfaceRequirement,
  type VfxGpuEmitterProgramV3,
  type VfxGpuProgramV3,
  type VfxGpuRendererReflectionV3,
  type VfxValueType,
} from '@forgeax/engine-vfx';
import { VFX_FORCE_FIELDS_WGSL } from './force-fields.js';
import {
  createVfxInstanceComputeProgram,
  VFX_INSTANCE_COMPUTE_COMPILER_SOURCE,
} from './instance-compute.js';
import {
  buildParticleStagePlan,
  createParticleStageManagedRuntime,
  PARTICLE_EVENT_MANAGED_RUNTIME,
  type ParticleStagePlanError,
} from './managed-program.js';
import {
  canonical,
  materialInputSourceExpression,
  reflectVfxLayout,
  reflectVfxRendererV3,
  type VfxReflectionError,
} from './reflection.js';
import { SCENE_SDF_RUNTIME_WGSL } from './scene-sdf.js';

// Build-host lifetime, bounded by the shared compiler's 128-entry / 16 MiB budget.
// Every cook still validates source metadata and derives a fresh artifact.
const compileParticleShader = createShaderProgramCompiler();

/** The single public cooked-program ABI. */
export const PARTICLE_CODE_PROGRAM_FORMAT = 'forgeax-vfx-program-4' as const;
export const PARTICLE_CODE_PROGRAM_ARTIFACT_KEY = 'particle-effect/program.json' as const;

export const PARTICLE_CODE_PRELUDE_MODULE_ID = 'forgeax_vfx::prelude' as const;

/** Program v3 prelude generated from the Core layout. */
export const PARTICLE_CODE_PRELUDE = `#define_import_path forgeax_vfx::prelude
struct VfxParticle {
${VFX_PARTICLE_CORE_LAYOUT.fields.map((field) => `  ${field.name}: ${field.type},`).join('\n')}
}

struct VfxSpawnContext {
  delta: f32,
  tick: u32,
  seed: u32,
  playCycle: u32,
  particleId: u32,
}

struct VfxUpdateContext {
  delta: f32,
  tick: u32,
  seed: u32,
  playCycle: u32,
  particleId: u32,
}

fn vfx_hash(value: u32) -> u32 {
  var x = value;
  x = ((x >> 16u) ^ x) * 0x45d9f3bu;
  x = ((x >> 16u) ^ x) * 0x45d9f3bu;
  return (x >> 16u) ^ x;
}

fn vfx_random_words(seed: u32, particleId: u32, tick: u32, sampleKey: u32) -> f32 {
  let bits = vfx_hash(seed ^ vfx_hash(particleId) ^ vfx_hash(tick) ^ vfx_hash(sampleKey));
  return f32(bits) / 4294967295.0;
}

fn vfx_random_spawn(ctx: VfxSpawnContext, sampleKey: u32) -> f32 {
  // A replay uses the same authored seed, particle identity and fixed tick.
  // playCycle is an inspection/lifecycle counter, not an entropy input; using
  // it here would make the documented deterministic replay contract depend on
  // how many times the player was restarted.
  return vfx_random_words(ctx.seed, ctx.particleId, ctx.tick, sampleKey);
}

fn vfx_random_update(ctx: VfxUpdateContext, sampleKey: u32) -> f32 {
  return vfx_random_words(ctx.seed, ctx.particleId, ctx.tick, sampleKey);
}

fn vfx_integrate(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  (*particle).position += (*particle).velocity * ctx.delta;
}
`;

/** Small v3-only default module for smoke fixtures and tooling examples. */
export const PARTICLE_CODE_DEFAULT_MODULE = `#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_integrate}
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = vec3<f32>(0.0, 0.0, 0.0);
  (*particle).velocity = vec3<f32>(0.0, 0.8, 0.0);
  (*particle).color = vec4<f32>(0.2, 0.6, 1.0, 1.0);
  (*particle).sprite_size = vec2<f32>(0.22);
  (*particle).lifetime = 2.0;
  (*particle).mesh_orientation = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  (*particle).mesh_scale = vec3<f32>(1.0);
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  (*particle).velocity += vec3<f32>(0.0, -0.4, 0.0) * ctx.delta;
  vfx_integrate(ctx, particle);
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  (*particle).sprite_size = vec2<f32>(mix(0.22, 0.04, life));
  (*particle).color = vec4<f32>(mix(vec3<f32>(0.2, 0.6, 1.0), vec3<f32>(0.05, 0.2, 1.0), life), 1.0 - life);
}`;

const PARTICLE_CODE_DATA_INTERFACE_MODULES: Readonly<Record<string, string>> = {
  'forgeax_vfx::data::scene_sdf': '#define_import_path forgeax_vfx::data::scene_sdf\n',
  'forgeax_vfx::data::force_fields': '#define_import_path forgeax_vfx::data::force_fields\n',
  'forgeax_vfx::data::camera': `#define_import_path forgeax_vfx::data::camera
struct VfxCameraData {
  view_projection: mat4x4<f32>,
}
`,
  'forgeax_vfx::data::scene_depth': `#define_import_path forgeax_vfx::data::scene_depth
struct VfxSceneDepthData {
  depth_scale: f32,
}
`,
  'forgeax_vfx::data::noise': `#define_import_path forgeax_vfx::data::noise
struct VfxNoiseData {
  seed: u32,
}
`,
};

const REQUIRED_SPAWN_V3 =
  /\bfn\s+vfx_spawn\s*\(\s*\w+\s*:\s*VfxSpawnContext\s*,\s*\w+\s*:\s*ptr\s*<\s*function\s*,\s*VfxParticle\s*>\s*(?:,\s*\w+\s*:\s*ptr\s*<\s*function\s*,\s*VfxCustom\s*>)?\s*\)/;
const REQUIRED_UPDATE_V3 =
  /\bfn\s+vfx_update\s*\(\s*\w+\s*:\s*VfxUpdateContext\s*,\s*\w+\s*:\s*ptr\s*<\s*function\s*,\s*VfxParticle\s*>\s*(?:,\s*\w+\s*:\s*ptr\s*<\s*function\s*,\s*VfxCustom\s*>)?\s*\)/;
const RESERVED = /@(group|binding|compute|vertex|fragment)\b|\bfn\s+forgeax_vfx_/;

// The original entry remains the fallback and the byte-identical tiny-emitter path.
const PARTICLE_SORT_MAIN_V3 = `@compute @workgroup_size(1)
fn forgeax_vfx_sort_main() {
  if (forgeax_vfx_runtime.sorting < 2u) { return; }
  let aliveCount = atomicLoad(&forgeax_vfx_counters.aliveCount);
  var index = 1u;
  loop {
    if (index >= aliveCount) { break; }
    let candidate = forgeax_vfx_alive_indices[index];
    let candidateWorldPosition = forgeax_vfx_world_position(
      forgeax_vfx_renderer_position(candidate),
    );
    let candidateDepth = forgeax_vfx_project(
      candidateWorldPosition,
    ).z;
    let candidateDistance = dot(
      candidateWorldPosition - forgeax_vfx_runtime.cameraPosition.xyz,
      candidateWorldPosition - forgeax_vfx_runtime.cameraPosition.xyz,
    );
    var cursor = index;
    loop {
      if (cursor == 0u) { break; }
      let previous = forgeax_vfx_alive_indices[cursor - 1u];
      let previousWorldPosition = forgeax_vfx_world_position(
        forgeax_vfx_renderer_position(previous),
      );
      let previousDepth = forgeax_vfx_project(
        previousWorldPosition,
      ).z;
      let previousDistance = dot(
        previousWorldPosition - forgeax_vfx_runtime.cameraPosition.xyz,
        previousWorldPosition - forgeax_vfx_runtime.cameraPosition.xyz,
      );
      let candidateKey = forgeax_vfx_custom_sort_key(candidate);
      let previousKey = forgeax_vfx_custom_sort_key(previous);
      if (forgeax_vfx_runtime.sorting == 3u) {
        if (previousKey <= candidateKey) { break; }
      } else if (forgeax_vfx_runtime.sorting == 4u) {
        if (previousKey >= candidateKey) { break; }
      } else if (forgeax_vfx_runtime.sorting == 5u) {
        if (previousDistance >= candidateDistance) { break; }
      } else if (previousDepth <= candidateDepth) {
        break;
      }
      forgeax_vfx_alive_indices[cursor] = previous;
      cursor -= 1u;
    }
    forgeax_vfx_alive_indices[cursor] = candidate;
    index += 1u;
  }
}`;

function particleSortRuntime(capacity: number): string {
  // Tiny emitters regress with a private key array; large capacities retain
  // the original unbounded insertion path and its existing resource contract.
  if (capacity < 16 || capacity > 256) return PARTICLE_SORT_MAIN_V3;
  const fallback = PARTICLE_SORT_MAIN_V3.replace(
    '@compute @workgroup_size(1)\nfn forgeax_vfx_sort_main()',
    'fn forgeax_vfx_sort_insertion()',
  );
  return `${fallback}\n\nconst FORGEAX_VFX_SORT_KEY_CAPACITY: u32 = ${capacity}u;

fn forgeax_vfx_sort_key(index: u32) -> f32 {
  if (forgeax_vfx_runtime.sorting == 3u || forgeax_vfx_runtime.sorting == 4u) {
    return forgeax_vfx_custom_sort_key(index);
  }
  let worldPosition = forgeax_vfx_world_position(forgeax_vfx_renderer_position(index));
  if (forgeax_vfx_runtime.sorting == 5u) {
    let delta = worldPosition - forgeax_vfx_runtime.cameraPosition.xyz;
    return dot(delta, delta);
  }
  return forgeax_vfx_project(worldPosition).z;
}

@compute @workgroup_size(1)
fn forgeax_vfx_sort_main() {
  if (forgeax_vfx_runtime.sorting < 2u) { return; }
  let aliveCount = atomicLoad(&forgeax_vfx_counters.aliveCount);
  if (aliveCount < 16u || aliveCount > FORGEAX_VFX_SORT_KEY_CAPACITY) {
    forgeax_vfx_sort_insertion();
    return;
  }
  // Renderer attributes are generated reads of the unchanged particle/custom
  // state. Only the alive roster moves during sorting, so evaluate each key
  // once and move it beside the original stable insertion order.
  var keys: array<f32, FORGEAX_VFX_SORT_KEY_CAPACITY>;
  for (var rank = 0u; rank < aliveCount; rank += 1u) {
    keys[rank] = forgeax_vfx_sort_key(forgeax_vfx_alive_indices[rank]);
  }
  let descending = forgeax_vfx_runtime.sorting == 4u || forgeax_vfx_runtime.sorting == 5u;
  for (var index = 1u; index < aliveCount; index += 1u) {
    let candidate = forgeax_vfx_alive_indices[index];
    let candidateKey = keys[index];
    var cursor = index;
    loop {
      if (cursor == 0u) { break; }
      let previousKey = keys[cursor - 1u];
      if (descending) {
        if (previousKey >= candidateKey) { break; }
      } else if (previousKey <= candidateKey) { break; }
      forgeax_vfx_alive_indices[cursor] = forgeax_vfx_alive_indices[cursor - 1u];
      keys[cursor] = previousKey;
      cursor -= 1u;
    }
    forgeax_vfx_alive_indices[cursor] = candidate;
    keys[cursor] = candidateKey;
  }
}`;
}

/** Single executable Program v3 GPU shell; no legacy-ABI rewrite step. */
export const PARTICLE_MANAGED_RUNTIME_V3 = `
struct ForgeaxVfxRuntime {
  delta: f32,
  tick: u32,
  seed: u32,
  playCycle: u32,
  capacity: u32,
  spawnCount: u32,
  firstParticleId: u32,
  rendererCount: u32,
  viewProjection: mat4x4<f32>,
  cameraRight: vec4<f32>,
  cameraUp: vec4<f32>,
  baseColor: vec4<f32>,
  emissiveIntensity: vec4<f32>,
  surface: vec4<f32>,
  localToWorld: mat4x4<f32>,
  topology: vec4<u32>,
  billboard: vec4<f32>,
  textureSheet: vec4<f32>,
  cameraPosition: vec3<f32>,
  sorting: u32,
}

struct ForgeaxVfxCounters {
  aliveCount: atomic<u32>,
  droppedCount: atomic<u32>,
  eventProduced: atomic<u32>,
  eventConsumed: atomic<u32>,
  eventDropped: atomic<u32>,
  eventOverflow: atomic<u32>,
}

struct ForgeaxVfxIndirect {
  vertexOrIndexCount: u32,
  instanceCount: u32,
  firstVertexOrIndex: u32,
  baseVertex: i32,
  firstInstance: u32,
}

@group(0) @binding(0) var<storage, read_write> forgeax_vfx_particles: array<VfxParticle>;
@group(0) @binding(1) var<uniform> forgeax_vfx_runtime: ForgeaxVfxRuntime;
@group(0) @binding(2) var<storage, read_write> forgeax_vfx_alive_indices: array<u32>;
@group(0) @binding(3) var<storage, read_write> forgeax_vfx_counters: ForgeaxVfxCounters;
@group(0) @binding(4) var<storage, read_write> forgeax_vfx_indirect: array<ForgeaxVfxIndirect>;
@group(0) @binding(5) var<storage, read_write> forgeax_vfx_scratch: array<u32>;
@group(0) @binding(6) var<storage, read_write> forgeax_vfx_billboard_instances: array<f32>;

@compute @workgroup_size(256)
fn forgeax_vfx_spawn_main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index >= forgeax_vfx_runtime.capacity) { return; }
  if (forgeax_vfx_scratch[index] == 0u) {
    let deadRank = index - forgeax_vfx_scratch[forgeax_vfx_runtime.capacity + index];
    if (deadRank < forgeax_vfx_runtime.spawnCount) {
      var particle = VfxParticle(
        vec3<f32>(0.0),
        0.0,
        vec3<f32>(0.0),
        1.0,
        vec4<f32>(1.0),
        vec2<f32>(1.0, 1.0),
        0.0,
        0.0,
        vec4<f32>(0.0, 0.0, 0.0, 1.0),
        vec3<f32>(1.0),
        0.0,
        forgeax_vfx_runtime.firstParticleId + deadRank,
        1u,
      );
      let ctx = VfxSpawnContext(
        forgeax_vfx_runtime.delta,
        forgeax_vfx_runtime.tick,
        forgeax_vfx_runtime.seed,
        forgeax_vfx_runtime.playCycle,
        particle.id,
      );
      vfx_spawn(ctx, &particle);
      forgeax_vfx_particles[index] = particle;
      forgeax_vfx_scratch[index] = 1u;
    }
  }
  if (index == 0u) {
    let freeCount = forgeax_vfx_runtime.capacity - atomicLoad(&forgeax_vfx_counters.aliveCount);
    atomicAdd(
      &forgeax_vfx_counters.droppedCount,
      forgeax_vfx_runtime.spawnCount - min(forgeax_vfx_runtime.spawnCount, freeCount),
    );
  }
}

@compute @workgroup_size(256)
fn forgeax_vfx_update_main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index >= forgeax_vfx_runtime.capacity) { return; }
  var particle = forgeax_vfx_particles[index];
  if (forgeax_vfx_scratch[index] == 0u) { return; }
  let ctx = VfxUpdateContext(
    forgeax_vfx_runtime.delta,
    forgeax_vfx_runtime.tick,
    forgeax_vfx_runtime.seed,
    forgeax_vfx_runtime.playCycle,
    particle.id,
  );
  vfx_update(ctx, &particle);
  particle.age += forgeax_vfx_runtime.delta;
  if (particle.age >= particle.lifetime) {
    particle.alive = 0u;
  }
  forgeax_vfx_scratch[index] = select(0u, 1u, particle.alive != 0u);
  forgeax_vfx_particles[index] = particle;
}

var<workgroup> forgeax_vfx_scan_scratch: array<u32, 256>;

@compute @workgroup_size(256)
fn forgeax_vfx_scan_blocks_main(
  @builtin(global_invocation_id) invocation: vec3<u32>,
  @builtin(local_invocation_id) local: vec3<u32>,
  @builtin(workgroup_id) group: vec3<u32>,
) {
  let index = invocation.x;
  let lane = local.x;
  var flag = 0u;
  if (index < forgeax_vfx_runtime.capacity) {
    flag = forgeax_vfx_scratch[index];
  }
  forgeax_vfx_scan_scratch[lane] = flag;
  workgroupBarrier();
  var offset = 1u;
  loop {
    if (offset >= 256u) { break; }
    var addend = 0u;
    if (lane >= offset) { addend = forgeax_vfx_scan_scratch[lane - offset]; }
    workgroupBarrier();
    forgeax_vfx_scan_scratch[lane] += addend;
    workgroupBarrier();
    offset *= 2u;
  }
  if (index < forgeax_vfx_runtime.capacity) {
    forgeax_vfx_scratch[forgeax_vfx_runtime.capacity + index] = forgeax_vfx_scan_scratch[lane] - flag;
  }
  if (lane == 255u) {
    forgeax_vfx_scratch[forgeax_vfx_runtime.capacity * 2u + group.x] = forgeax_vfx_scan_scratch[lane];
  }
}

@compute @workgroup_size(1)
fn forgeax_vfx_scan_block_offsets_main() {
  let blockCount = (forgeax_vfx_runtime.capacity + 255u) / 256u;
  var sum = 0u;
  var block = 0u;
  loop {
    if (block >= blockCount) { break; }
    let scratchIndex = forgeax_vfx_runtime.capacity * 2u + block;
    let blockSum = forgeax_vfx_scratch[scratchIndex];
    forgeax_vfx_scratch[scratchIndex] = sum;
    sum += blockSum;
    block += 1u;
  }
}

@compute @workgroup_size(256)
fn forgeax_vfx_add_offsets_main(
  @builtin(global_invocation_id) invocation: vec3<u32>,
  @builtin(workgroup_id) group: vec3<u32>,
) {
  if (invocation.x >= forgeax_vfx_runtime.capacity) { return; }
  forgeax_vfx_scratch[forgeax_vfx_runtime.capacity + invocation.x] +=
    forgeax_vfx_scratch[forgeax_vfx_runtime.capacity * 2u + group.x];
}

@compute @workgroup_size(256)
fn forgeax_vfx_compact_main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index < forgeax_vfx_runtime.capacity && forgeax_vfx_scratch[index] != 0u) {
    forgeax_vfx_alive_indices[forgeax_vfx_scratch[forgeax_vfx_runtime.capacity + index]] = index;
  }
  if (index == 0u) {
    let last = forgeax_vfx_runtime.capacity - 1u;
    let count = forgeax_vfx_scratch[forgeax_vfx_runtime.capacity + last] + forgeax_vfx_scratch[last];
    atomicStore(&forgeax_vfx_counters.aliveCount, count);
    var renderer = 0u;
    loop {
      if (renderer >= forgeax_vfx_runtime.rendererCount) { break; }
      forgeax_vfx_indirect[renderer].instanceCount = count;
      renderer += 1u;
    }
  }
}

fn forgeax_vfx_custom_sort_key(index: u32) -> f32 {
  // The generated emitter runtime replaces this implementation when a
  // renderer declares a reflected VfxCustom sort key. Keeping a valid default
  // lets emitters without Custom storage share the same managed program.
  _ = index;
  return 0.0;
}

${PARTICLE_SORT_MAIN_V3}

fn forgeax_vfx_project(position: vec3<f32>) -> vec3<f32> {
  let clip = forgeax_vfx_runtime.viewProjection * vec4<f32>(position, 1.0);
  let inverseW = select(1.0, 1.0 / clip.w, abs(clip.w) > 0.000001);
  return clip.xyz * inverseW;
}

fn forgeax_vfx_world_position(position: vec3<f32>) -> vec3<f32> {
  return (forgeax_vfx_runtime.localToWorld * vec4<f32>(position, 1.0)).xyz;
}

// Static geometry fields are published with projection, not by a CPU write that
// would clear the previous instance count before early shadow consumers run.
fn forgeax_vfx_write_draw_geometry(count: u32, first: u32) {
  let renderer = forgeax_vfx_runtime.topology.x;
  forgeax_vfx_indirect[renderer].vertexOrIndexCount = count;
  forgeax_vfx_indirect[renderer].firstVertexOrIndex = first;
  forgeax_vfx_indirect[renderer].baseVertex = 0;
  forgeax_vfx_indirect[renderer].firstInstance = 0u;
}

fn forgeax_vfx_zero_billboard_instance(rank: u32) {
  let materialLanes = u32(max(0.0, forgeax_vfx_runtime.billboard.w));
  let base = rank * (31u + materialLanes * 4u);
  var offset = 0u;
  loop {
    if (offset >= 31u + min(materialLanes, 4u) * 4u) { break; }
    forgeax_vfx_billboard_instances[base + offset] = 0.0;
    offset += 1u;
  }
}

@compute @workgroup_size(256)
fn forgeax_vfx_billboard_main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let rank = invocation.x;
  if (rank == 0u) { forgeax_vfx_write_draw_geometry(6u, 0u); }
  let aliveCount = atomicLoad(&forgeax_vfx_counters.aliveCount);
  if (rank >= aliveCount) { return; }
  let particleIndex = forgeax_vfx_alive_indices[rank];
  let particle = forgeax_vfx_particles[particleIndex];
  let materialLanes = u32(max(0.0, forgeax_vfx_runtime.billboard.w));
  if (!forgeax_vfx_renderer_visibility(particleIndex)) {
    forgeax_vfx_zero_billboard_instance(rank);
    return;
  }
  let worldPosition = forgeax_vfx_world_position(forgeax_vfx_renderer_position(particleIndex));
  let center = forgeax_vfx_project(worldPosition);
  let cosine = cos(forgeax_vfx_renderer_rotation(particleIndex));
  let sine = sin(forgeax_vfx_renderer_rotation(particleIndex));
  let rightAxis = forgeax_vfx_runtime.cameraRight.xyz * cosine + forgeax_vfx_runtime.cameraUp.xyz * sine;
  let upAxis = forgeax_vfx_runtime.cameraUp.xyz * cosine - forgeax_vfx_runtime.cameraRight.xyz * sine;
  let right = forgeax_vfx_project(
    worldPosition + rightAxis * forgeax_vfx_renderer_size(particleIndex).x,
  ) - center;
  let up = forgeax_vfx_project(
    worldPosition + upAxis * forgeax_vfx_renderer_size(particleIndex).y,
  ) - center;
  // materialLanes counts vec4 slots, while the instance buffer is indexed
  // as f32 values. Keep the projection stride in the same units as the
  // renderer-owned byte allocation (16 bytes per lane).
  let base = rank * (31u + materialLanes * 4u);
  forgeax_vfx_billboard_instances[base] = center.x;
  forgeax_vfx_billboard_instances[base + 1u] = center.y;
  forgeax_vfx_billboard_instances[base + 2u] = center.z;
  forgeax_vfx_billboard_instances[base + 3u] = right.x;
  forgeax_vfx_billboard_instances[base + 4u] = right.y;
  forgeax_vfx_billboard_instances[base + 5u] = up.x;
  forgeax_vfx_billboard_instances[base + 6u] = up.y;
  let color = forgeax_vfx_renderer_color(particleIndex);
  forgeax_vfx_billboard_instances[base + 7u] = color.x;
  forgeax_vfx_billboard_instances[base + 8u] = color.y;
  forgeax_vfx_billboard_instances[base + 9u] = color.z;
  forgeax_vfx_billboard_instances[base + 10u] = color.w;
  forgeax_vfx_billboard_instances[base + 11u] = forgeax_vfx_runtime.baseColor.x;
  forgeax_vfx_billboard_instances[base + 12u] = forgeax_vfx_runtime.baseColor.y;
  forgeax_vfx_billboard_instances[base + 13u] = forgeax_vfx_runtime.baseColor.z;
  forgeax_vfx_billboard_instances[base + 14u] = forgeax_vfx_runtime.baseColor.w;
  forgeax_vfx_billboard_instances[base + 15u] = forgeax_vfx_runtime.emissiveIntensity.x;
  forgeax_vfx_billboard_instances[base + 16u] = forgeax_vfx_runtime.emissiveIntensity.y;
  forgeax_vfx_billboard_instances[base + 17u] = forgeax_vfx_runtime.emissiveIntensity.z;
  forgeax_vfx_billboard_instances[base + 18u] = forgeax_vfx_runtime.emissiveIntensity.w;
  forgeax_vfx_billboard_instances[base + 19u] = forgeax_vfx_runtime.surface.x;
  forgeax_vfx_billboard_instances[base + 20u] = forgeax_vfx_runtime.surface.y;
  forgeax_vfx_billboard_instances[base + 21u] = forgeax_vfx_runtime.surface.z;
  forgeax_vfx_billboard_instances[base + 22u] = forgeax_vfx_runtime.surface.w;
  let frameCount = max(1.0, forgeax_vfx_runtime.textureSheet.w);
  let ageFrame = min(frameCount - 1.0, floor(max(0.0, forgeax_vfx_renderer_age(particleIndex)) * forgeax_vfx_runtime.textureSheet.z));
  let subImage = forgeax_vfx_renderer_subImage(particleIndex);
  let frame = select(ageFrame, min(frameCount - 1.0, floor(max(0.0, subImage))), subImage >= 0.0);
  forgeax_vfx_billboard_instances[base + 23u] = forgeax_vfx_runtime.billboard.x;
  forgeax_vfx_billboard_instances[base + 24u] = forgeax_vfx_runtime.billboard.y;
  forgeax_vfx_billboard_instances[base + 25u] = frame;
  forgeax_vfx_billboard_instances[base + 26u] = frameCount;
  forgeax_vfx_billboard_instances[base + 27u] = forgeax_vfx_runtime.textureSheet.x;
  forgeax_vfx_billboard_instances[base + 28u] = forgeax_vfx_runtime.textureSheet.y;
  forgeax_vfx_billboard_instances[base + 29u] = forgeax_vfx_runtime.billboard.z;
  forgeax_vfx_billboard_instances[base + 30u] = f32(forgeax_vfx_runtime.topology.w);
  if (materialLanes > 0u) {
    forgeax_vfx_billboard_instances[base + 31u] = particle.material_random;
    forgeax_vfx_billboard_instances[base + 32u] = particle.material_random;
    forgeax_vfx_billboard_instances[base + 33u] = particle.material_random;
    forgeax_vfx_billboard_instances[base + 34u] = particle.material_random;
  }
}


fn forgeax_vfx_quaternion_rotate(q: vec4<f32>, value: vec3<f32>) -> vec3<f32> {
  let t = 2.0 * cross(q.xyz, value);
  return value + q.w * t + cross(q.xyz, t);
}

fn forgeax_vfx_mesh_scalar_valid(value: f32) -> bool {
  // WGSL has no portable isFinite builtin. NaN is the only value for which
  // value == value is false; the magnitude fence rejects infinities and
  // bounds the normalization/matrix product below.
  return value == value && abs(value) <= 1000000.0;
}

fn forgeax_vfx_mesh_transform_valid(index: u32) -> bool {
  let orientation = forgeax_vfx_renderer_orientation(index);
  let scale = forgeax_vfx_renderer_scale(index);
  let orientationLength = length(orientation);
  return forgeax_vfx_mesh_scalar_valid(orientation.x) &&
    forgeax_vfx_mesh_scalar_valid(orientation.y) &&
    forgeax_vfx_mesh_scalar_valid(orientation.z) &&
    forgeax_vfx_mesh_scalar_valid(orientation.w) &&
    orientationLength > 0.000001 && orientationLength <= 1000000.0 &&
    forgeax_vfx_mesh_scalar_valid(scale.x) &&
    forgeax_vfx_mesh_scalar_valid(scale.y) &&
    forgeax_vfx_mesh_scalar_valid(scale.z) &&
    abs(scale.x) > 0.000001 &&
    abs(scale.y) > 0.000001 &&
    abs(scale.z) > 0.000001;
}

fn forgeax_vfx_zero_mesh_instance(rank: u32) {
  let materialLanes = u32(max(0.0, forgeax_vfx_runtime.billboard.w));
  let base = rank * (18u + materialLanes * 4u);
  var offset = 0u;
  loop {
    if (offset >= 18u) { break; }
    forgeax_vfx_billboard_instances[base + offset] = 0.0;
    offset += 1u;
  }
  var lane = 0u;
  loop {
    if (lane >= min(materialLanes, 4u)) { break; }
    let materialOffset = base + 18u + lane * 4u;
    forgeax_vfx_billboard_instances[materialOffset] = 0.0;
    forgeax_vfx_billboard_instances[materialOffset + 1u] = 0.0;
    forgeax_vfx_billboard_instances[materialOffset + 2u] = 0.0;
    forgeax_vfx_billboard_instances[materialOffset + 3u] = 0.0;
    lane += 1u;
  }
}

@compute @workgroup_size(256)
fn forgeax_vfx_mesh_main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let rank = invocation.x;
  if (rank == 0u) {
    forgeax_vfx_write_draw_geometry(forgeax_vfx_runtime.topology.y, forgeax_vfx_runtime.topology.w);
  }
  let aliveCount = atomicLoad(&forgeax_vfx_counters.aliveCount);
  if (rank >= aliveCount) { return; }
  let particleIndex = forgeax_vfx_alive_indices[rank];
  let particle = forgeax_vfx_particles[particleIndex];
  if (!forgeax_vfx_renderer_visibility(particleIndex) || !forgeax_vfx_mesh_transform_valid(particleIndex)) {
    // Keep the indirect count bounded by aliveCount while making an invalid
    // transform a deterministic, zero-area instance instead of stale data or
    // NaN geometry. droppedCount is the existing GPU diagnostic channel.
    forgeax_vfx_zero_mesh_instance(rank);
    atomicAdd(&forgeax_vfx_counters.droppedCount, 1u);
    return;
  }
  let rendererOrientation = forgeax_vfx_renderer_orientation(particleIndex);
  let rendererScale = forgeax_vfx_renderer_scale(particleIndex);
  let orientationLength = length(rendererOrientation);
  let orientation = rendererOrientation / orientationLength;
  let axisX = forgeax_vfx_quaternion_rotate(orientation, vec3<f32>(1.0, 0.0, 0.0)) * rendererScale.x;
  let axisY = forgeax_vfx_quaternion_rotate(orientation, vec3<f32>(0.0, 1.0, 0.0)) * rendererScale.y;
  let axisZ = forgeax_vfx_quaternion_rotate(orientation, vec3<f32>(0.0, 0.0, 1.0)) * rendererScale.z;
  let centerPosition = forgeax_vfx_world_position(forgeax_vfx_renderer_position(particleIndex));
  // Keep the instance stream in world space. The camera and shadow adapters
  // apply their own view projection later, so a camera change cannot bake a
  // stale clip-space basis into a persistent particle buffer.
  let center = centerPosition;
  let right = (forgeax_vfx_runtime.localToWorld * vec4<f32>(axisX, 0.0)).xyz;
  let up = (forgeax_vfx_runtime.localToWorld * vec4<f32>(axisY, 0.0)).xyz;
  let forward = (forgeax_vfx_runtime.localToWorld * vec4<f32>(axisZ, 0.0)).xyz;
  let materialLanes = u32(max(0.0, forgeax_vfx_runtime.billboard.w));
  let base = rank * (18u + materialLanes * 4u);
  forgeax_vfx_billboard_instances[base] = center.x;
  forgeax_vfx_billboard_instances[base + 1u] = center.y;
  forgeax_vfx_billboard_instances[base + 2u] = center.z;
  forgeax_vfx_billboard_instances[base + 3u] = right.x;
  forgeax_vfx_billboard_instances[base + 4u] = right.y;
  forgeax_vfx_billboard_instances[base + 5u] = right.z;
  forgeax_vfx_billboard_instances[base + 6u] = up.x;
  forgeax_vfx_billboard_instances[base + 7u] = up.y;
  forgeax_vfx_billboard_instances[base + 8u] = up.z;
  forgeax_vfx_billboard_instances[base + 9u] = forward.x;
  forgeax_vfx_billboard_instances[base + 10u] = forward.y;
  forgeax_vfx_billboard_instances[base + 11u] = forward.z;
  let color = forgeax_vfx_renderer_color(particleIndex);
  forgeax_vfx_billboard_instances[base + 12u] = color.x;
  forgeax_vfx_billboard_instances[base + 13u] = color.y;
  forgeax_vfx_billboard_instances[base + 14u] = color.z;
  forgeax_vfx_billboard_instances[base + 15u] = color.w;
  let controls = forgeax_vfx_mesh_controls(forgeax_vfx_runtime.topology.x);
  forgeax_vfx_billboard_instances[base + 16u] = controls.x;
  forgeax_vfx_billboard_instances[base + 17u] = controls.y;
  if (materialLanes > 0u) {
    forgeax_vfx_billboard_instances[base + 18u] = particle.material_random;
    forgeax_vfx_billboard_instances[base + 19u] = particle.material_random;
    forgeax_vfx_billboard_instances[base + 20u] = particle.material_random;
    forgeax_vfx_billboard_instances[base + 21u] = particle.material_random;
  }
}

@compute @workgroup_size(256)
fn forgeax_vfx_ribbon_main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let rank = invocation.x;
  if (rank == 0u) { forgeax_vfx_write_draw_geometry(6u, 0u); }
  let count = min(atomicLoad(&forgeax_vfx_counters.aliveCount), forgeax_vfx_runtime.topology.z);
  if (rank == 0u) {
    forgeax_vfx_indirect[forgeax_vfx_runtime.topology.x].instanceCount = select(0u, count - 1u, count > 1u);
  }
  if (rank + 1u >= count) { return; }
  let particleIndex = forgeax_vfx_alive_indices[rank];
  let nextIndex = forgeax_vfx_alive_indices[rank + 1u];
  let start = forgeax_vfx_project(forgeax_vfx_world_position(forgeax_vfx_renderer_position(particleIndex)));
  let endpoint = forgeax_vfx_project(forgeax_vfx_world_position(forgeax_vfx_renderer_position(nextIndex)));
  let materialLanes = u32(max(0.0, forgeax_vfx_runtime.billboard.w));
  let base = rank * (12u + materialLanes * 4u);
  forgeax_vfx_billboard_instances[base] = start.x;
  forgeax_vfx_billboard_instances[base + 1u] = start.y;
  forgeax_vfx_billboard_instances[base + 2u] = start.z;
  forgeax_vfx_billboard_instances[base + 3u] = endpoint.x;
  forgeax_vfx_billboard_instances[base + 4u] = endpoint.y;
  forgeax_vfx_billboard_instances[base + 5u] = endpoint.z;
  let color = forgeax_vfx_renderer_color(particleIndex);
  forgeax_vfx_billboard_instances[base + 6u] = color.x;
  forgeax_vfx_billboard_instances[base + 7u] = color.y;
  forgeax_vfx_billboard_instances[base + 8u] = color.z;
  forgeax_vfx_billboard_instances[base + 9u] = color.w;
  forgeax_vfx_billboard_instances[base + 10u] = forgeax_vfx_renderer_width(particleIndex);
  forgeax_vfx_billboard_instances[base + 11u] = 0.0;
  if (materialLanes > 0u) {
    forgeax_vfx_billboard_instances[base + 12u] = particle.material_random;
    forgeax_vfx_billboard_instances[base + 13u] = particle.material_random;
    forgeax_vfx_billboard_instances[base + 14u] = particle.material_random;
    forgeax_vfx_billboard_instances[base + 15u] = particle.material_random;
  }
}

@compute @workgroup_size(256)
fn forgeax_vfx_trail_history_main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let rank = invocation.x;
  let count = min(atomicLoad(&forgeax_vfx_counters.aliveCount), forgeax_vfx_runtime.topology.z);
  if (rank >= count) { return; }
  let particleIndex = forgeax_vfx_alive_indices[rank];
  let particle = forgeax_vfx_particles[particleIndex];
  let historyLength = max(2u, forgeax_vfx_runtime.topology.y);
  let metadata = forgeax_vfx_runtime.capacity * historyLength * 4u + particleIndex * 4u;
  let previousCount = forgeax_vfx_scratch[metadata];
  let sameParticle = previousCount > 0u && forgeax_vfx_scratch[metadata + 2u] == particle.id;
  let slot = select(0u, (forgeax_vfx_scratch[metadata + 1u] + 1u) % historyLength, sameParticle);
  let historyTarget = (particleIndex * historyLength + slot) * 4u;
  let position = forgeax_vfx_world_position(forgeax_vfx_renderer_position(particleIndex));
  forgeax_vfx_scratch[historyTarget] = bitcast<u32>(position.x);
  forgeax_vfx_scratch[historyTarget + 1u] = bitcast<u32>(position.y);
  forgeax_vfx_scratch[historyTarget + 2u] = bitcast<u32>(position.z);
  forgeax_vfx_scratch[metadata] = select(1u, min(previousCount + 1u, historyLength), sameParticle);
  forgeax_vfx_scratch[metadata + 1u] = slot;
  forgeax_vfx_scratch[metadata + 2u] = particle.id;
}

// One bounded linear prefix produces compact segment offsets without an atomic
// instance counter or a second particle ABI. Projection remains parallel.
@compute @workgroup_size(1)
fn forgeax_vfx_trail_offsets_main() {
  forgeax_vfx_write_draw_geometry(6u, 0u);
  let historyLength = max(2u, forgeax_vfx_runtime.topology.y);
  let count = min(atomicLoad(&forgeax_vfx_counters.aliveCount), forgeax_vfx_runtime.topology.z);
  var offset = 0u;
  for (var rank = 0u; rank < count; rank += 1u) {
    let particleIndex = forgeax_vfx_alive_indices[rank];
    let metadata = forgeax_vfx_runtime.capacity * historyLength * 4u + particleIndex * 4u;
    let validCount = forgeax_vfx_scratch[metadata];
    forgeax_vfx_scratch[metadata + 3u] = offset;
    offset += min(max(validCount, 1u) - 1u, historyLength - 1u);
  }
  forgeax_vfx_indirect[forgeax_vfx_runtime.topology.x].instanceCount = offset;
}

@compute @workgroup_size(256)
fn forgeax_vfx_trail_main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let historyLength = max(2u, forgeax_vfx_runtime.topology.y);
  let segmentCount = historyLength - 1u;
  let count = min(atomicLoad(&forgeax_vfx_counters.aliveCount), forgeax_vfx_runtime.topology.z);
  let particleRank = invocation.x / segmentCount;
  if (particleRank >= count) { return; }
  let rank = particleRank;
  let particleIndex = forgeax_vfx_alive_indices[particleRank];
  let metadata = forgeax_vfx_runtime.capacity * historyLength * 4u + particleIndex * 4u;
  let segment = invocation.x % segmentCount;
  let validCount = forgeax_vfx_scratch[metadata];
  if (segment >= max(validCount, 1u) - 1u) { return; }
  let outputRank = forgeax_vfx_scratch[metadata + 3u] + segment;
  let newest = forgeax_vfx_scratch[metadata + 1u];
  let firstSlot = (newest + historyLength - segment) % historyLength;
  let secondSlot = (newest + historyLength - segment - 1u) % historyLength;
  let historyBase = particleIndex * historyLength * 4u;
  let firstBase = historyBase + firstSlot * 4u;
  let secondBase = historyBase + secondSlot * 4u;
  let first = vec4<f32>(
    bitcast<f32>(forgeax_vfx_scratch[firstBase]),
    bitcast<f32>(forgeax_vfx_scratch[firstBase + 1u]),
    bitcast<f32>(forgeax_vfx_scratch[firstBase + 2u]),
    bitcast<f32>(forgeax_vfx_scratch[firstBase + 3u]),
  );
  let second = vec4<f32>(
    bitcast<f32>(forgeax_vfx_scratch[secondBase]),
    bitcast<f32>(forgeax_vfx_scratch[secondBase + 1u]),
    bitcast<f32>(forgeax_vfx_scratch[secondBase + 2u]),
    bitcast<f32>(forgeax_vfx_scratch[secondBase + 3u]),
  );
  let start = forgeax_vfx_project(first.xyz);
  let endpoint = forgeax_vfx_project(second.xyz);
  let materialLanes = u32(max(0.0, forgeax_vfx_runtime.billboard.w));
  let base = outputRank * (12u + materialLanes * 4u);
  forgeax_vfx_billboard_instances[base] = start.x;
  forgeax_vfx_billboard_instances[base + 1u] = start.y;
  forgeax_vfx_billboard_instances[base + 2u] = start.z;
  forgeax_vfx_billboard_instances[base + 3u] = endpoint.x;
  forgeax_vfx_billboard_instances[base + 4u] = endpoint.y;
  forgeax_vfx_billboard_instances[base + 5u] = endpoint.z;
  let color = forgeax_vfx_renderer_color(particleIndex);
  forgeax_vfx_billboard_instances[base + 6u] = color.x;
  forgeax_vfx_billboard_instances[base + 7u] = color.y;
  forgeax_vfx_billboard_instances[base + 8u] = color.z;
  forgeax_vfx_billboard_instances[base + 9u] = color.w;
  let taper = clamp(forgeax_vfx_renderer_taper(particleIndex), 0.0, 1.0);
  forgeax_vfx_billboard_instances[base + 10u] = forgeax_vfx_renderer_width(particleIndex) * mix(1.0, taper, f32(segment) / f32(segmentCount));
  forgeax_vfx_billboard_instances[base + 11u] = f32(segment) / f32(segmentCount);
  if (materialLanes > 0u) {
    forgeax_vfx_billboard_instances[base + 12u] = particle.material_random;
    forgeax_vfx_billboard_instances[base + 13u] = particle.material_random;
    forgeax_vfx_billboard_instances[base + 14u] = particle.material_random;
    forgeax_vfx_billboard_instances[base + 15u] = particle.material_random;
  }
}

@compute @workgroup_size(256)
fn forgeax_vfx_beam_main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let rank = invocation.x;
  if (rank == 0u) { forgeax_vfx_write_draw_geometry(6u, 0u); }
  let count = min(atomicLoad(&forgeax_vfx_counters.aliveCount), forgeax_vfx_runtime.topology.z);
  if (rank == 0u) {
    forgeax_vfx_indirect[forgeax_vfx_runtime.topology.x].instanceCount = count;
  }
  if (rank >= count) { return; }
  let particleIndex = forgeax_vfx_alive_indices[rank];
  let materialLanes = u32(max(0.0, forgeax_vfx_runtime.billboard.w));
  let base = rank * (12u + materialLanes * 4u);
  let worldStart = forgeax_vfx_world_position(forgeax_vfx_renderer_position(particleIndex));
  let worldEndpoint = forgeax_vfx_world_position(
    forgeax_vfx_renderer_position(particleIndex) +
      forgeax_vfx_renderer_endpoint(particleIndex) * forgeax_vfx_particles[particleIndex].lifetime,
  );
  let start = forgeax_vfx_project(worldStart);
  let endpoint = forgeax_vfx_project(worldEndpoint);
  forgeax_vfx_billboard_instances[base] = start.x;
  forgeax_vfx_billboard_instances[base + 1u] = start.y;
  forgeax_vfx_billboard_instances[base + 2u] = start.z;
  forgeax_vfx_billboard_instances[base + 3u] = endpoint.x;
  forgeax_vfx_billboard_instances[base + 4u] = endpoint.y;
  forgeax_vfx_billboard_instances[base + 5u] = endpoint.z;
  let color = forgeax_vfx_renderer_color(particleIndex);
  forgeax_vfx_billboard_instances[base + 6u] = color.x;
  forgeax_vfx_billboard_instances[base + 7u] = color.y;
  forgeax_vfx_billboard_instances[base + 8u] = color.z;
  forgeax_vfx_billboard_instances[base + 9u] = color.w;
  forgeax_vfx_billboard_instances[base + 10u] = forgeax_vfx_renderer_width(particleIndex);
  forgeax_vfx_billboard_instances[base + 11u] = 0.0;
  if (materialLanes > 0u) {
    forgeax_vfx_billboard_instances[base + 12u] = particle.material_random;
    forgeax_vfx_billboard_instances[base + 13u] = particle.material_random;
    forgeax_vfx_billboard_instances[base + 14u] = particle.material_random;
    forgeax_vfx_billboard_instances[base + 15u] = particle.material_random;
  }
}
`;

function createParticleDataInterfaceRuntimeV3(
  requirements: readonly VfxDataInterfaceRequirement[],
): string {
  const kinds = new Set(requirements.map((requirement) => requirement.kind));
  return [
    kinds.has('force-fields') ? VFX_FORCE_FIELDS_WGSL : '',
    kinds.has('camera')
      ? '@group(0) @binding(12) var<uniform> forgeax_vfx_camera: mat4x4<f32>;'
      : '',
    kinds.has('scene-depth')
      ? '@group(0) @binding(13) var forgeax_vfx_scene_depth: texture_depth_2d;'
      : '',
    kinds.has('noise') ? '@group(0) @binding(14) var forgeax_vfx_noise: texture_2d<f32>;' : '',
    kinds.has('scene-sdf') ? SCENE_SDF_RUNTIME_WGSL : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

function wgslDefault(type: VfxValueType): string {
  return WGSL_NUMERIC_LAYOUT[type].size === 4 ? '0' : `${type}(0.0)`;
}

type ExecutedParticleRendererSemantic = Extract<
  ParticleRendererSemantic,
  | 'position'
  | 'color'
  | 'size'
  | 'rotation'
  | 'age'
  | 'subImage'
  | 'sort'
  | 'visibility'
  | 'orientation'
  | 'scale'
  | 'width'
  | 'taper'
  | 'endpoint'
>;

const PARTICLE_RENDERER_ACCESSOR_TYPES: Readonly<Record<ExecutedParticleRendererSemantic, string>> =
  {
    position: 'vec3<f32>',
    color: 'vec4<f32>',
    size: 'vec2<f32>',
    rotation: 'f32',
    subImage: 'f32',
    age: 'f32',
    sort: 'f32',
    orientation: 'vec4<f32>',
    scale: 'vec3<f32>',
    visibility: 'bool',
    width: 'f32',
    taper: 'f32',
    endpoint: 'vec3<f32>',
  };

function rendererAttributeDefault(semantic: ExecutedParticleRendererSemantic): string {
  switch (semantic) {
    case 'visibility':
      return 'true';
    case 'subImage':
      // A missing mapping preserves the existing age-driven sheet animation;
      // an explicit mapping (including frame 0) overrides it in projection.
      return '-1.0';
    case 'width':
      return 'forgeax_vfx_runtime.billboard.x';
    case 'taper':
      return '1.0';
    case 'position':
    case 'scale':
    case 'endpoint':
      return 'vec3<f32>(0.0)';
    case 'color':
    case 'orientation':
      return 'vec4<f32>(0.0)';
    case 'size':
      return 'vec2<f32>(0.0)';
    default:
      return '0.0';
  }
}

function rendererAttributeExpression(
  reference: ParticleAttributeRef,
  semantic: ExecutedParticleRendererSemantic,
  custom: import('@forgeax/engine-vfx').VfxCustomLayout | undefined,
): string {
  const field =
    reference.source === 'core'
      ? VFX_PARTICLE_CORE_LAYOUT.fields.find((candidate) => candidate.name === reference.name)
      : custom?.fields.find((candidate) => candidate.name === reference.name);
  if (field === undefined) {
    throw new Error(`renderer attribute ${reference.source}.${reference.name} is not reflected`);
  }
  const expression =
    reference.source === 'core'
      ? `particle.${reference.name}`
      : `forgeax_vfx_custom[index].${reference.name}`;
  if (semantic === 'visibility') {
    return `${expression} != ${field.type === 'f32' ? '0.0' : '0'}`;
  }
  const expected = PARTICLE_RENDERER_ACCESSOR_TYPES[semantic];
  if (field.type === expected) return expression;
  if (expected === 'f32' && (field.type === 'i32' || field.type === 'u32')) {
    return `f32(${expression})`;
  }
  throw new Error(
    `renderer attribute ${reference.source}.${reference.name} has ${field.type}, expected ${expected}`,
  );
}

/** Generate topology-aware accessors so reflected renderer mappings reach GPU projection code. */
function createParticleRendererAttributeRuntime(
  custom: import('@forgeax/engine-vfx').VfxCustomLayout | undefined,
  renderers: readonly VfxGpuRendererReflectionV3[],
): string {
  return Object.entries(PARTICLE_RENDERER_ACCESSOR_TYPES)
    .map(([semantic, type]) => {
      const key = semantic as ExecutedParticleRendererSemantic;
      const cases = renderers
        .map((renderer, index) => {
          const reference = renderer.attributes[key];
          if (reference === undefined) return '';
          return `    case ${index}u: { return ${rendererAttributeExpression(reference, key, custom)}; }`;
        })
        .filter((line) => line.length > 0)
        .join('\n');
      return `
fn forgeax_vfx_renderer_${semantic}(index: u32) -> ${type} {
  let particle = forgeax_vfx_particles[index];
  switch (forgeax_vfx_runtime.topology.x) {
${cases}
    default: { return ${rendererAttributeDefault(key)}; }
  }
}`;
    })
    .join('\n');
}

type MaterialInputSource = {
  readonly rendererIndex: number;
  readonly input: MaterialParticleInput;
  readonly source: 'custom' | 'core';
  readonly fieldType: string;
};

function materialInputValue(
  expression: string,
  fieldType: string,
  inputType: MaterialParticleInput['type'],
): string | undefined {
  const value = materialInputSourceExpression(expression, fieldType, inputType);
  if (value === undefined) return undefined;
  switch (inputType) {
    case 'f32':
      return `vec4<f32>(${value}, 0.0, 0.0, 0.0)`;
    case 'vec2<f32>':
      return `vec4<f32>(${value}, 0.0, 0.0)`;
    case 'vec3<f32>':
      return `vec4<f32>(${value}, 0.0)`;
    case 'vec4<f32>':
      return value;
  }
}

/**
 * Generate the renderer/material bridge from reflection rather than from a
 * particle-core convenience field. Material input names intentionally match
 * either a reflected Custom field or a Core field. Reflection rejects stale or
 * incompatible declarations before this code generator runs, so an unresolved
 * declaration is an internal compiler invariant rather than a runtime zero.
 */
function createParticleMaterialInputRuntime(
  custom: import('@forgeax/engine-vfx').VfxCustomLayout | undefined,
  renderers: readonly VfxGpuRendererReflectionV3[],
): { readonly wgsl: string; readonly maxLanes: number } {
  const cases: MaterialInputSource[] = [];
  let maxLanes = 0;
  for (const [rendererIndex, renderer] of renderers.entries()) {
    const names = renderer.materialInputs;
    const definitions = renderer.materialInputDefinitions;
    if (names.length > 0 && definitions === undefined) {
      throw new Error(`renderer ${rendererIndex} material inputs were not reflected`);
    }
    for (const name of names) {
      const input = definitions?.find((candidate) => candidate.name === name);
      if (input === undefined) {
        throw new Error(`renderer ${rendererIndex} material input ${name} was not reflected`);
      }
      maxLanes = Math.max(maxLanes, input.lane + 1);
      const customField = custom?.fields.find((field) => field.name === input.name);
      const coreField = VFX_PARTICLE_CORE_LAYOUT.fields.find((field) => field.name === input.name);
      if (customField !== undefined) {
        cases.push({ rendererIndex, input, source: 'custom', fieldType: customField.type });
      } else if (coreField !== undefined) {
        cases.push({ rendererIndex, input, source: 'core', fieldType: coreField.type });
      } else {
        throw new Error(`renderer ${rendererIndex} material input ${name} has no particle field`);
      }
    }
  }
  const body = cases
    .map((entry) => {
      const expression =
        entry.source === 'custom'
          ? `forgeax_vfx_custom[index].${entry.input.name}`
          : `particle.${entry.input.name}`;
      const value = materialInputValue(expression, entry.fieldType, entry.input.type);
      if (value === undefined) {
        throw new Error(
          `renderer ${entry.rendererIndex} material input ${entry.input.name} has incompatible field type`,
        );
      }
      return `  if (forgeax_vfx_runtime.topology.x == ${entry.rendererIndex}u && lane == ${entry.input.lane}u) {\n    return ${value};\n  }`;
    })
    .filter((line) => line.length > 0)
    .join('\n');
  return {
    maxLanes,
    wgsl: `\nfn forgeax_vfx_material_input(index: u32, lane: u32) -> vec4<f32> {\n  let particle = forgeax_vfx_particles[index];\n${body}\n  return vec4<f32>(0.0);\n}\n`,
  };
}

function replaceParticleMaterialWrites(runtime: string, maxLanes: number, offset: number): string {
  const block = `  if (materialLanes > 0u) {
    forgeax_vfx_billboard_instances[base + ${offset}u] = particle.material_random;
    forgeax_vfx_billboard_instances[base + ${offset + 1}u] = particle.material_random;
    forgeax_vfx_billboard_instances[base + ${offset + 2}u] = particle.material_random;
    forgeax_vfx_billboard_instances[base + ${offset + 3}u] = particle.material_random;
  }`;
  const limit = Math.max(1, Math.min(4, maxLanes));
  const replacement = `  if (materialLanes > 0u) {
    var materialLane = 0u;
    loop {
      if (materialLane >= materialLanes || materialLane >= ${limit}u) { break; }
      let materialValue = forgeax_vfx_material_input(forgeax_vfx_alive_indices[rank], materialLane);
      let materialOffset = base + ${offset}u + materialLane * 4u;
      forgeax_vfx_billboard_instances[materialOffset] = materialValue.x;
      forgeax_vfx_billboard_instances[materialOffset + 1u] = materialValue.y;
      forgeax_vfx_billboard_instances[materialOffset + 2u] = materialValue.z;
      forgeax_vfx_billboard_instances[materialOffset + 3u] = materialValue.w;
      materialLane += 1u;
    }
  }`;
  return runtime.replaceAll(block, replacement);
}

function singleBlockParticleRuntime(runtime: string, capacity: number): string {
  if (capacity > 256) return runtime;
  const update =
    '@compute @workgroup_size(256)\nfn forgeax_vfx_update_main(@builtin(global_invocation_id) invocation: vec3<u32>)';
  const scan = `@compute @workgroup_size(256)
fn forgeax_vfx_scan_blocks_main(
  @builtin(global_invocation_id) invocation: vec3<u32>,
  @builtin(local_invocation_id) local: vec3<u32>,
  @builtin(workgroup_id) group: vec3<u32>,
)`;
  const compact =
    '@compute @workgroup_size(256)\nfn forgeax_vfx_compact_main(@builtin(global_invocation_id) invocation: vec3<u32>)';
  return (
    runtime
      .replace(update, 'fn forgeax_vfx_update_particle(invocation: vec3<u32>)')
      .replace(
        scan,
        'fn forgeax_vfx_scan_block(invocation: vec3<u32>, local: vec3<u32>, group: vec3<u32>)',
      )
      .replace(compact, 'fn forgeax_vfx_compact_particle(invocation: vec3<u32>)') +
    `

@compute @workgroup_size(256)
fn forgeax_vfx_update_main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  forgeax_vfx_update_particle(invocation);
}
@compute @workgroup_size(256)
fn forgeax_vfx_scan_blocks_main(
  @builtin(global_invocation_id) invocation: vec3<u32>,
  @builtin(local_invocation_id) local: vec3<u32>,
  @builtin(workgroup_id) group: vec3<u32>,
) {
  forgeax_vfx_scan_block(invocation, local, group);
}
@compute @workgroup_size(256)
fn forgeax_vfx_compact_main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  forgeax_vfx_compact_particle(invocation);
}
@compute @workgroup_size(256)
fn forgeax_vfx_scan_compact_main(
  @builtin(global_invocation_id) invocation: vec3<u32>,
  @builtin(local_invocation_id) local: vec3<u32>,
  @builtin(workgroup_id) group: vec3<u32>,
) {
  forgeax_vfx_scan_block(invocation, local, group);
  storageBarrier();
  forgeax_vfx_compact_particle(invocation);
}
@compute @workgroup_size(256)
fn forgeax_vfx_update_compact_main(
  @builtin(global_invocation_id) invocation: vec3<u32>,
  @builtin(local_invocation_id) local: vec3<u32>,
  @builtin(workgroup_id) group: vec3<u32>,
) {
  // Every lane reaches both storage barriers, including inactive particles.
  // One workgroup covers the entire emitter, matching dispatch boundaries.
  forgeax_vfx_update_particle(invocation);
  storageBarrier();
  forgeax_vfx_scan_block(invocation, local, group);
  storageBarrier();
  forgeax_vfx_compact_particle(invocation);
}`
  );
}

function createParticleManagedRuntimeV3(options: {
  readonly capacity: number;
  readonly custom: import('@forgeax/engine-vfx').VfxCustomLayout | undefined;
  readonly parameters: boolean;
  readonly customHook: boolean;
  readonly renderers: readonly VfxGpuRendererReflectionV3[];
}): string {
  const custom = options.custom;
  const materialInputs = createParticleMaterialInputRuntime(custom, options.renderers);
  const rendererAttributes = createParticleRendererAttributeRuntime(custom, options.renderers);
  const declarations = [
    options.parameters
      ? '@group(0) @binding(10) var<uniform> forgeax_vfx_parameters: VfxParameters;'
      : '',
    custom === undefined || custom.stride === 0
      ? ''
      : '@group(0) @binding(11) var<storage, read_write> forgeax_vfx_custom: array<VfxCustom>;',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
  let runtime = PARTICLE_MANAGED_RUNTIME_V3.replace(
    PARTICLE_SORT_MAIN_V3,
    particleSortRuntime(options.capacity),
  );
  if (declarations.length > 0) runtime = `${declarations}\n${runtime}`;
  if (custom !== undefined && custom.stride > 0) {
    const initial = `var custom = VfxCustom(${custom.fields.map((field) => wgslDefault(field.type)).join(', ')});`;
    runtime = runtime
      .replace(
        '      let ctx = VfxSpawnContext(',
        `      ${initial}\n      let ctx = VfxSpawnContext(`,
      )
      .replace(
        '      vfx_spawn(ctx, &particle);\n      forgeax_vfx_particles[index] = particle;',
        options.customHook
          ? '      vfx_spawn(ctx, &particle, &custom);\n      forgeax_vfx_particles[index] = particle;\n      forgeax_vfx_custom[index] = custom;'
          : '      vfx_spawn(ctx, &particle);\n      forgeax_vfx_particles[index] = particle;\n      forgeax_vfx_custom[index] = custom;',
      )
      .replace(
        '  var particle = forgeax_vfx_particles[index];\n  if (forgeax_vfx_scratch[index] == 0u) { return; }',
        '  var particle = forgeax_vfx_particles[index];\n  var custom = forgeax_vfx_custom[index];\n  if (forgeax_vfx_scratch[index] == 0u) { return; }',
      )
      .replace(
        '  vfx_update(ctx, &particle);',
        options.customHook
          ? '  vfx_update(ctx, &particle, &custom);'
          : '  vfx_update(ctx, &particle);',
      )
      .replace(
        '  forgeax_vfx_particles[index] = particle;\n}',
        '  forgeax_vfx_particles[index] = particle;\n  forgeax_vfx_custom[index] = custom;\n}',
      );
  }
  runtime = runtime.replace(
    `fn forgeax_vfx_custom_sort_key(index: u32) -> f32 {\n  // The generated emitter runtime replaces this implementation when a\n  // renderer declares a reflected VfxCustom sort key. Keeping a valid default\n  // lets emitters without Custom storage share the same managed program.\n  _ = index;\n  return 0.0;\n}`,
    `fn forgeax_vfx_custom_sort_key(index: u32) -> f32 {\n  return forgeax_vfx_renderer_sort(index);\n}`,
  );
  runtime = replaceParticleMaterialWrites(runtime, materialInputs.maxLanes, 31);
  runtime = replaceParticleMaterialWrites(runtime, materialInputs.maxLanes, 18);
  runtime = replaceParticleMaterialWrites(runtime, materialInputs.maxLanes, 12);
  const meshControls = `fn forgeax_vfx_mesh_controls(renderer: u32) -> vec2<f32> {
    switch renderer {
      ${options.renderers
        .map((renderer, index) =>
          renderer.topology === 'mesh'
            ? `case ${index}u: { return vec2<f32>(${renderer.lighting === 'unlit' ? '0.0' : '1.0'}, ${renderer.receiveShadows === false ? '0.0' : '1.0'}); }`
            : '',
        )
        .join('\n')}
      default: { return vec2<f32>(0.0); }
    }
  }`;
  const generatedHelpers = `${rendererAttributes}\n${materialInputs.wgsl}\n${meshControls}`;
  const marker = '@compute @workgroup_size(256)\nfn forgeax_vfx_spawn_main';
  runtime = runtime.replace(marker, `${generatedHelpers}\n${marker}`);
  return singleBlockParticleRuntime(runtime, options.capacity);
}

export interface ParticleCodeModuleSet {
  readonly entry: string;
  readonly imports?: Readonly<Record<string, string>>;
}

/** The runtime GPU program before its canonical bytes are fingerprinted. */
export type ParticleCodeProgram = Omit<VfxGpuProgramV3, 'fingerprint'>;

export interface ParticleCodeProgramArtifact {
  readonly artifactKey: typeof PARTICLE_CODE_PROGRAM_ARTIFACT_KEY;
  readonly mimeType: 'application/vnd.forgeax.vfx-program+json';
  readonly bytes: Uint8Array;
  readonly fingerprint: string;
  readonly program: ParticleCodeProgram;
}

export interface ParticleCodeEffectPayload extends ParticleEffectAssetV3 {}

export interface ParticleCodeCookProduct {
  readonly asset: ParticleCodeEffectPayload;
  readonly artifact: ParticleCodeProgramArtifact;
  readonly refs: readonly string[];
}

export interface ParticleCodeNativeCookInput {
  readonly guid: string;
  readonly source: unknown;
}

function readParticleCodeModules(root: string): Record<string, ParticleCodeModuleSet> {
  const modules: Record<string, ParticleCodeModuleSet> = {};
  const rootInfo = statSync(root);
  if (rootInfo.isFile()) {
    if (root.endsWith('.vfx.wgsl')) {
      modules[basename(root)] = { entry: readFileSync(root, 'utf8') };
    }
    return modules;
  }
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && entry.name.endsWith('.vfx.wgsl')) {
        if (modules[entry.name] !== undefined) {
          throw new Error(`duplicate VFX module ${entry.name} under ${root}`);
        }
        modules[entry.name] = { entry: readFileSync(path, 'utf8') };
      }
    }
  };
  visit(root);
  return modules;
}

export function createParticleCodeNativeCookerFromRoots(
  roots: readonly string[],
  materials?: ParticleMaterialInputCatalog,
): NativeCooker<ParticleCodeEffectPayload, ParticleCodeNativeCookInput> {
  const modules = roots.reduce<Record<string, ParticleCodeModuleSet>>((all, root) => {
    for (const [name, module] of Object.entries(readParticleCodeModules(root))) {
      if (all[name] !== undefined) throw new Error(`duplicate VFX module ${name}`);
      all[name] = module;
    }
    return all;
  }, {});
  return createParticleCodeNativeCooker(modules, materials);
}

export interface ParticleCodeCompileError {
  readonly code:
    | 'vfx-hook-missing'
    | 'vfx-hook-invalid'
    | 'vfx-reserved-surface-conflict'
    | 'vfx-module-missing'
    | 'vfx-shader-invalid'
    | VfxReflectionError['code']
    | ParticleStagePlanError['code'];
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly emitterId: string;
    readonly module?: string;
    readonly hook?: 'vfx_spawn' | 'vfx_update';
    readonly causeCode?: string;
    readonly cause?: unknown;
  };
}

export type ParticleCodeCookError =
  | ParticleCodeSourceError
  | ParticleCodeCompileError
  | VfxReflectionError
  | ParticleStagePlanError;

function compileError(
  code: ParticleCodeCompileError['code'],
  emitterId: string,
  expected: string,
  hint: string,
  detail: Omit<ParticleCodeCompileError['detail'], 'emitterId'> = {},
): ParticleCodeCompileError {
  return { code, expected, hint, detail: { emitterId, ...detail } };
}

async function compileEmitterV3(
  emitter: ParticleEmitterSourceV3,
  modules: Readonly<Record<string, ParticleCodeModuleSet>>,
  materials?: ParticleMaterialInputCatalog,
): Promise<Result<VfxGpuEmitterProgramV3, ParticleCodeCookError>> {
  const moduleId = emitter.program.module;
  const module =
    modules[moduleId] ??
    (moduleId === PARTICLE_CODE_DEFAULT_MODULE_ID
      ? { entry: PARTICLE_CODE_DEFAULT_MODULE }
      : undefined);
  if (module === undefined) {
    return err(
      compileError(
        'vfx-module-missing',
        emitter.id,
        `a readable WGSL module named ${moduleId}`,
        `add ${moduleId} to the shader source catalog and recook`,
        { module: moduleId },
      ),
    );
  }
  const authoredEntryCode = module.entry;
  const entryCode = stripWgslComments(authoredEntryCode);
  if (RESERVED.test(entryCode)) {
    return err(
      compileError(
        'vfx-reserved-surface-conflict',
        emitter.id,
        'author code without bindings, shader stages, or forgeax_vfx_* symbols',
        'remove the reserved declaration; implement only v3 vfx_spawn and vfx_update',
        { module: moduleId },
      ),
    );
  }
  for (const [importId, source] of Object.entries(module.imports ?? {})) {
    if (RESERVED.test(stripWgslComments(source))) {
      return err(
        compileError(
          'vfx-reserved-surface-conflict',
          emitter.id,
          'author imports without bindings, shader stages, or forgeax_vfx_* symbols',
          `remove the reserved declaration from ${importId} and recook`,
          { module: importId },
        ),
      );
    }
  }
  const customRequested =
    /\bstruct\s+VfxCustom\b/.test(entryCode) ||
    Object.values(module.imports ?? {}).some((source) => /\bstruct\s+VfxCustom\b/.test(source));
  const spawnValid = REQUIRED_SPAWN_V3.test(entryCode);
  const updateValid = REQUIRED_UPDATE_V3.test(entryCode);
  const hookSignature = (name: 'vfx_spawn' | 'vfx_update'): string => {
    const match = new RegExp(`\\bfn\\s+${name}\\s*\\([^)]*\\)`).exec(entryCode);
    return match?.[0] ?? '';
  };
  const spawnCustomHook = hookSignature('vfx_spawn').includes('VfxCustom');
  const updateCustomHook = hookSignature('vfx_update').includes('VfxCustom');
  const customHook = spawnCustomHook && updateCustomHook;
  if (!spawnValid || (customRequested && !spawnCustomHook)) {
    return err(
      compileError(
        entryCode.includes('vfx_spawn') ? 'vfx-hook-invalid' : 'vfx-hook-missing',
        emitter.id,
        customRequested
          ? 'fn vfx_spawn(ctx, particle, custom) with VfxCustom ptr'
          : 'fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>)',
        'add the exact v3 vfx_spawn hook signature and recook',
        { hook: 'vfx_spawn', module: moduleId },
      ),
    );
  }
  if (!updateValid || (customRequested && !updateCustomHook)) {
    return err(
      compileError(
        entryCode.includes('vfx_update') ? 'vfx-hook-invalid' : 'vfx-hook-missing',
        emitter.id,
        customRequested
          ? 'fn vfx_update(ctx, particle, custom) with VfxCustom ptr'
          : 'fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>)',
        'add the exact v3 vfx_update hook signature and recook',
        { hook: 'vfx_update', module: moduleId },
      ),
    );
  }
  const stagePlan = buildParticleStagePlan(authoredEntryCode);
  if (!stagePlan.ok) return stagePlan;
  const layout = reflectVfxLayout(
    module.imports === undefined
      ? { root: authoredEntryCode }
      : { root: authoredEntryCode, imports: module.imports },
  );
  if (!layout.ok) return layout;
  const renderers = reflectVfxRendererV3(emitter.renderers, materials, layout.value);
  if (!renderers.ok) return renderers;
  const dataInterfaces = layout.value.dataInterfaces ?? [];
  if (
    dataInterfaces.some((entry) => entry.kind === 'force-fields') !==
    (emitter.forceFields !== undefined)
  ) {
    return err(
      compileError(
        'vfx-shader-invalid',
        emitter.id,
        'forceFields and the force_fields DI import to be declared together',
        'declare both the bounded source fields and forgeax_vfx::data::force_fields import, or remove both',
        { module: moduleId },
      ),
    );
  }
  const imports = {
    ...(module.imports ?? {}),
    [PARTICLE_CODE_PRELUDE_MODULE_ID]: PARTICLE_CODE_PRELUDE,
    ...Object.fromEntries(
      Object.entries(PARTICLE_CODE_DATA_INTERFACE_MODULES).filter(
        ([name]) =>
          name.endsWith('camera') ||
          name.endsWith('scene_depth') ||
          name.endsWith('noise') ||
          name.endsWith('scene_sdf') ||
          name.endsWith('force_fields'),
      ),
    ),
  };
  const managed = createParticleManagedRuntimeV3({
    capacity: emitter.capacity,
    parameters: layout.value.parameters.fields.length > 0,
    custom: layout.value.customLayout,
    customHook,
    renderers: renderers.value,
  });
  const hasEvents = (emitter.channels?.length ?? 0) > 0 || (emitter.events?.length ?? 0) > 0;
  const custom = layout.value.customLayout;
  const eventRuntime = !hasEvents
    ? ''
    : custom === undefined || custom.stride === 0
      ? PARTICLE_EVENT_MANAGED_RUNTIME
      : PARTICLE_EVENT_MANAGED_RUNTIME.replace(
          '    forgeax_vfx_particles[childParticleIndex] = child;',
          `    forgeax_vfx_particles[childParticleIndex] = child;\n    forgeax_vfx_custom[childParticleIndex] = VfxCustom(${custom.fields.map((field) => wgslDefault(field.type)).join(', ')});`,
        );
  const compiled = await compileParticleShader(
    `${module.entry}\n${managed}\n${createParticleDataInterfaceRuntimeV3(dataInterfaces)}\n${createParticleStageManagedRuntime(stagePlan.value)}\n${eventRuntime}`,
    {
      id: `forgeax_vfx_effect_v3::${emitter.id}`,
      imports: imports as Record<string, string>,
    },
  );
  if (!compiled.ok) {
    return err(
      compileError(
        'vfx-shader-invalid',
        emitter.id,
        'WGSL hooks that compose and validate against the managed Program v3 ABI',
        'inspect causeCode, repair the WGSL module/import, and recook',
        {
          module: moduleId,
          causeCode: compiled.error.code,
          cause: {
            message: compiled.error.message,
            hint: compiled.error.hint,
            lineNum: compiled.error.lineNum,
            linePos: compiled.error.linePos,
            detail: compiled.error.detail,
          },
        },
      ),
    );
  }
  if (emitter.forceFields !== undefined) {
    const storageBindings = compiled.value.bindings
      .flatMap((group) => group.entries)
      .filter(
        (entry) =>
          (entry.visibility & 4) !== 0 &&
          (entry.buffer?.type === 'storage' || entry.buffer?.type === 'read-only-storage'),
      ).length;
    if (storageBindings > 8)
      return err(
        compileError(
          'vfx-shader-invalid',
          emitter.id,
          'at most eight compute storage bindings on the portable managed field path',
          'split custom/event work into another emitter rather than exceeding the guaranteed WebGPU limit',
          { module: moduleId, cause: { storageBindings } },
        ),
      );
  }
  const resources = [
    'particles',
    'runtime',
    'aliveIndices',
    'counters',
    'indirect',
    'scratch',
    'billboardInstances',
    ...(layout.value.parameters.fields.length > 0 ? ['parameters'] : []),
    ...(layout.value.customLayout?.stride === 0 || layout.value.customLayout === undefined
      ? []
      : ['custom']),
    ...(dataInterfaces.length > 0 ? dataInterfaces.map((entry) => entry.kind) : []),
    ...(hasEvents ? ['eventBuffer'] : []),
  ];
  const program: VfxGpuEmitterProgramV3 = {
    id: emitter.id,
    module: moduleId,
    capacity: emitter.capacity,
    backend: emitter.backend,
    space: emitter.space,
    ...(emitter.forceFields === undefined ? {} : { forceFields: emitter.forceFields }),
    schedule: emitter.schedule,
    bounds: emitter.bounds,
    renderers: emitter.renderers,
    channels: Object.freeze([...(emitter.channels ?? [])]),
    events: Object.freeze([...(emitter.events ?? [])]),
    simulationWhenCulled: emitter.simulationWhenCulled ?? 'continue',
    wgsl: compiled.value.wgsl,
    reflection: {
      hooks: ['vfx_spawn', 'vfx_update'],
      imports: Object.freeze([...compiled.value.deps].sort()),
      resources: Object.freeze(resources),
      entryPoints: [
        'forgeax_vfx_spawn_main',
        'forgeax_vfx_update_main',
        'forgeax_vfx_scan_blocks_main',
        'forgeax_vfx_scan_block_offsets_main',
        'forgeax_vfx_add_offsets_main',
        'forgeax_vfx_compact_main',
        'forgeax_vfx_sort_main',
        ...(emitter.capacity <= 256
          ? ['forgeax_vfx_scan_compact_main', 'forgeax_vfx_update_compact_main']
          : []),
        ...(hasEvents ? ['forgeax_vfx_event_main'] : []),
        'forgeax_vfx_billboard_main',
        'forgeax_vfx_mesh_main',
        'forgeax_vfx_ribbon_main',
        'forgeax_vfx_trail_history_main',
        'forgeax_vfx_trail_offsets_main',
        'forgeax_vfx_trail_main',
        'forgeax_vfx_beam_main',
        ...stagePlan.value.stages.map((stage) => stage.entryPoint),
      ],
      bindings: compiled.value.bindings,
      layout: layout.value,
      dataInterfaces,
      eventChannels: Object.freeze([...(emitter.channels ?? [])]),
      events: Object.freeze([...(emitter.events ?? [])]),
      eventEntryPoint: 'forgeax_vfx_event_main',
      stages: Object.freeze(stagePlan.value.stages),
      renderers: renderers.value,
    },
  };
  // The base ABI permits arbitrary hook reads. A multi-instance contract only
  // follows hooks that cannot name the managed storage/runtime namespace;
  // shader immutability or a matching reflection alone does not prove that.
  const instanceIsolated =
    !/\bforgeax_vfx_/.test(entryCode) &&
    Object.values(module.imports ?? {}).every(
      (source) => !/\bforgeax_vfx_/.test(stripWgslComments(source)),
    );
  const instanceCompute = instanceIsolated ? createVfxInstanceComputeProgram(program) : undefined;
  if (instanceCompute === undefined) return ok(program);
  const validatedBatch = await compileParticleShader(instanceCompute.wgsl, {
    id: `forgeax_vfx_instance_v1::${emitter.id}`,
    imports: {},
  });
  if (!validatedBatch.ok)
    return err(
      compileError(
        'vfx-shader-invalid',
        emitter.id,
        'a valid managed multi-instance compute program',
        'repair the managed job ABI compiler before recooking',
        { module: moduleId, causeCode: validatedBatch.error.code, cause: validatedBatch.error },
      ),
    );
  return ok({
    ...program,
    instanceCompute: {
      ...instanceCompute,
      wgsl: validatedBatch.value.wgsl,
      bindings: validatedBatch.value.bindings,
    },
  });
}

/** Deterministic Program v3 cook path. Older callers are rejected at parsing. */
export async function cookParticleCodeProgram(
  sourceValue: unknown,
  modules: Readonly<Record<string, ParticleCodeModuleSet>>,
  materials?: ParticleMaterialInputCatalog,
): Promise<Result<ParticleCodeProgramArtifact, ParticleCodeCookError>> {
  const parsed = parseParticleEffectSourceV3(sourceValue);
  if (!parsed.ok) return parsed;
  const emitters: VfxGpuEmitterProgramV3[] = [];
  for (const emitter of parsed.value.emitters) {
    const compiled = await compileEmitterV3(emitter, modules, materials);
    if (!compiled.ok) return compiled;
    emitters.push(compiled.value);
  }
  const program: ParticleCodeProgram = {
    format: PARTICLE_CODE_PROGRAM_FORMAT,
    emitters,
  };
  const bytes = new TextEncoder().encode(canonical(program));
  return ok({
    artifactKey: PARTICLE_CODE_PROGRAM_ARTIFACT_KEY,
    mimeType: 'application/vnd.forgeax.vfx-program+json',
    bytes,
    fingerprint: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    program,
  });
}

/** Material artifact metadata supplied to the VFX cook boundary. */
export type ParticleMaterialInputCatalog = Readonly<
  Record<string, readonly MaterialParticleInput[]>
>;

export async function cookParticleCodeEffect(
  sourceValue: unknown,
  modules: Readonly<Record<string, ParticleCodeModuleSet>>,
  materials?: ParticleMaterialInputCatalog,
): Promise<Result<ParticleCodeCookProduct, ParticleCodeCookError>> {
  const artifact = await cookParticleCodeProgram(sourceValue, modules, materials);
  if (!artifact.ok) return artifact;
  const refs = new Set<string>();
  for (const emitter of artifact.value.program.emitters) {
    for (const field of emitter.forceFields ?? [])
      if (field.kind === 'vector' && typeof field.texture === 'string') refs.add(field.texture);
    for (const renderer of emitter.renderers) {
      if (typeof renderer.material === 'string') refs.add(renderer.material);
      if (renderer.kind === 'mesh' && typeof renderer.mesh === 'string') refs.add(renderer.mesh);
    }
  }
  return ok({
    asset: {
      kind: 'particle-effect',
      schemaVersion: 3,
      programFingerprint: artifact.value.fingerprint,
      emitters: artifact.value.program.emitters.map(({ id, capacity }) => ({ id, capacity })),
      program: {
        format: PARTICLE_CODE_PROGRAM_FORMAT,
        fingerprint: artifact.value.fingerprint,
        emitters: artifact.value.program.emitters,
      },
    },
    artifact: artifact.value,
    refs: Object.freeze([...refs].sort()),
  });
}

/** Native cooker adapter for the executable Program v3 payload. */
export function createParticleCodeNativeCooker(
  modules: Readonly<Record<string, ParticleCodeModuleSet>>,
  materials?: ParticleMaterialInputCatalog,
): NativeCooker<ParticleCodeEffectPayload, ParticleCodeNativeCookInput> {
  return {
    key: 'particle-effect',
    concurrency: 'parallel',
    async cacheIdentity() {
      const native = await getShaderCompilerFingerprint();
      if (!native.ok) throw native.error;
      const hash = createHash('sha256')
        .update('particle-code-cooker/1\0')
        .update(VFX_INSTANCE_COMPUTE_COMPILER_SOURCE)
        .update(createVfxInstanceComputeProgram.toString())
        .update(native.value)
        .update('\0')
        .update(canonical({ modules, materials: materials ?? null }));
      // Source distributions have no release version. Hash the executing
      // compiler and its public runtime dependencies, including the native ABI.
      for (const url of [
        import.meta.url,
        import.meta.resolve('@forgeax/engine-shader-compiler'),
        import.meta.resolve('@forgeax/engine-vfx'),
        import.meta.resolve('@forgeax/engine-types'),
      ]) {
        hash.update('\0').update(readFileSync(fileURLToPath(url)));
      }
      return `sha256:${hash.digest('hex')}`;
    },
    async cook({ guid, source }) {
      const cooked = await cookParticleCodeEffect(source, modules, materials);
      if (!cooked.ok) throw new Error(cooked.error.hint);
      return {
        guid,
        payload: cooked.value.asset,
        refs: cooked.value.refs,
        artifacts: {
          [cooked.value.artifact.artifactKey]: {
            mediaType: cooked.value.artifact.mimeType,
            bytes: cooked.value.artifact.bytes,
          },
        },
        inputFingerprint: cooked.value.artifact.fingerprint,
      };
    },
  };
}
