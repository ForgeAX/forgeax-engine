import { err, ok, type Result } from '@forgeax/engine-types';
import {
  PARTICLE_STAGE_RESOURCE_NAMES,
  type ParticleStageResourceAccess,
  type ParticleStageSource,
  parseVfxStageDeclarations,
  type VfxGpuStageReflection,
} from '@forgeax/engine-vfx';

export interface ParticleManagedStagePlan {
  readonly stages: readonly VfxGpuStageReflection[];
  readonly fingerprint: string;
}

export interface ParticleStagePlanError {
  readonly code:
    | 'vfx-stage-entry-missing'
    | 'vfx-stage-entry-invalid'
    | 'vfx-stage-resource-unknown'
    | 'vfx-stage-resource-hazard'
    | 'vfx-stage-dependency-unknown'
    | 'vfx-stage-dependency-cycle'
    | 'vfx-stage-dispatch-out-of-bounds'
    | 'vfx-stage-budget-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly stageId?: string;
    readonly dependency?: string;
    readonly resource?: string;
    readonly conflictWith?: string;
    readonly path?: readonly string[];
  };
}

const BUILT_IN_STAGES = new Set(['spawn', 'update', 'scan', 'compact']);
const MAX_STAGE_BUDGET = 64;

function stageFailure(
  code: ParticleStagePlanError['code'],
  expected: string,
  hint: string,
  detail: ParticleStagePlanError['detail'],
): Result<never, ParticleStagePlanError> {
  return err({ code, expected, hint, detail });
}

function accessWrites(access: ParticleStageResourceAccess): boolean {
  return access === 'write' || access === 'read-write';
}

function hasPath(
  stages: ReadonlyMap<string, ParticleStageSource>,
  from: string,
  to: string,
  seen = new Set<string>(),
): boolean {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const stage = stages.get(from);
  return (
    stage?.dependsOn.some(
      (dependency) => !BUILT_IN_STAGES.has(dependency) && hasPath(stages, dependency, to, seen),
    ) ?? false
  );
}

function topologicalStages(
  stages: readonly ParticleStageSource[],
): Result<readonly ParticleStageSource[], ParticleStagePlanError> {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const temporary = new Set<string>();
  const permanent = new Set<string>();
  const ordered: ParticleStageSource[] = [];
  const visit = (id: string, path: readonly string[]): Result<void, ParticleStagePlanError> => {
    if (permanent.has(id)) return ok(undefined);
    if (temporary.has(id)) {
      return stageFailure(
        'vfx-stage-dependency-cycle',
        'an acyclic stage dependency graph',
        'remove the stage dependency cycle and recook the effect',
        { stageId: id, path: [...path, id] },
      );
    }
    const stage = byId.get(id);
    if (stage === undefined) return ok(undefined);
    temporary.add(id);
    for (const dependency of stage.dependsOn) {
      if (BUILT_IN_STAGES.has(dependency)) continue;
      const dependencyStage = byId.get(dependency);
      if (dependencyStage === undefined) {
        return stageFailure(
          'vfx-stage-dependency-unknown',
          'every stage dependency to name a declared stage or managed stage',
          'declare the dependency or use the managed update stage, then recook',
          { stageId: id, dependency },
        );
      }
      const result = visit(dependencyStage.id, [...path, id]);
      if (!result.ok) return result;
    }
    temporary.delete(id);
    permanent.add(id);
    ordered.push(stage);
    return ok(undefined);
  };
  for (const stage of stages) {
    const result = visit(stage.id, []);
    if (!result.ok) return result;
  }
  return ok(Object.freeze(ordered));
}

/** Validate and normalize compiler-owned particle stage declarations. */
export function buildParticleStagePlan(
  source: string,
): Result<
  ParticleManagedStagePlan,
  ParticleStagePlanError | import('@forgeax/engine-vfx').ParticleCodeSourceError
