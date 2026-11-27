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
import type { ParticleEffectSourceV3, ParticleEmitterSourceV3 } from '@forgeax/engine-vfx';
import {
  PARTICLE_CODE_DEFAULT_MODULE_ID,
  type ParticleAttributeRef,
  type ParticleCodeSourceError,
  type ParticleRendererSemantic,
  parseParticleEffectSourceV3,
  VFX_PARTICLE_CORE_LAYOUT,
  type VfxDataInterfaceRequirement,
  type VfxGpuEmitterProgram,
  type VfxGpuProgram,
  type VfxGpuRendererReflection,
  type VfxValueType,
} from '@forgeax/engine-vfx';
import { VFX_FORCE_FIELDS_WGSL } from './force-fields.js';
import { GPU_EVENT_OUTPUT_RUNTIME_WGSL } from './gpu-event-output.js';
import { createGpuSlotAllocatorRuntime, GPU_SLOT_ALLOCATOR_ENTRY } from './gpu-slot-allocator.js';
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
import { WATER_SURFACE_RUNTIME_WGSL } from './water-surface.js';

// Build-host lifetime, bounded by the shared compiler's 128-entry / 16 MiB budget.
// Every cook still validates source metadata and derives a fresh artifact.
const compileParticleShader = createShaderProgramCompiler();

/** The single public cooked-program ABI. */
export const PARTICLE_CODE_PROGRAM_FORMAT = 'forgeax-vfx-program-5' as const;
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
  time: f32,
  time_whole: u32,
  time_fract: f32,
  world_time: f32,
  world_time_whole: u32,
  world_time_fract: f32,
}

