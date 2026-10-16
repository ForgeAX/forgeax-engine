import { describe, expect, it } from 'vitest';
import {
  buildGenerationAggregate,
  type GenerationAggregate,
} from '../assembly/recovery/generation';
import { DeviceScope, type LifecycleResourceSpec } from '../device/device-scope';

type FailureAggregate = GenerationAggregate<
  { readonly id: string },
  { readonly id: string },
  { readonly id: string },
  { readonly id: string },
  { readonly id: string }
>;

const kinds: LifecycleResourceSpec<unknown>['kind'][] = [
  'surface',
  'pipeline',
  'buffer',
  'texture',
  'feature',
];

function root(
  kind: LifecycleResourceSpec<unknown>['kind'],
  events: string[],
  failure: boolean,
): LifecycleResourceSpec<unknown> {
  return {
    kind,
    create: () => {
      events.push(`create:${kind}`);
      if (failure) throw new Error(`failure:${kind}`);
      return { kind };
    },
    cleanup: () => {
      events.push(`cleanup:${kind}`);
    },
  };
}

function aggregate(scope: DeviceScope): FailureAggregate {
  return Object.freeze({
    generation: scope.generation,
    scope,
    device: { id: `device-${scope.generation}` },
    context: { id: `context-${scope.generation}` },
    pipeline: { id: `pipeline-${scope.generation}` },
    producerBindings: { id: `producers-${scope.generation}` },
    graph: { id: `graph-${scope.generation}` },
  });
}

describe('generation assembly failure matrix', () => {
  it.each(kinds)('abandons a candidate when the %s root fails', async (failedKind) => {
    const events: string[] = [];
    const activeScope = DeviceScope.create(9, 'renderer');
    const active = aggregate(activeScope);
    const candidateScope = DeviceScope.create(11, 'renderer');
    const result = await buildGenerationAggregate<FailureAggregate>({
      scope: candidateScope,
      device: { id: 'device-11' },
      context: { id: 'context-11' },
      pipeline: { id: 'pipeline-11' },
      producerBindings: { id: 'producers-11' },
      graph: { id: 'graph-11' },
      roots: kinds.map((kind) => root(kind, events, kind === failedKind)),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('generation-assembly-failed');
    expect(result.error.generation).toBe(11);
    expect(result.error.resourceKind).toBe(failedKind);
    expect(result.error.cleanupFailures).toEqual([]);
    expect(candidateScope.state).toBe('abandoned');
    expect(events.filter((event) => event.startsWith('cleanup:'))).toEqual(
      events
        .filter((event) => event.startsWith('create:') && !event.endsWith(failedKind))
        .reverse()
        .map((event) => event.replace('create:', 'cleanup:')),
    );
    expect(active.scope.state).toBe('active');
    expect(active.generation).toBe(9);
  });

  it('keeps the active aggregate unchanged when candidate publication is skipped', async () => {
    const events: string[] = [];
    const activeScope = DeviceScope.create(20, 'renderer');
    const active = aggregate(activeScope);
    const candidateScope = DeviceScope.create(22, 'renderer');
    const result = await buildGenerationAggregate<FailureAggregate>({
      scope: candidateScope,
      device: { id: 'device-22' },
      context: { id: 'context-22' },
      pipeline: { id: 'pipeline-22' },
      producerBindings: { id: 'producers-22' },
      graph: { id: 'graph-22' },
      roots: [root('surface', events, false), root('pipeline', events, true)],
    });

    expect(result.ok).toBe(false);
    expect(active).toEqual(aggregate(activeScope));
    expect(active.scope.state).toBe('active');
    expect(candidateScope.generation).toBe(22);
    expect(events).toEqual(['create:surface', 'create:pipeline', 'cleanup:surface']);
  });
});
