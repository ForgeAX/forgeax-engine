import { describe, expect, it } from 'vitest';
import {
  buildGenerationAggregate,
  type GenerationAggregate,
  type GenerationPublication,
  publishGeneration,
} from '../assembly/recovery/generation';
import { DeviceScope, type LifecycleResourceSpec } from '../device/device-scope';

type TestAggregate = GenerationAggregate<
  { readonly id: string },
  { readonly id: string },
  { readonly id: string },
  { readonly id: string },
  { readonly id: string }
>;

function root(
  kind: LifecycleResourceSpec<unknown>['kind'],
  order: string[],
): LifecycleResourceSpec<unknown> {
  return {
    kind,
    create: () => {
      order.push(`create:${kind}`);
      return { kind };
    },
    cleanup: () => {
      order.push(`cleanup:${kind}`);
    },
  };
}

describe('generation assembly', () => {
  it('keeps the candidate detached and publishes one immutable aggregate', async () => {
    const order: string[] = [];
    const scope = DeviceScope.create(4, 'renderer');
    const candidate = await buildGenerationAggregate<TestAggregate>({
      scope,
      device: { id: 'device-4' },
      context: { id: 'context-4' },
      pipeline: { id: 'pipeline-4' },
      producerBindings: { id: 'producers-4' },
      graph: { id: 'graph-4' },
      roots: [root('surface', order), root('pipeline', order)],
    });

    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;

    const publication: GenerationPublication<TestAggregate | undefined> = {
      current: undefined,
    };
    expect(publication.current).toBeUndefined();
    expect(Object.isFrozen(candidate.value)).toBe(true);
    expect(candidate.value.generation).toBe(4);
    expect(candidate.value.scope).toBe(scope);
    expect(order).toEqual(['create:surface', 'create:pipeline']);

    publishGeneration(publication, candidate.value, (value) => value.scope.isAlive());

    expect(publication.current).toBe(candidate.value);
    expect(publication.current?.device.id).toBe('device-4');
    expect(publication.current?.context.id).toBe('context-4');
    expect(publication.current?.pipeline.id).toBe('pipeline-4');
  });
});
