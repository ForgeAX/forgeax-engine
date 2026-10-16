import { expect, it } from 'vitest';
import { cloneRenderFeaturePlanSignatureSnapshot } from '../features/plan';

const buffer = () => ({
  kind: 'buffer' as const,
  name: 'payload',
  size: 16,
  usage: ['storage'] as const,
});

it('does not observe a resource name before the original structural comparison', () => {
  const previous = cloneRenderFeaturePlanSignatureSnapshot({ resources: [buffer()], passes: [] });
  let reads = 0;
  const resource = {
    ...buffer(),
    get name() {
      reads++;
      return 'payload';
    },
  };
  const next = cloneRenderFeaturePlanSignatureSnapshot(
    { resources: [resource], passes: [] },
    previous,
  );
  expect(reads).toBe(1);
  expect(next).toBe(previous);
});

it('retains the observed name when a getter would change on a second read', () => {
  const previous = cloneRenderFeaturePlanSignatureSnapshot({ resources: [buffer()], passes: [] });
  let reads = 0;
  const resource = {
    ...buffer(),
    get name() {
      return ++reads === 1 ? 'payload' : 'changed';
    },
  };
  const next = cloneRenderFeaturePlanSignatureSnapshot(
    { resources: [resource], passes: [] },
    previous,
  );
  expect(next).toBe(previous);
  expect(reads).toBe(1);
});

it('preserves the first source failure before inspecting its name', () => {
  const previous = cloneRenderFeaturePlanSignatureSnapshot({ resources: [buffer()], passes: [] });
  const kindFailure = new Error('kind failure');
  const nameFailure = new Error('name failure');
  const resource = {
    ...buffer(),
    get kind(): 'buffer' {
      throw kindFailure;
    },
    get name(): string {
      throw nameFailure;
    },
  };
  let failure: unknown;
  try {
    cloneRenderFeaturePlanSignatureSnapshot({ resources: [resource], passes: [] }, previous);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBe(kindFailure);
});

it('does not add a Proxy name read before its original kind and payload checks', () => {
  const previous = cloneRenderFeaturePlanSignatureSnapshot({ resources: [buffer()], passes: [] });
  const reads: PropertyKey[] = [];
  const resource = new Proxy(buffer(), {
    get(target, key, receiver) {
      reads.push(key);
      return Reflect.get(target, key, receiver);
    },
  });
  expect(
    cloneRenderFeaturePlanSignatureSnapshot({ resources: [resource], passes: [] }, previous),
  ).toBe(previous);
  expect(reads[0]).toBe('kind');
  expect(reads.filter((key) => key === 'name')).toHaveLength(1);
});
