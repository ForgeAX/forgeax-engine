import type { RenderFeatureWorkPlan } from '@forgeax/engine-render';
import { ownRenderFeatureProgramData } from '@forgeax/engine-render/internal';
import type { VfxGpuTickIntent } from '@forgeax/engine-vfx';
import type { RenderFeatureGpuProgramDescriptor } from '../../../render/src/features/prepared-gpu-work';
import type { VfxComputeBatchProgram } from './batched-compute-program';
import { rendererSortingMode } from './runtime-uniform.js';
import type { VfxValidatedStagePlan } from './stage-plan.js';

type Emitter = VfxGpuTickIntent['emitter'];
type ComputeDispatches = Extract<
  RenderFeatureWorkPlan['passes'][number],
  { readonly kind: 'compute' }
>['dispatches'];

/** Threads per simulation and projection workgroup. */
export const WORKGROUP_SIZE = 256;

type ParticleRendererKind = Emitter['renderers'][number]['kind'];

const rendererOnlyEntryPoints = new Map<string, ParticleRendererKind>([
  ['forgeax_vfx_billboard_main', 'billboard'],
  ['forgeax_vfx_mesh_main', 'mesh'],
  ['forgeax_vfx_ribbon_main', 'ribbon'],
  ['forgeax_vfx_trail_main', 'trail'],
  ['forgeax_vfx_beam_main', 'beam'],
  ['forgeax_vfx_trail_history_main', 'trail'],
  ['forgeax_vfx_trail_offsets_main', 'trail'],
]);

function needsCompactionOffsets(capacity: number): boolean {
  return capacity > WORKGROUP_SIZE;
}

export function simulationDispatches(
  intent: Pick<VfxGpuTickIntent, 'emitter' | 'spawnCount'>,
  stages: VfxValidatedStagePlan,
): ComputeDispatches {
  const groups = Math.max(1, Math.ceil(intent.emitter.capacity / WORKGROUP_SIZE));
  const entries = intent.emitter.reflection.entryPoints;
  const fusedCompaction =
    !needsCompactionOffsets(intent.emitter.capacity) &&
    entries.includes('forgeax_vfx_scan_compact_main');
  const fusedUpdate =
    fusedCompaction &&
    stages.stages.length === 0 &&
    entries.includes('forgeax_vfx_update_compact_main');
  const compact: ComputeDispatches = fusedCompaction
    ? [{ kind: 'direct', entryPoint: 'forgeax_vfx_scan_compact_main', workgroups: [groups] }]
    : [
        { kind: 'direct', entryPoint: 'forgeax_vfx_scan_blocks_main', workgroups: [groups] },
        // One block already has global prefixes. Its inter-block offset is zero;
        // neither compaction nor the next spawn reads the block-total scratch.
        ...(needsCompactionOffsets(intent.emitter.capacity)
          ? [
              {
                kind: 'direct' as const,
                entryPoint: 'forgeax_vfx_scan_block_offsets_main',
                workgroups: [1] as const,
              },
              {
                kind: 'direct' as const,
                entryPoint: 'forgeax_vfx_add_offsets_main',
                workgroups: [groups] as const,
              },
            ]
          : []),
        { kind: 'direct', entryPoint: 'forgeax_vfx_compact_main', workgroups: [groups] },
      ];
  return [
    {
      kind: 'direct',
      entryPoint: 'forgeax_vfx_spawn_main',
      workgroups: [intent.spawnCount === 0 ? 0 : groups],
    },
    {
      kind: 'direct',
      entryPoint: fusedUpdate ? 'forgeax_vfx_update_compact_main' : 'forgeax_vfx_update_main',
      workgroups: [groups],
    },
    ...stages.stages.map((stage) => ({
      kind: 'direct' as const,
      entryPoint: stage.entryPoint,
      workgroups: [groups] as const,
    })),
    ...(fusedUpdate ? [] : compact),
    ...(intent.emitter.reflection.entryPoints.includes('forgeax_vfx_event_main')
      ? [
          {
            kind: 'direct' as const,
            entryPoint: 'forgeax_vfx_event_main',
            workgroups: [1] as const,
          },
          ...compact,
        ]
      : []),
  ];
}

export function emitterComputeProgram(emitter: Emitter): RenderFeatureGpuProgramDescriptor {
  const authoredRendererKinds = new Set(emitter.renderers.map((renderer) => renderer.kind));
  const preparedEntryPoints = emitter.reflection.entryPoints.filter((entryPoint) => {
    if (
      entryPoint === 'forgeax_vfx_scan_block_offsets_main' ||
      entryPoint === 'forgeax_vfx_add_offsets_main'
    )
      return needsCompactionOffsets(emitter.capacity);
    if (entryPoint === 'forgeax_vfx_sort_main')
      return emitter.renderers.some((renderer) => rendererSortingMode(renderer) !== 0);
    const kind = rendererOnlyEntryPoints.get(entryPoint);
    return kind === undefined || authoredRendererKinds.has(kind);
  });
  return {
    wgsl: emitter.wgsl,
    entryPoints: preparedEntryPoints,
    bindings: emitter.reflection.bindings,
  };
}

/** Data interfaces whose binding the emitter's compute reflection actually declares. */
export function reflectedDataInterfaceRequirements(
  emitter: Emitter,
): NonNullable<Emitter['reflection']['dataInterfaces']> {
  const reflectedBindings = new Set(
    emitter.reflection.bindings.flatMap((group) => group.entries.map((entry) => entry.binding)),
  );
  return (emitter.reflection.dataInterfaces ?? []).filter((requirement) =>
    reflectedBindings.has(requirement.binding),
  );
}

/** Static reflection shares the existing immutable compute-program lifetime.
 * Raw/inline emitters keep the ordinary current-source path. */
export function createVfxEmitterProgramOwner(
  immutable: Pick<WeakSet<object>, 'has'>,
  compile: (emitter: Emitter) => RenderFeatureGpuProgramDescriptor,
  compileBatch?: (
    emitter: Emitter,
    program: RenderFeatureGpuProgramDescriptor,
  ) => VfxComputeBatchProgram | undefined,
) {
  const programs = new WeakMap<
    Emitter,
    {
      readonly program: RenderFeatureGpuProgramDescriptor;
      readonly batch?: VfxComputeBatchProgram;
      readonly entryPoints: ReadonlySet<string>;
      readonly requirements: NonNullable<Emitter['reflection']['dataInterfaces']>;
    }
  >();
  return (emitter: Emitter) => {
    if (!immutable.has(emitter)) return undefined;
    const previous = programs.get(emitter);
    if (previous !== undefined) return previous;
    const program = ownRenderFeatureProgramData(compile(emitter));
    const entryPoints = new Set(emitter.reflection.entryPoints);
    const requirements = reflectedDataInterfaceRequirements(emitter);
    const compiledBatch = compileBatch?.(emitter, program);
    const batch =
      compiledBatch === undefined
        ? undefined
        : { ...compiledBatch, descriptor: ownRenderFeatureProgramData(compiledBatch.descriptor) };
    const prepared = {
      program,
      entryPoints,
      requirements,
      ...(batch === undefined ? {} : { batch }),
    };
    programs.set(emitter, prepared);
    return prepared;
  };
}
