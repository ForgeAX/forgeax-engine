import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type DeviceResourceKind,
  type DeviceScope,
  type LifecycleCleanupFailure,
  type LifecycleResourceSpec,
  LifecycleTransaction,
} from '../../device/device-scope';

/** The private value published by one complete renderer device generation. */
export interface GenerationAggregate<
  TDevice = unknown,
  TContext = unknown,
  TPipeline = unknown,
  TProducerBindings = unknown,
  TGraph = unknown,
> {
  readonly generation: number;
  readonly scope: DeviceScope;
  readonly device: TDevice;
  readonly context: TContext;
  readonly pipeline: TPipeline;
  readonly producerBindings: TProducerBindings;
  readonly graph: TGraph | undefined;
}

export interface GenerationAssemblyInput<
  TAggregate extends GenerationAggregate = GenerationAggregate,
> {
  readonly scope: TAggregate['scope'];
  readonly device: TAggregate['device'];
  readonly context: TAggregate['context'];
  readonly pipeline: TAggregate['pipeline'];
  readonly producerBindings: TAggregate['producerBindings'];
  readonly graph?: TAggregate['graph'];
  readonly roots: readonly LifecycleResourceSpec<unknown>[];
}

export interface GenerationAssemblyFailure {
  readonly code: 'generation-assembly-failed';
  readonly generation: number;
  readonly resourceKind: DeviceResourceKind;
  readonly cause: unknown;
  readonly cleanupFailures: readonly LifecycleCleanupFailure[];
}

export interface GenerationPublication<TAggregate> {
  current: TAggregate;
}

const ROOT_ORDER = new Map<DeviceResourceKind, number>([
  ['listener', 0],
  ['surface', 1],
  ['shader', 2],
  ['pipeline', 3],
  ['buffer', 4],
  ['texture', 5],
  ['binding', 6],
  ['scene-table', 7],
  ['feature', 8],
  ['post-effect', 9],
]);

function sortRoots(
  roots: readonly LifecycleResourceSpec<unknown>[],
): readonly LifecycleResourceSpec<unknown>[] {
  return roots
    .map((root, index) => ({ root, index }))
    .sort((left, right) => {
      const leftOrder = ROOT_ORDER.get(left.root.kind) ?? ROOT_ORDER.size;
      const rightOrder = ROOT_ORDER.get(right.root.kind) ?? ROOT_ORDER.size;
      return leftOrder - rightOrder || left.index - right.index;
    })
    .map(({ root }) => root);
}

/**
 * Build all device-bound roots before exposing their generation aggregate.
 * LifecycleTransaction owns creation failure rollback; this function only
 * projects its failure into the generation assembly boundary.
 */
export async function buildGenerationAggregate<
  TAggregate extends GenerationAggregate = GenerationAggregate,
>(
  input: GenerationAssemblyInput<TAggregate>,
): Promise<Result<TAggregate, GenerationAssemblyFailure>> {
  const transaction = new LifecycleTransaction(input.scope);
  for (const root of sortRoots(input.roots)) transaction.add(root);

  const lifecycle = await transaction.commit();
  if (!lifecycle.ok) {
    input.scope.abandon();
    return err({
      code: 'generation-assembly-failed',
      generation: input.scope.generation,
      resourceKind: lifecycle.error.primary.detail.resourceKind,
      cause: lifecycle.error.primary.detail.cause,
      cleanupFailures: lifecycle.error.cleanupFailures,
    });
  }

  const aggregate = Object.freeze({
    generation: input.scope.generation,
    scope: input.scope,
    device: input.device,
    context: input.context,
    pipeline: input.pipeline,
    producerBindings: input.producerBindings,
    graph: input.graph,
  }) as TAggregate;
  return ok(aggregate);
}

/** Replace the owner slot only after the complete candidate has been checked. */
export function publishGeneration<TAggregate>(
  publication: GenerationPublication<TAggregate | undefined>,
  candidate: TAggregate,
  isPublishable: (candidate: TAggregate) => boolean,
): void {
  if (!isPublishable(candidate)) {
    throw new Error('Generation candidate failed its final publication check.');
  }
  publication.current = candidate;
}
