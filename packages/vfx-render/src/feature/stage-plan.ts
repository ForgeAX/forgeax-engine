import type { VfxGpuStageReflection } from '@forgeax/engine-vfx';
import type {
  RenderFeatureGpuBindingsRef,
  RenderFeatureGpuDispatch,
} from '../../../render/src/features/prepared-gpu-work.js';

const MANAGED_STAGES = new Set(['spawn', 'update', 'scan', 'compact']);
const RESOURCE_NAMES = new Set([
  'particles',
  'runtime',
  'aliveIndices',
  'counters',
  'indirect',
  'scratch',
  'billboardInstances',
  'channelInputs',
  'events',
  'eventCounters',
]);
const STAGE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const ENTRY_POINT = /^forgeax_vfx_stage_[a-z][a-z0-9-]{0,31}_main$/;
const MAX_ITERATIONS = 64;

export interface VfxStageReadiness {
  readonly id: string;
  readonly state: 'ready' | 'candidate-rejected' | 'stale' | 'rebuilding';
  readonly generation: number;
  readonly lastKnownGoodGeneration?: number;
  readonly retryable: boolean;
  readonly error?: string;
}

export interface VfxStagePlanObservation {
  readonly validatedStagePlan: VfxValidatedStagePlan;
  readonly stageReadiness: readonly VfxStageReadiness[];
  readonly stageOutput: 'active' | 'last-known-good' | 'empty';
  readonly lastKnownGoodStage:
    | { readonly fingerprint: string; readonly generation: number }
    | undefined;
}

export interface VfxValidatedStagePlan {
  readonly stages: readonly VfxGpuStageReflection[];
  readonly fingerprint: string;
  readonly generation: number;
}

export interface VfxStagePlanError {
  readonly code:
    | 'stage-id-invalid'
    | 'stage-entry-point-invalid'
    | 'stage-domain-invalid'
    | 'stage-resource-invalid'
    | 'stage-dependency-invalid'
    | 'stage-cycle'
    | 'stage-budget-invalid';
  readonly stageId: string;
  readonly hint: string;
}

export type VfxStageRecovery = 'device-loss' | 'stale';

function failure(
  code: VfxStagePlanError['code'],
  stageId: string,
  hint: string,
): { ok: false; error: VfxStagePlanError } {
  return { ok: false, error: { code, stageId, hint } };
}

function stableStage(stage: VfxGpuStageReflection): VfxGpuStageReflection {
  return {
    id: stage.id,
    entry: stage.entry,
    entryPoint: stage.entryPoint,
    domain: stage.domain,
    resources: Object.freeze(
      stage.resources.map((resource) => ({ name: resource.name, access: resource.access })),
    ),
    dependsOn: Object.freeze([...stage.dependsOn]),
    iterationBudget: stage.iterationBudget,
  };
}