> {
  const parsed = parseVfxStageDeclarations(source);
  if (!parsed.ok) {
    if (parsed.error.code === 'vfx-source-stage-invalid') {
      const resource = parsed.error.detail.resource;
      if (resource !== undefined) {
        return stageFailure(
          'vfx-stage-resource-unknown',
          'a managed particle resource',
          'declare only resources exposed by the managed VFX ABI and recook the stage',
          {
            ...(parsed.error.detail.stageId === undefined
              ? {}
              : { stageId: parsed.error.detail.stageId }),
            resource,
          },
        );
      }
      const path = parsed.error.detail.path;
      if (path.endsWith('.iterationBudget')) {
        return stageFailure(
          'vfx-stage-budget-invalid',
          'an integer iteration budget from 1 through 64',
          'lower the stage iteration budget and recook the stage',
          parsed.error.detail.stageId === undefined ? {} : { stageId: parsed.error.detail.stageId },
        );
      }
      if (path.endsWith('.domain')) {
        return stageFailure(
          'vfx-stage-dispatch-out-of-bounds',
          'the particle dispatch domain',
          'use the managed particle domain and recook the stage',
          parsed.error.detail.stageId === undefined ? {} : { stageId: parsed.error.detail.stageId },
        );
      }
      return stageFailure(
        'vfx-stage-entry-invalid',
        'a supported managed stage declaration',
        'repair the stage entry metadata and recook the stage',
        parsed.error.detail.stageId === undefined ? {} : { stageId: parsed.error.detail.stageId },
      );
    }
    return parsed;
  }
  const stages = new Map(parsed.value.map((stage) => [stage.id, stage]));
  for (const stage of parsed.value) {
    if (!new RegExp(`\\bfn\\s+${stage.entry}\\s*\\(`).test(source)) {
      return stageFailure(
        'vfx-stage-entry-missing',
        `the WGSL entry function ${stage.entry} to be declared`,
        'add the declared particle stage function and recook',
        { stageId: stage.id },
      );
    }
    if (stage.iterationBudget < 1 || stage.iterationBudget > MAX_STAGE_BUDGET) {
      return stageFailure(
        'vfx-stage-budget-invalid',
        `an iteration budget from 1 through ${MAX_STAGE_BUDGET}`,
        'lower the stage iteration budget and recook',
        { stageId: stage.id },
      );
    }
    for (const resource of stage.resources) {
      if (
        !PARTICLE_STAGE_RESOURCE_NAMES.includes(
          resource.name as (typeof PARTICLE_STAGE_RESOURCE_NAMES)[number],
        )
      ) {
        return stageFailure(
          'vfx-stage-resource-unknown',
          'a managed particle resource',
          'declare only resources exposed by the managed VFX ABI and recook the stage',
          { stageId: stage.id, resource: resource.name },
        );
      }
    }
  }
  const ordered = topologicalStages(parsed.value);
  if (!ordered.ok) return ordered;
  for (let leftIndex = 0; leftIndex < parsed.value.length; leftIndex += 1) {
    const left = parsed.value[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < parsed.value.length; rightIndex += 1) {
      const right = parsed.value[rightIndex];
      if (
        right === undefined ||
        hasPath(stages, left.id, right.id) ||
        hasPath(stages, right.id, left.id)
      ) {
        continue;
      }
      const leftWrites = new Set(
        left.resources
          .filter((resource) => accessWrites(resource.access))
          .map((resource) => resource.name),
      );
      for (const resource of right.resources) {
        if (leftWrites.has(resource.name)) {
          return stageFailure(
            'vfx-stage-resource-hazard',
            'conflicting stage resource access to be ordered by dependsOn',
            'add an explicit dependency between the conflicting stages and recook',
            { stageId: right.id, conflictWith: left.id, resource: resource.name },
          );
        }
      }
    }
  }
  const normalized = ordered.value.map((stage) => ({
    id: stage.id,
    entry: stage.entry,
    entryPoint: `forgeax_vfx_stage_${stage.id}_main`,
    domain: stage.domain,
    resources: stage.resources,
    dependsOn: stage.dependsOn,
    iterationBudget: stage.iterationBudget,
  }));
  return ok({
    stages: Object.freeze(normalized),
    fingerprint: JSON.stringify(normalized),
  });
}

/** Generate a managed compute wrapper for every validated author stage. */
export function createParticleStageManagedRuntime(plan: ParticleManagedStagePlan): string {
  return plan.stages
    .map(
      (stage) => `
@compute @workgroup_size(256)
fn ${stage.entryPoint}(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index >= forgeax_vfx_runtime.capacity) { return; }
  if (forgeax_vfx_scratch[index] == 0u) { return; }
  var particle = forgeax_vfx_particles[index];
  let ctx = VfxUpdateContext(
    forgeax_vfx_runtime.delta,
    forgeax_vfx_runtime.tick,
    forgeax_vfx_runtime.seed,
    forgeax_vfx_runtime.playCycle,
    particle.id,
  );
  var iteration = 0u;
  loop {
    if (iteration >= ${stage.iterationBudget}u) { break; }
    ${stage.entry}(ctx, &particle);
    iteration += 1u;
  }
  forgeax_vfx_particles[index] = particle;
}
`,
    )
    .join('');
}