struct VfxUpdateContext {
  delta: f32,
  tick: u32,
  seed: u32,
  playCycle: u32,
  particleId: u32,
  time: f32,
  time_whole: u32,
  time_fract: f32,
  world_time: f32,
  world_time_whole: u32,
  world_time_fract: f32,
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

// Lifetime for a particle that never expires (continuous effects). Prefer this
// over an arbitrary huge literal; derive looping visuals from ctx.time via
// vfx_loop_phase, not from particle.age.
fn vfx_forever() -> f32 {
  return 3.0e38;
}

// Exact looping phase fract(rate * t + offset) for t = whole + fract seconds.
// rate is in cycles per second. The whole-second part is multiplied in u32
// fixed point (wrapping), so the result stays exact after hours of play where
// a plain f32 time loses frame resolution.
fn vfx_loop_phase(whole: u32, frac: f32, rate: f32, offset: f32) -> f32 {
  let rateWhole = floor(rate);
  let rateFract = rate - rateWhole;
  let fixed = u32(rateFract * 4294967296.0);
  let wholePhase = f32((fixed * whole) >> 8u) / 16777216.0;
  return fract(wholePhase + rate * frac + offset);
}

// Same as vfx_loop_phase, in radians (0 .. 2*pi), for sin/cos driven motion.
fn vfx_loop_angle(whole: u32, frac: f32, rate: f32, offset: f32) -> f32 {
  return vfx_loop_phase(whole, frac, rate, offset) * 6.283185307179586;
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
  'forgeax_vfx::data': `#define_import_path forgeax_vfx::data
@group(0) @binding(26) var<storage, read> structured_input: array<vec4<u32>>;
`,
  'forgeax_vfx::data::gpu_events': '#define_import_path forgeax_vfx::data::gpu_events\n',
  'forgeax_vfx::data::water_displacement':
    '#define_import_path forgeax_vfx::data::water_displacement\n',
  'forgeax_vfx::data::water_hull': '#define_import_path forgeax_vfx::data::water_hull\n',
  'forgeax_vfx::data::water_config': '#define_import_path forgeax_vfx::data::water_config\n',
  'forgeax_vfx::data::scene_sdf': '#define_import_path forgeax_vfx::data::scene_sdf\n',
  'forgeax_vfx::data::force_fields': '#define_import_path forgeax_vfx::data::force_fields\n',
  'forgeax_vfx::data::water_surface': '#define_import_path forgeax_vfx::data::water_surface\n',
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
  timeFract: f32,
  timeWhole: u32,
  worldTimeFract: f32,
  worldTimeWhole: u32,
}

struct ForgeaxVfxCounters {
  aliveCount: atomic<u32>,
  droppedCount: atomic<u32>,
  eventProduced: atomic<u32>,
  eventConsumed: atomic<u32>,
  eventDropped: atomic<u32>,
  eventOverflow: atomic<u32>,
  gridEmissionCount: atomic<u32>,
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

// Replaced by the Water-grid implementation only for emitters that declare
// waterGridEmission. The zero-count stub preserves the ordinary spawn ABI.
fn forgeax_vfx_water_spawn_count() -> u32 {
  return atomicLoad(&forgeax_vfx_counters.gridEmissionCount);
}
fn forgeax_vfx_water_initialize_particle(
  particle: ptr<function, VfxParticle>,
  isGridSpawn: bool,
  spawnRank: u32,
  ctx: VfxSpawnContext,
) {
  _ = particle;
  _ = isGridSpawn;
  _ = spawnRank;
  _ = ctx;
}
fn forgeax_vfx_water_update_particle(
  particle: ptr<function, VfxParticle>,
) {
  _ = particle;
}
fn forgeax_vfx_water_apply_acceleration(
  particle: ptr<function, VfxParticle>,
  ctx: VfxUpdateContext,
) {
  _ = particle;
  _ = ctx;
}

@compute @workgroup_size(256)
fn forgeax_vfx_spawn_main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index >= forgeax_vfx_runtime.capacity) { return; }
  if (forgeax_vfx_scratch[index] == 0u) {
    let deadRank = index - forgeax_vfx_scratch[forgeax_vfx_runtime.capacity + index];
    let waterSpawnCount = forgeax_vfx_water_spawn_count();
    let totalSpawnCount = forgeax_vfx_runtime.spawnCount + waterSpawnCount;
    if (deadRank < totalSpawnCount) {
      let isGridSpawn = deadRank >= forgeax_vfx_runtime.spawnCount;
      let spawnRank = select(deadRank, deadRank - forgeax_vfx_runtime.spawnCount, isGridSpawn);
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
        select(
          particle.id,
          forgeax_vfx_runtime.firstParticleId + forgeax_vfx_runtime.spawnCount + spawnRank,
          isGridSpawn,
        ),
        f32(forgeax_vfx_runtime.timeWhole) + forgeax_vfx_runtime.timeFract,
        forgeax_vfx_runtime.timeWhole,
        forgeax_vfx_runtime.timeFract,
        f32(forgeax_vfx_runtime.worldTimeWhole) + forgeax_vfx_runtime.worldTimeFract,
        forgeax_vfx_runtime.worldTimeWhole,
        forgeax_vfx_runtime.worldTimeFract,
      );
      particle.id = ctx.particleId;
      vfx_spawn(ctx, &particle);
      forgeax_vfx_particles[index] = particle;
      forgeax_vfx_scratch[index] = 1u;
    }
  }
  if (index == 0u) {
    let freeCount = forgeax_vfx_runtime.capacity - atomicLoad(&forgeax_vfx_counters.aliveCount);
    let totalSpawnCount = forgeax_vfx_runtime.spawnCount + forgeax_vfx_water_spawn_count();
    atomicAdd(
      &forgeax_vfx_counters.droppedCount,
      totalSpawnCount - min(totalSpawnCount, freeCount),
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
    f32(forgeax_vfx_runtime.timeWhole) + forgeax_vfx_runtime.timeFract,
    forgeax_vfx_runtime.timeWhole,
    forgeax_vfx_runtime.timeFract,
    f32(forgeax_vfx_runtime.worldTimeWhole) + forgeax_vfx_runtime.worldTimeFract,
    forgeax_vfx_runtime.worldTimeWhole,
    forgeax_vfx_runtime.worldTimeFract,
  );
  forgeax_vfx_water_apply_acceleration(&particle, ctx);
  vfx_update(ctx, &particle);
  particle.age += forgeax_vfx_runtime.delta;
  forgeax_vfx_water_update_particle(&particle);
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
    kinds.has('water-config') && kinds.has('water-hull') && kinds.has('water-displacement')
      ? WATER_SURFACE_RUNTIME_WGSL
      : '',
    kinds.has('gpu-events') ? GPU_EVENT_OUTPUT_RUNTIME_WGSL : '',
    kinds.has('force-fields') ? VFX_FORCE_FIELDS_WGSL : '',
    kinds.has('camera')
      ? '@group(0) @binding(12) var<uniform> forgeax_vfx_camera: mat4x4<f32>;'
      : '',
    kinds.has('scene-depth')
      ? '@group(0) @binding(13) var forgeax_vfx_scene_depth: texture_depth_2d;'
      : '',
    kinds.has('noise') ? '@group(0) @binding(14) var forgeax_vfx_noise: texture_2d<f32>;' : '',
    kinds.has('scene-sdf') ? SCENE_SDF_RUNTIME_WGSL : '',
    kinds.has('water-surface')
      ? `@group(0) @binding(18) var forgeax_vfx_water_grid: texture_2d<f32>;
@group(0) @binding(19) var forgeax_vfx_water_solver_normal: texture_2d<f32>;
struct VfxWaterSurfaceDomain {
  origin: vec4<f32>,
  spacing_resolution: vec4<f32>,
  rotation: vec4<f32>,
}
@group(0) @binding(20) var<uniform> forgeax_vfx_water_surface_domain: VfxWaterSurfaceDomain;
fn vfx_water_surface_resolution() -> vec2<u32> {
  return vec2<u32>(forgeax_vfx_water_surface_domain.spacing_resolution.zw);
}
fn vfx_water_surface_grid_cell(cell: vec2<i32>) -> vec4<f32> {
  let size = vec2<i32>(vfx_water_surface_resolution());
  return textureLoad(forgeax_vfx_water_grid, clamp(cell, vec2<i32>(0), size - 1), 0);
}
fn vfx_water_surface_solver_normal_cell(cell: vec2<i32>) -> vec3<f32> {
  let size = vec2<i32>(vfx_water_surface_resolution());
  return textureLoad(forgeax_vfx_water_solver_normal, clamp(cell, vec2<i32>(0), size - 1), 0).xyz;
}
fn vfx_water_surface_grid(uv: vec2<f32>) -> vec4<f32> {
  let size = vec2<i32>(textureDimensions(forgeax_vfx_water_grid));
  let coordinate = clamp(vec2<i32>(uv * vec2<f32>(size)), vec2<i32>(0), size - 1);
  return textureLoad(forgeax_vfx_water_grid, coordinate, 0);
}
fn vfx_water_surface_solver_normal(uv: vec2<f32>) -> vec3<f32> {
  let size = vec2<i32>(textureDimensions(forgeax_vfx_water_solver_normal));
  let coordinate = clamp(vec2<i32>(uv * vec2<f32>(size)), vec2<i32>(0), size - 1);
  return textureLoad(forgeax_vfx_water_solver_normal, coordinate, 0).xyz;
}
fn vfx_water_surface_world_xz(cell: vec2<f32>) -> vec2<f32> {
  let local = cell * forgeax_vfx_water_surface_domain.spacing_resolution.xy;
  let cosine = forgeax_vfx_water_surface_domain.rotation.y;
  let sine = forgeax_vfx_water_surface_domain.rotation.z;
  let rotated = vec2<f32>(cosine * local.x - sine * local.y, sine * local.x + cosine * local.y);
  return forgeax_vfx_water_surface_domain.origin.xz + rotated;
}
fn vfx_water_surface_normal_world(cell: vec2<i32>) -> vec3<f32> {
  let local = vfx_water_surface_solver_normal_cell(cell);
  let cosine = forgeax_vfx_water_surface_domain.rotation.y;
  let sine = forgeax_vfx_water_surface_domain.rotation.z;
  let horizontal = vec2<f32>(cosine * local.x - sine * local.y, sine * local.x + cosine * local.y);
  return normalize(vec3<f32>(horizontal.x, local.z, horizontal.y));
}`
      : '',
    requirements.some((entry) => entry.waterEmissionBinding !== undefined)
      ? `struct VfxWaterEmissionSettings {
  limits: vec4<u32>,
  emission: vec4<f32>,
  restrictions: vec4<f32>,
  curvature: vec4<f32>,
  vorticity: vec4<f32>,
  flowSpeed: vec4<f32>,
  velocityOffsetDepthDifference: vec4<f32>,
  particle: vec4<f32>,
  sizeRange: vec4<f32>,
  acceleration: vec4<f32>,
  alphaCurve: array<vec4<f32>, 27>,
  sizeCurve: array<vec4<f32>, 25>,
}
@group(0) @binding(21) var<uniform> forgeax_vfx_water_emission: VfxWaterEmissionSettings;`
      : '',
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
  renderers: readonly VfxGpuRendererReflection[],
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
  renderers: readonly VfxGpuRendererReflection[],
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

const WATER_GRID_EMISSION_SCAN_WGSL = `
struct ForgeaxVfxWaterCell {
  position: vec3<f32>,
  flow: vec2<f32>,
  normal: vec3<f32>,
  count: u32,
}

var<workgroup> forgeax_vfx_water_scan_scratch: array<u32, 256>;

fn forgeax_vfx_water_smoothstep(minimum: f32, maximum: f32, value: f32) -> f32 {
  if (maximum <= minimum) { return select(0.0, 1.0, value >= maximum); }
  return smoothstep(minimum, maximum, value);
}

fn forgeax_vfx_water_counts_base() -> u32 {
  return forgeax_vfx_runtime.capacity * 2u +
    (forgeax_vfx_runtime.capacity + 255u) / 256u;
}
fn forgeax_vfx_water_prefix_base() -> u32 {
  return forgeax_vfx_water_counts_base() + forgeax_vfx_water_emission.limits.x;
}
fn forgeax_vfx_water_block_base() -> u32 {
  return forgeax_vfx_water_prefix_base() + forgeax_vfx_water_emission.limits.x;
}
fn forgeax_vfx_water_candidate_base() -> u32 {
  return forgeax_vfx_water_block_base() +
    (forgeax_vfx_water_emission.limits.x + 255u) / 256u;
}
fn forgeax_vfx_water_candidate_store(rank: u32, cell: ForgeaxVfxWaterCell) {
  let base = forgeax_vfx_water_candidate_base() + rank * 12u;
  forgeax_vfx_scratch[base] = bitcast<u32>(cell.position.x);
  forgeax_vfx_scratch[base + 1u] = bitcast<u32>(cell.position.y);
  forgeax_vfx_scratch[base + 2u] = bitcast<u32>(cell.position.z);
  forgeax_vfx_scratch[base + 3u] = 0u;
  forgeax_vfx_scratch[base + 4u] = bitcast<u32>(cell.flow.x);
  forgeax_vfx_scratch[base + 5u] = bitcast<u32>(cell.flow.y);
  forgeax_vfx_scratch[base + 6u] = 0u;
  forgeax_vfx_scratch[base + 7u] = 0u;
  forgeax_vfx_scratch[base + 8u] = bitcast<u32>(cell.normal.x);
  forgeax_vfx_scratch[base + 9u] = bitcast<u32>(cell.normal.y);
  forgeax_vfx_scratch[base + 10u] = bitcast<u32>(cell.normal.z);
  forgeax_vfx_scratch[base + 11u] = 0u;
}

fn forgeax_vfx_water_measure_cell(index: u32) -> ForgeaxVfxWaterCell {
  let empty = ForgeaxVfxWaterCell(
    vec3<f32>(0.0), vec2<f32>(0.0), vec3<f32>(0.0, 1.0, 0.0), 0u,
  );
  let resolution = vfx_water_surface_resolution();
  if (resolution.x == 0u || resolution.y == 0u || index >= resolution.x * resolution.y) {
    return empty;
  }
  let cell = vec2<i32>(i32(index % resolution.x), i32(index / resolution.x));
  let unitDx = vec2<f32>(1.0) / vec2<f32>(resolution);
  let unit = (vec2<f32>(cell) + vec2<f32>(0.5)) * unitDx;
  let validRange = 2.0 * unitDx;
  if (!(unit.x > validRange.x && unit.x < 1.0 - validRange.x &&
        unit.y > validRange.y && unit.y < 1.0 - validRange.y)) {
    return empty;
  }
  let center = vfx_water_surface_grid_cell(cell);
  if (center.y <= forgeax_vfx_water_emission.emission.x) { return empty; }

  // Preserve the exported cross-axis component and neighbor ordering.
  let vxPlus = vfx_water_surface_grid_cell(cell + vec2<i32>(0, 1)).z;
  let vxMinus = vfx_water_surface_grid_cell(cell + vec2<i32>(0, -1)).z;
  let vyPlus = vfx_water_surface_grid_cell(cell + vec2<i32>(1, 0)).w;
  let vyMinus = vfx_water_surface_grid_cell(cell + vec2<i32>(-1, 0)).w;
  let spacing = forgeax_vfx_water_surface_domain.spacing_resolution.xy;
  let simDx = max(spacing.x, spacing.y);
  let curl = abs(((vxPlus - vxMinus) - (vyPlus - vyMinus)) / (2.0 * simDx));
  let flow = vec2<f32>(0.5 * (vxPlus + vxMinus), 0.5 * (vyPlus + vyMinus));

  let normal = vfx_water_surface_solver_normal_cell(cell);
  let normalRight = vfx_water_surface_solver_normal_cell(cell + vec2<i32>(1, 0));
  let normalUp = vfx_water_surface_solver_normal_cell(cell + vec2<i32>(0, 1));
  let curvature = abs(((1.0 - dot(normal, normalRight)) +
    (1.0 - dot(normal, normalUp))) * 0.5);
  let cosine = forgeax_vfx_water_surface_domain.rotation.y;
  let sine = forgeax_vfx_water_surface_domain.rotation.z;
  let flowLocal = vec2<f32>(
    cosine * flow.x + sine * flow.y,
    -sine * flow.x + cosine * flow.y,
  );
  let advectedUnit = unit + flowLocal * forgeax_vfx_runtime.delta * unitDx / simDx;
  let advectedCell = vec2<i32>(advectedUnit * vec2<f32>(resolution));
  let advected = vfx_water_surface_grid_cell(advectedCell);
  let depthDifference = advected.y - center.y;
  let speed = length(flow);

  let curvatureAmount = forgeax_vfx_water_smoothstep(
    forgeax_vfx_water_emission.curvature.x,
    forgeax_vfx_water_emission.curvature.y,
    curvature,
  ) * forgeax_vfx_water_emission.curvature.z;
  let curlAmount = forgeax_vfx_water_smoothstep(
    forgeax_vfx_water_emission.vorticity.x,
    forgeax_vfx_water_emission.vorticity.y,
    curl,
  ) * forgeax_vfx_water_emission.vorticity.z;
  let speedAmount = forgeax_vfx_water_smoothstep(
    forgeax_vfx_water_emission.flowSpeed.x,
    forgeax_vfx_water_emission.flowSpeed.y,
    speed,
  ) * forgeax_vfx_water_emission.flowSpeed.z;
  let depthDeltaAmount = forgeax_vfx_water_smoothstep(
    forgeax_vfx_water_emission.velocityOffsetDepthDifference.x,
    forgeax_vfx_water_emission.velocityOffsetDepthDifference.y,
    depthDifference,
  ) * forgeax_vfx_water_emission.velocityOffsetDepthDifference.z;
  let depthRestriction = forgeax_vfx_water_smoothstep(
    forgeax_vfx_water_emission.restrictions.x,
    forgeax_vfx_water_emission.restrictions.y,
    center.y,
  );
  let speedRestriction = forgeax_vfx_water_smoothstep(
    forgeax_vfx_water_emission.restrictions.z,
    forgeax_vfx_water_emission.restrictions.w,
    speed,
  );
  let emissionAmount = clamp(
    max(max(curvatureAmount, curlAmount), max(speedAmount, depthDeltaAmount)) *
      forgeax_vfx_water_emission.emission.z * depthRestriction * speedRestriction,
    0.0,
    forgeax_vfx_water_emission.emission.w,
  );
  var count = 0u;
  if (emissionAmount >= forgeax_vfx_water_emission.emission.y && emissionAmount > 0.0) {
    if (emissionAmount < 1.0) {
      let randomValue = vfx_random_words(
        forgeax_vfx_runtime.seed,
        index,
        forgeax_vfx_runtime.tick,
        0x57415452u,
      );
      count = select(0u, 1u, randomValue < emissionAmount);
    } else {
      count = u32(emissionAmount);
    }
  }
  return ForgeaxVfxWaterCell(
    vec3<f32>(
      vfx_water_surface_world_xz(vec2<f32>(cell)).x,
      forgeax_vfx_water_surface_domain.origin.y + center.x,
      vfx_water_surface_world_xz(vec2<f32>(cell)).y,
    ),
    flow,
    vfx_water_surface_normal_world(cell),
    count,
  );
}

@compute @workgroup_size(256)
fn forgeax_vfx_water_emission_cells_main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index >= forgeax_vfx_water_emission.limits.x) { return; }
  let cell = forgeax_vfx_water_measure_cell(index);
  forgeax_vfx_scratch[forgeax_vfx_water_counts_base() + index] = cell.count;
}

@compute @workgroup_size(256)
fn forgeax_vfx_water_emission_scan_blocks_main(
  @builtin(global_invocation_id) invocation: vec3<u32>,
  @builtin(local_invocation_id) local: vec3<u32>,
  @builtin(workgroup_id) group: vec3<u32>,
) {
  let index = invocation.x;
  let lane = local.x;
  var flag = 0u;
  if (index < forgeax_vfx_water_emission.limits.x) {
    flag = forgeax_vfx_scratch[forgeax_vfx_water_counts_base() + index];
  }
  forgeax_vfx_water_scan_scratch[lane] = flag;
  workgroupBarrier();
  var offset = 1u;
  loop {
    if (offset >= 256u) { break; }
    var addend = 0u;
    if (lane >= offset) { addend = forgeax_vfx_water_scan_scratch[lane - offset]; }
    workgroupBarrier();
    forgeax_vfx_water_scan_scratch[lane] += addend;
    workgroupBarrier();
    offset *= 2u;
  }
  if (index < forgeax_vfx_water_emission.limits.x) {
    forgeax_vfx_scratch[forgeax_vfx_water_prefix_base() + index] =
      forgeax_vfx_water_scan_scratch[lane] - flag;
  }
  if (lane == 255u) {
    forgeax_vfx_scratch[forgeax_vfx_water_block_base() + group.x] =
      forgeax_vfx_water_scan_scratch[lane];
  }
}

@compute @workgroup_size(1)
fn forgeax_vfx_water_emission_scan_block_offsets_main() {
  let blockCount = (forgeax_vfx_water_emission.limits.x + 255u) / 256u;
  var sum = 0u;
  var block = 0u;
  loop {
    if (block >= blockCount) { break; }
    let offsetIndex = forgeax_vfx_water_block_base() + block;
    let blockSum = forgeax_vfx_scratch[offsetIndex];
    forgeax_vfx_scratch[offsetIndex] = sum;
    sum += blockSum;
    block += 1u;
  }
}

@compute @workgroup_size(256)
fn forgeax_vfx_water_emission_add_offsets_main(
  @builtin(global_invocation_id) invocation: vec3<u32>,
  @builtin(workgroup_id) group: vec3<u32>,
) {
  let index = invocation.x;
  if (index >= forgeax_vfx_water_emission.limits.x) { return; }
  forgeax_vfx_scratch[forgeax_vfx_water_prefix_base() + index] +=
    forgeax_vfx_scratch[forgeax_vfx_water_block_base() + group.x];
}

@compute @workgroup_size(256)
fn forgeax_vfx_water_emission_append_main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  let scanCapacity = forgeax_vfx_water_emission.limits.x;
  if (index == 0u) {
    let last = scanCapacity - 1u;
    let total = forgeax_vfx_scratch[forgeax_vfx_water_prefix_base() + last] +
      forgeax_vfx_scratch[forgeax_vfx_water_counts_base() + last];
    atomicStore(
      &forgeax_vfx_counters.gridEmissionCount,
      min(total, forgeax_vfx_water_emission.limits.y),
    );
  }
  if (index >= scanCapacity) { return; }
  let count = forgeax_vfx_scratch[forgeax_vfx_water_counts_base() + index];
  let first = forgeax_vfx_scratch[forgeax_vfx_water_prefix_base() + index];
  let cell = forgeax_vfx_water_measure_cell(index);
  var ordinal = 0u;
  loop {
    if (ordinal >= count) { break; }
    let rank = first + ordinal;
    if (rank < forgeax_vfx_water_emission.limits.y) {
      forgeax_vfx_water_candidate_store(rank, cell);
    }
    ordinal += 1u;
  }
}
`;

const WATER_GRID_PARTICLE_INITIALIZATION_WGSL = `fn forgeax_vfx_water_initialize_particle(
  particle: ptr<function, VfxParticle>,
  isGridSpawn: bool,
  spawnRank: u32,
  ctx: VfxSpawnContext,
) {
  let resolution = vfx_water_surface_resolution();
  let cellCount = max(1u, resolution.x * resolution.y);
  var position = (*particle).position;
  var flow = vec2<f32>(0.0);
  var normal = vec3<f32>(0.0, 1.0, 0.0);
  if (isGridSpawn) {
    let candidate = forgeax_vfx_water_candidate_base() + spawnRank * 12u;
    position = vec3<f32>(
      bitcast<f32>(forgeax_vfx_scratch[candidate]),
      bitcast<f32>(forgeax_vfx_scratch[candidate + 1u]),
      bitcast<f32>(forgeax_vfx_scratch[candidate + 2u]),
    );
    flow = vec2<f32>(
      bitcast<f32>(forgeax_vfx_scratch[candidate + 4u]),
      bitcast<f32>(forgeax_vfx_scratch[candidate + 5u]),
    );
    normal = normalize(vec3<f32>(
      bitcast<f32>(forgeax_vfx_scratch[candidate + 8u]),
      bitcast<f32>(forgeax_vfx_scratch[candidate + 9u]),
      bitcast<f32>(forgeax_vfx_scratch[candidate + 10u]),
    ));
  } else {
    let randomIndex = min(
      u32(vfx_random_spawn(ctx, 0x42555253u) * f32(cellCount)),
      cellCount - 1u,
    );
    let cell = vec2<i32>(i32(randomIndex % resolution.x), i32(randomIndex / resolution.x));
    let grid = vfx_water_surface_grid_cell(cell);
    let worldXZ = vfx_water_surface_world_xz(vec2<f32>(cell));
    position = vec3<f32>(
      worldXZ.x,
      forgeax_vfx_water_surface_domain.origin.y + grid.x,
      worldXZ.y,
    );
    flow = grid.zw;
    normal = normalize(vfx_water_surface_normal_world(cell));
  }
  let flowWorld = vec3<f32>(flow.x, 0.0, flow.y);
  let tangentFlow = flowWorld - normal * dot(flowWorld, normal);
  let randomDirection = vec3<f32>(
    vfx_random_spawn(ctx, 0x52414e31u) * 2.0 - 1.0,
    vfx_random_spawn(ctx, 0x52414e32u) * 2.0 - 1.0,
    vfx_random_spawn(ctx, 0x52414e33u) * 2.0 - 1.0,
  );
  let randomVelocity = select(
    vec3<f32>(0.0),
    normalize(randomDirection) * forgeax_vfx_water_emission.particle.y,
    length(randomDirection) > 0.000001,
  );
  let randomSize = mix(
    forgeax_vfx_water_emission.sizeRange.x,
    forgeax_vfx_water_emission.sizeRange.y,
    vfx_random_spawn(ctx, 0x53495a45u),
  ) * forgeax_vfx_water_emission.particle.w;
  (*particle).position = position;
  (*particle).velocity = tangentFlow + normal * forgeax_vfx_water_emission.particle.x + randomVelocity;
  (*particle).age = 0.0;
  (*particle).lifetime = forgeax_vfx_water_emission.particle.z;
  (*particle).sprite_size = vec2<f32>(randomSize);
  (*particle).material_random = randomSize;
  (*particle).color.w = 1.0;
}`;

const WATER_GRID_PARTICLE_ACCELERATION_WGSL = `fn forgeax_vfx_water_apply_acceleration(
  particle: ptr<function, VfxParticle>,
  ctx: VfxUpdateContext,
) {
  (*particle).velocity += forgeax_vfx_water_emission.acceleration.xyz * ctx.delta;
}`;

const WATER_GRID_PARTICLE_UPDATE_WGSL = `fn forgeax_vfx_water_curve_sample(
  value: f32,
  sampleCount: u32,
  curve: u32,
) -> f32 {
  let position = clamp(value, 0.0, 1.0) * f32(sampleCount - 1u);
  let lower = min(u32(floor(position)), sampleCount - 1u);
  let upper = min(lower + 1u, sampleCount - 1u);
  let fraction = position - f32(lower);
  var a = 0.0;
  var b = 0.0;
  if (curve == 0u) {
    a = forgeax_vfx_water_emission.alphaCurve[lower / 4u][lower % 4u];
    b = forgeax_vfx_water_emission.alphaCurve[upper / 4u][upper % 4u];
  } else {
    a = forgeax_vfx_water_emission.sizeCurve[lower / 4u][lower % 4u];
    b = forgeax_vfx_water_emission.sizeCurve[upper / 4u][upper % 4u];
  }
  return mix(a, b, fraction);
}

fn forgeax_vfx_water_update_particle(
  particle: ptr<function, VfxParticle>,
) {
  let normalizedAge = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  (*particle).color.w = forgeax_vfx_water_curve_sample(
    normalizedAge,
    forgeax_vfx_water_emission.limits.z,
    0u,
  );
  let scale = forgeax_vfx_water_curve_sample(
    normalizedAge,
    forgeax_vfx_water_emission.limits.w,
    1u,
  );
  (*particle).sprite_size = vec2<f32>((*particle).material_random * scale);
}`;

function createParticleManagedRuntimeV3(options: {
  readonly capacity: number;
  readonly custom: import('@forgeax/engine-vfx').VfxCustomLayout | undefined;
  readonly parameters: boolean;
  readonly customHook: boolean;
  readonly renderers: readonly VfxGpuRendererReflection[];
  readonly waterGridEmission: boolean;
}): string {
  const custom = options.custom;
  const materialInputs = createParticleMaterialInputRuntime(custom, options.renderers);
  const rendererAttributes = createParticleRendererAttributeRuntime(custom, options.renderers);
  const declarations = [
    options.parameters
      ? '@group(0) @binding(10) var<uniform> forgeax_vfx_parameters: VfxParameters;\nfn vfx_parameters() -> VfxParameters { return forgeax_vfx_parameters; }'
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
  if (options.waterGridEmission) {
    runtime = runtime
      .replace(
        'fn forgeax_vfx_water_initialize_particle(\n  particle: ptr<function, VfxParticle>,\n  isGridSpawn: bool,\n  spawnRank: u32,\n  ctx: VfxSpawnContext,\n) {\n  _ = particle;\n  _ = isGridSpawn;\n  _ = spawnRank;\n  _ = ctx;\n}',
        WATER_GRID_PARTICLE_INITIALIZATION_WGSL,
      )
      .replace(
        'fn forgeax_vfx_water_update_particle(\n  particle: ptr<function, VfxParticle>,\n) {\n  _ = particle;\n}',
        WATER_GRID_PARTICLE_UPDATE_WGSL,
      )
      .replace(
        'fn forgeax_vfx_water_apply_acceleration(\n  particle: ptr<function, VfxParticle>,\n  ctx: VfxUpdateContext,\n) {\n  _ = particle;\n  _ = ctx;\n}',
        WATER_GRID_PARTICLE_ACCELERATION_WGSL,
      );
    runtime = runtime.replace(
      '      forgeax_vfx_particles[index] = particle;',
      '      forgeax_vfx_water_initialize_particle(&particle, isGridSpawn, spawnRank, ctx);\n      forgeax_vfx_particles[index] = particle;',
    );
    runtime = `${WATER_GRID_EMISSION_SCAN_WGSL}\n${runtime}`;
  }
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
export type ParticleCodeProgram = Omit<VfxGpuProgram, 'fingerprint'>;

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

/** Serializable Pack Cook source; shader compilation belongs to Native Cook. */
export interface ParticleCodeCookSource {
  readonly effect: import('@forgeax/engine-vfx').ParticleEffectSourceV3;
  readonly modules: Readonly<Record<string, ParticleCodeModuleSet>>;
  readonly materials?: ParticleMaterialInputCatalog;
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

/** Render the effect-level `parameters` table as the managed `VfxParameters` struct block. */
function synthesizeParametersBlock(
  parameters: NonNullable<ParticleEffectSourceV3['parameters']>,
): string {
  const literal = (type: VfxValueType, value: unknown): string =>
    Array.isArray(value) ? `${type}(${value.join(', ')})` : String(value);
  const lines: string[] = ['', '// forgeax-managed: generated from the effect `parameters` table'];
  const entries = Object.entries(parameters);
  for (const [name, entry] of entries) {
    if (entry.default !== undefined)
      lines.push(`// forgeax-vfx-default ${name} = ${literal(entry.type, entry.default)}`);
  }
  lines.push('struct VfxParameters {');
  for (const [name, entry] of entries) lines.push(`  ${name}: ${entry.type},`);
  lines.push('}', '');
  return lines.join('\n');
}

function declaredParametersConflict(
  emitterId: string,
  moduleId: string,
  module: ParticleCodeModuleSet,
  declared: readonly string[],
): ParticleCodeCookError | undefined {
  if (declared.length === 0) return undefined;
  const hasHandWritten = (source: string): boolean =>
    /\bstruct\s+VfxParameters\b/.test(stripWgslComments(source));
  if (!hasHandWritten(module.entry) && !Object.values(module.imports ?? {}).some(hasHandWritten))
    return undefined;
  return compileError(
    'vfx-reserved-surface-conflict',
    emitterId,
    'either the effect `parameters` table or a hand-written struct VfxParameters, not both',
    'delete the struct VfxParameters from the module and declare the fields in the effect parameters table',
    { module: moduleId },
  );
}

function reservedImportConflict(
  emitterId: string,
  module: ParticleCodeModuleSet,
): ParticleCodeCookError | undefined {
  for (const [importId, source] of Object.entries(module.imports ?? {})) {
    if (!RESERVED.test(stripWgslComments(source))) continue;
    return compileError(
      'vfx-reserved-surface-conflict',
      emitterId,
      'author imports without bindings, shader stages, or forgeax_vfx_* symbols',
      `remove the reserved declaration from ${importId} and recook`,
      { module: importId },
    );
  }
  return undefined;
}

function resolveEmitterModule(
  modules: Readonly<Record<string, ParticleCodeModuleSet>>,
  moduleId: string,
): ParticleCodeModuleSet | undefined {
  if (modules[moduleId] !== undefined) return modules[moduleId];
  return moduleId === PARTICLE_CODE_DEFAULT_MODULE_ID
    ? { entry: PARTICLE_CODE_DEFAULT_MODULE }
    : undefined;
}

async function compileEmitterV3(
  emitter: ParticleEmitterSourceV3,
  modules: Readonly<Record<string, ParticleCodeModuleSet>>,
  materials?: ParticleMaterialInputCatalog,
  parameters?: ParticleEffectSourceV3['parameters'],
): Promise<Result<VfxGpuEmitterProgram, ParticleCodeCookError>> {
  const moduleId = emitter.program.module;
  const module = resolveEmitterModule(modules, moduleId);
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
  const declared = parameters === undefined ? [] : Object.keys(parameters);
  const parameterConflict = declaredParametersConflict(emitter.id, moduleId, module, declared);
  if (parameterConflict !== undefined) return err(parameterConflict);
  const parametersBlock =
    parameters === undefined || declared.length === 0 ? '' : synthesizeParametersBlock(parameters);
  const authoredEntryCode = module.entry + parametersBlock;
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
  const importConflict = reservedImportConflict(emitter.id, module);
  if (importConflict !== undefined) return err(importConflict);
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
  const validateHookSignatures = () => {
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

    return undefined;
  };
  const validateHookSignaturesFailure = validateHookSignatures();
  if (validateHookSignaturesFailure !== undefined) return validateHookSignaturesFailure;

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
  const authoredDataInterfaces = layout.value.dataInterfaces ?? [];
  const validateWaterEmissionInterface = () => {
    if (
      emitter.waterGridEmission !== undefined &&
      !authoredDataInterfaces.some((entry) => entry.kind === 'water-surface')
    ) {
      return err(
        compileError(
          'vfx-shader-invalid',
          emitter.id,
          'a vfx:water-surface Data Interface import for waterGridEmission',
          'add #import forgeax_vfx::data::water_surface to the emitter module and recook',
          { module: moduleId },
        ),
      );
    }

    return undefined;
  };
  const validateWaterEmissionInterfaceFailure = validateWaterEmissionInterface();
  if (validateWaterEmissionInterfaceFailure !== undefined)
    return validateWaterEmissionInterfaceFailure;

  const dataInterfaces = authoredDataInterfaces.map((entry) =>
    entry.kind === 'water-surface' && emitter.waterGridEmission !== undefined
      ? { ...entry, waterEmissionBinding: 21 }
      : entry,
  );
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
          name.endsWith('force_fields') ||
          name.endsWith('water_surface') ||
          name.endsWith('water_displacement') ||
          name.endsWith('water_hull') ||
          name.endsWith('water_config') ||
          name.endsWith('gpu_events') ||
          name === 'forgeax_vfx::data',
      ),
    ),
  };
  const managed = createParticleManagedRuntimeV3({
    capacity: emitter.capacity,
    parameters: layout.value.parameters.fields.length > 0,
    custom: layout.value.customLayout,
    customHook,
    renderers: renderers.value,
    waterGridEmission: emitter.waterGridEmission !== undefined,
  });
  const hasEvents = (emitter.channels?.length ?? 0) > 0 || (emitter.events?.length ?? 0) > 0;
  const custom = layout.value.customLayout;
  const managedImports =
    emitter.waterGridEmission === undefined
      ? ''
      : '#import forgeax_vfx::prelude::{vfx_hash, vfx_random_words}\n';
  const eventRuntime = !hasEvents
    ? ''
    : custom === undefined || custom.stride === 0
      ? PARTICLE_EVENT_MANAGED_RUNTIME
      : PARTICLE_EVENT_MANAGED_RUNTIME.replace(
          '    forgeax_vfx_particles[childParticleIndex] = child;',
          `    forgeax_vfx_particles[childParticleIndex] = child;\n    forgeax_vfx_custom[childParticleIndex] = VfxCustom(${custom.fields.map((field) => wgslDefault(field.type)).join(', ')});`,
        );
  let poolRuntime = '';
  const validatePoolHooks = () => {
    if (emitter.pool) {
      const customFields = layout.value.customLayout?.fields ?? [];
      const parameterFields = layout.value.parameters.fields;
      const validState = Object.values(emitter.pool.state).every((name) =>
        customFields.some((field) => field.name === name && field.type === 'f32'),
      );
      const validCommands = emitter.pool.commands.every((command) =>
        [command.sequence, command.count].every((name) =>
          parameterFields.some((field) => field.name === name && field.type === 'f32'),
        ),
      );
      const validHooks = [emitter.pool.acquire, emitter.pool.control]
        .filter((name): name is string => name !== undefined)
        .every((name) => new RegExp(`\\bfn\\s+${name}\\s*\\(`).test(entryCode));
      if (!customHook || !validState || !validCommands || !validHooks)
        return err(
          compileError(
            'vfx-shader-invalid',
            emitter.id,
            'authored pool hooks, persistent custom f32 state and declared command parameters',
            'Declare and implement the pool acquire/control hooks and their bounded state',
            { module: moduleId },
          ),
        );
      poolRuntime = createGpuSlotAllocatorRuntime(emitter.pool, emitter.capacity);
    }

    return undefined;
  };
  const validatePoolHooksFailure = validatePoolHooks();
  if (validatePoolHooksFailure !== undefined) return validatePoolHooksFailure;
  const compiled = await compileParticleShader(
    `${managedImports}${authoredEntryCode}\n${managed}\n${createParticleDataInterfaceRuntimeV3(dataInterfaces)}\n${createParticleStageManagedRuntime(stagePlan.value)}\n${eventRuntime}\n${poolRuntime}`,

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
  const validatePortableStorageBindings = () => {
    if (
      emitter.forceFields !== undefined ||
      dataInterfaces.some((entry) => entry.kind === 'structured-input')
    ) {
      const storageEntries = compiled.value.bindings.flatMap((group) =>
        group.entries
          .filter(
            (entry) =>
              (entry.visibility & 4) !== 0 &&
              (entry.buffer?.type === 'storage' || entry.buffer?.type === 'read-only-storage'),
          )
          .map((entry) => `${group.label}:${entry.binding}`),
      );
      const storageKeys = new Set(storageEntries);
      const entryPoints = compiled.value.reflection.entryPoints;
      const storageBindings =
        entryPoints === undefined ||
        !dataInterfaces.some((entry) => entry.kind === 'structured-input')
          ? storageEntries.length
          : Math.max(
              0,
              ...entryPoints.map(
                (entry) =>
                  entry.bindings.filter((binding) =>
                    storageKeys.has(`@group(${binding.group}):${binding.binding}`),
                  ).length,
              ),
            );
      if (storageBindings > 8)
        return err(
          compileError(
            'vfx-shader-invalid',
            emitter.id,
            'at most eight compute storage bindings on the portable managed storage path',
            'split custom/event work into another emitter rather than exceeding the guaranteed WebGPU limit',
            {
              module: moduleId,
              cause: {
                storageBindings,
                bindings: storageEntries,
                entryPoints: compiled.value.reflection.entryPoints,
              },
            },
          ),
        );
    }

    return undefined;
  };
  const validatePortableStorageBindingsFailure = validatePortableStorageBindings();
  if (validatePortableStorageBindingsFailure !== undefined)
    return validatePortableStorageBindingsFailure;

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
    ...(emitter.waterGridEmission === undefined ? [] : ['water-grid-emission']),
    ...(hasEvents ? ['eventBuffer'] : []),
  ];
  const publishEmitterProgram = (): VfxGpuEmitterProgram => {
    const program: VfxGpuEmitterProgram = {
      id: emitter.id,
      module: moduleId,
      capacity: emitter.capacity,
      backend: emitter.backend,
      space: emitter.space,
      ...(emitter.forceFields === undefined ? {} : { forceFields: emitter.forceFields }),
      ...(emitter.waterGridEmission === undefined
        ? {}
        : { waterGridEmission: emitter.waterGridEmission }),
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
          ...(emitter.pool ? [GPU_SLOT_ALLOCATOR_ENTRY] : []),
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
          ...(emitter.waterGridEmission === undefined
            ? []
            : [
                'forgeax_vfx_water_emission_cells_main',
                'forgeax_vfx_water_emission_scan_blocks_main',
                'forgeax_vfx_water_emission_scan_block_offsets_main',
                'forgeax_vfx_water_emission_add_offsets_main',
                'forgeax_vfx_water_emission_append_main',
              ]),
          ...stagePlan.value.stages.map((stage) => stage.entryPoint),
        ],
        ...(compiled.value.reflection.entryPoints === undefined
          ? {}
          : {
              entryPointBindings: compiled.value.reflection.entryPoints,
            }),
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
    return program;
  };
  const program = publishEmitterProgram();
  // The base ABI permits arbitrary hook reads. A multi-instance contract only
  // follows hooks that cannot name the managed storage/runtime namespace;
  // shader immutability or a matching reflection alone does not prove that.
  const instanceIsolated =
    !/\bforgeax_vfx_/.test(entryCode) &&
    Object.values(module.imports ?? {}).every(
      (source) => !/\bforgeax_vfx_/.test(stripWgslComments(source)),
    );
  const buildIsolatedInstanceProgram = () =>
    instanceIsolated && emitter.pool === undefined
      ? createVfxInstanceComputeProgram(program)
      : undefined;
  const instanceCompute = buildIsolatedInstanceProgram();
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
  const emitters: VfxGpuEmitterProgram[] = [];
  for (const emitter of parsed.value.emitters) {
    const compiled = await compileEmitterV3(emitter, modules, materials, parsed.value.parameters);
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
      let effect = source;
      let sourceModules = modules;
      let sourceMaterials = materials;
      if (source !== null && typeof source === 'object' && Object.hasOwn(source, 'effect')) {
        const explicit = source as ParticleCodeCookSource;
        if (
          Object.keys(source).some((key) => !['effect', 'modules', 'materials'].includes(key)) ||
          explicit.modules === null ||
          typeof explicit.modules !== 'object' ||
          Array.isArray(explicit.modules) ||
          Object.values(explicit.modules).some(
            (module) =>
              module === null ||
              typeof module !== 'object' ||
              typeof module.entry !== 'string' ||
              Object.keys(module).some((key) => key !== 'entry' && key !== 'imports') ||
              (module.imports !== undefined &&
                (module.imports === null ||
                  typeof module.imports !== 'object' ||
                  Array.isArray(module.imports) ||
                  Object.values(module.imports).some((text) => typeof text !== 'string'))),
          ) ||
          (explicit.materials !== undefined &&
            (explicit.materials === null ||
              typeof explicit.materials !== 'object' ||
              Array.isArray(explicit.materials)))
        )
          throw new TypeError(
            'Particle Cook source requires effect, WGSL modules and optional material inputs',
          );
        effect = explicit.effect;
        sourceModules = explicit.modules;
        sourceMaterials = explicit.materials;
      }
      const cooked = await cookParticleCodeEffect(effect, sourceModules, sourceMaterials);
      if (!cooked.ok) {
        // Keep the structured fields on the thrown error so offline checks and
        // the Pack failure route can report the code, causeCode and WGSL line.
        throw Object.assign(new Error(cooked.error.hint), {
          code: cooked.error.code,
          expected: cooked.error.expected,
          hint: cooked.error.hint,
          detail: cooked.error.detail,
        });
      }
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