/** Validate the compiler reflection before a RenderFeature can contribute it. */
export function validatedStagePlan(
  reflection: VfxGpuStageReflection[] | readonly VfxGpuStageReflection[] | undefined,
  generation: number,
):
  | { readonly ok: true; readonly value: VfxValidatedStagePlan }
  | { readonly ok: false; readonly error: VfxStagePlanError } {
  const source = reflection ?? [];
  const ids = new Set<string>();
  const stages: VfxGpuStageReflection[] = [];
  for (const stage of source) {
    if (!STAGE_ID.test(stage.id) || ids.has(stage.id)) {
      return failure(
        'stage-id-invalid',
        stage.id,
        'recook the effect with unique bounded stage ids',
      );
    }
    ids.add(stage.id);
    if (stage.domain !== 'particle' || MANAGED_STAGES.has(stage.domain)) {
      return failure('stage-domain-invalid', stage.id, 'use the managed particle dispatch domain');
    }
    if (!ENTRY_POINT.test(stage.entryPoint)) {
      return failure(
        'stage-entry-point-invalid',
        stage.id,
        'use the compiler-generated stage entry point',
      );
    }
    if (
      !Number.isInteger(stage.iterationBudget) ||
      stage.iterationBudget < 1 ||
      stage.iterationBudget > MAX_ITERATIONS
    ) {
      return failure(
        'stage-budget-invalid',
        stage.id,
        'use an integer iteration budget from 1 through 64',
      );
    }
    const resources = new Set<string>();
    for (const resource of stage.resources) {
      if (
        !RESOURCE_NAMES.has(resource.name) ||
        !['read', 'write', 'read-write'].includes(resource.access)
      ) {
        return failure(
          'stage-resource-invalid',
          stage.id,
          'declare only managed VFX resources with a supported access mode',
        );
      }
      if (resources.has(resource.name)) {
        return failure(
          'stage-resource-invalid',
          stage.id,
          'declare each managed VFX resource once',
        );
      }
      resources.add(resource.name);
    }
    stages.push(stableStage(stage));
  }
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: VfxGpuStageReflection[] = [];
  const visit = (stage: VfxGpuStageReflection): VfxStagePlanError | undefined => {
    if (visited.has(stage.id)) return undefined;
    if (visiting.has(stage.id))
      return {
        code: 'stage-cycle',
        stageId: stage.id,
        hint: 'remove the stage dependency cycle and recook the effect',
      };
    visiting.add(stage.id);
    for (const dependency of stage.dependsOn) {
      if (MANAGED_STAGES.has(dependency)) continue;
      const dependencyStage = byId.get(dependency);
      if (dependencyStage === undefined) {
        return {
          code: 'stage-dependency-invalid',
          stageId: stage.id,
          hint: 'declare every stage dependency or use a managed stage',
        };
      }
      const error = visit(dependencyStage);
      if (error !== undefined) return error;
    }
    visiting.delete(stage.id);
    visited.add(stage.id);
    ordered.push(stage);
    return undefined;
  };
  for (const stage of stages) {
    const error = visit(stage);
    if (error !== undefined) return { ok: false, error };
  }
  const normalized = Object.freeze(ordered);
  return {
    ok: true,
    value: Object.freeze({
      stages: normalized,
      fingerprint: JSON.stringify(normalized),
      generation,
    }),
  };
}

export function stageDispatches(
  plan: VfxValidatedStagePlan,
  workgroups: number,
  bindings: RenderFeatureGpuBindingsRef,
): readonly RenderFeatureGpuDispatch[] {
  return plan.stages.map((stage) => ({
    entryPoint: stage.entryPoint,
    workgroups: [workgroups] as const,
    bindings,
  }));
}

export function observeStagePlan(
  candidate: ReturnType<typeof validatedStagePlan>,
  generation: number,
  lastKnownGoodStage: VfxValidatedStagePlan | undefined,
): VfxStagePlanObservation {
  if (candidate.ok) {
    return {
      validatedStagePlan: candidate.value,
      stageReadiness: candidate.value.stages.map((stage) => ({
        id: stage.id,
        state: 'ready' as const,
        generation,
        lastKnownGoodGeneration: generation,
        retryable: false,
      })),
      stageOutput: candidate.value.stages.length === 0 ? 'empty' : 'active',
      lastKnownGoodStage:
        candidate.value.stages.length === 0
          ? lastKnownGoodStage === undefined
            ? undefined
            : {
                fingerprint: lastKnownGoodStage.fingerprint,
                generation: lastKnownGoodStage.generation,
              }
          : { fingerprint: candidate.value.fingerprint, generation },
    };
  }
  const retained = lastKnownGoodStage ?? { stages: [], fingerprint: '', generation };
  return {
    validatedStagePlan: retained,
    stageReadiness: [
      {
        id: candidate.error.stageId,
        state: 'candidate-rejected',
        generation,
        ...(lastKnownGoodStage === undefined
          ? {}
          : { lastKnownGoodGeneration: lastKnownGoodStage.generation }),
        retryable: true,
        error: candidate.error.code,
      },
    ],
    stageOutput: lastKnownGoodStage === undefined ? 'empty' : 'last-known-good',
    lastKnownGoodStage:
      lastKnownGoodStage === undefined
        ? undefined
        : {
            fingerprint: lastKnownGoodStage.fingerprint,
            generation: lastKnownGoodStage.generation,
          },
  };
}

export function stageRecoveryReadiness(
  plan: VfxValidatedStagePlan,
  generation: number,
  recovery: VfxStageRecovery,
): readonly VfxStageReadiness[] {
  return plan.stages.map((stage) => ({
    id: stage.id,
    state: recovery === 'stale' ? ('stale' as const) : ('rebuilding' as const),
    generation,
    lastKnownGoodGeneration: plan.generation,
    retryable: true,
    error: recovery,
  }));
}