/** Managed GPU event ABI appended to every cooked code-first VFX program. */
export const PARTICLE_EVENT_MANAGED_RUNTIME = `
struct ForgeaxVfxEvent {
  position: vec4<f32>,
  strength: f32,
  sequence: u32,
  channel: u32,
  reserved: u32,
}

// Channel inputs and emitted events share one storage allocation. The
// simulation runtime stores the input count in topology.y, so a Custom-enabled
// emitter with channels stays within the WebGPU storage-buffer budget without
// adding a second event transport or CPU mirror.
@group(0) @binding(8) var<storage, read_write> forgeax_vfx_event_buffer: array<ForgeaxVfxEvent>;

// Channel inputs are bounded and ordered. One GPU invocation reserves each
// complete fan-out in that order, so drop-newest is deterministic and a failed
// reservation never publishes counts or consumes a live physical particle slot.
@compute @workgroup_size(1)
fn forgeax_vfx_event_main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  if (invocation.x != 0u) { return; }
  let inputCapacity = forgeax_vfx_runtime.topology.y;
  let outputCapacity = arrayLength(&forgeax_vfx_event_buffer) - inputCapacity;
  var particleCount = atomicLoad(&forgeax_vfx_counters.aliveCount);
  // The output allocation belongs to this tick; diagnostic counts persist
  // across ticks and must never be used as offsets into a fresh allocation.
  var eventCount = 0u;
  var freeSlot = 0u;
  for (var inputIndex = 0u; inputIndex < inputCapacity; inputIndex += 1u) {
  let input = forgeax_vfx_event_buffer[inputIndex];
  if (input.sequence == 0xffffffffu) { continue; }
  let fanOut = max(input.reserved, 1u);
  if (
    fanOut > forgeax_vfx_runtime.capacity - particleCount ||
    fanOut > outputCapacity - eventCount
  ) {
    atomicAdd(&forgeax_vfx_counters.eventDropped, 1u);
    atomicAdd(&forgeax_vfx_counters.eventOverflow, 1u);
    continue;
  }
  let eventBase = inputCapacity + eventCount;
  var childIndex = 0u;
  loop {
    if (childIndex >= fanOut) { break; }
    // Compaction provides the exact live count; this cursor visits each physical
    // slot at most once across all accepted fan-outs in the dispatch.
    while (forgeax_vfx_scratch[freeSlot] != 0u) { freeSlot += 1u; }
    let childParticleIndex = freeSlot;
    freeSlot += 1u;
    let child = VfxParticle(
      input.position.xyz,
      0.0,
      vec3<f32>(0.0, 0.35 + input.strength, 0.0),
      0.35,
      vec4<f32>(1.0, 0.45, 0.1, 1.0),
      vec2<f32>(0.1 + input.strength * 0.15),
      0.0,
      0.0,
      vec4<f32>(0.0, 0.0, 0.0, 1.0),
      // Event children are authored debris/embers, not a unit-sized mesh.
      // Keep the default bounded so a generic event routed to a mesh emitter
      // cannot turn one channel input into a screen-filling sphere. Authors
      // can still override the child in a dedicated sub-emitter program.
      vec3<f32>(0.06 + clamp(input.strength, 0.0, 1.0) * 0.04),
      0.0,
      input.sequence + childIndex,
      1u,
    );
    forgeax_vfx_particles[childParticleIndex] = child;
    forgeax_vfx_scratch[childParticleIndex] = 1u;
    forgeax_vfx_alive_indices[particleCount + childIndex] = childParticleIndex;
    forgeax_vfx_event_buffer[eventBase + childIndex] = ForgeaxVfxEvent(
      input.position,
      input.strength,
      input.sequence + childIndex,
      input.channel,
      0u,
    );
    childIndex += 1u;
  }
  particleCount += fanOut;
  eventCount += fanOut;
  atomicAdd(&forgeax_vfx_counters.eventConsumed, fanOut);
  }
  atomicStore(&forgeax_vfx_counters.aliveCount, particleCount);
  atomicAdd(&forgeax_vfx_counters.eventProduced, eventCount);
  var renderer = 0u;
  loop {
    if (renderer >= forgeax_vfx_runtime.rendererCount) { break; }
    forgeax_vfx_indirect[renderer].instanceCount = particleCount;
    renderer += 1u;
  }
}
`;
