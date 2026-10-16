import { describe, expect, it } from 'vitest';
import {
  cloneOwnedRenderFeaturePlanSignatureSnapshot,
  cloneRenderFeaturePlanSignatureSnapshot,
  type RenderFeatureSignatureTokenReuseMetrics,
  type RenderFeatureWorkPlan,
  renderFeaturePlanSignatureSnapshotEquals,
} from '../features/plan';

const code = '// unchanged WGSL\n'.repeat(1000);
const program = (name: string, wgsl = code) => ({
  kind: 'compute-program' as const,
  name,
  program: { wgsl, entryPoints: ['main'] },
});
const metrics = (): RenderFeatureSignatureTokenReuseMetrics => ({
  lookups: 0,
  hits: 0,
  remembered: 0,
  serializedCharacters: 0,
  environmentFallbacks: 0,
  budgetFallbacks: 0,
});

it('reuses only already serialized primitive evidence within the current clone', () => {
  const plan = {
    resources: Array.from({ length: 16 }, (_, index) => program(`p-${index}`)),
    passes: [],
  };
  const count = metrics();
  const actual = cloneOwnedRenderFeaturePlanSignatureSnapshot(plan, undefined, count);
  expect(actual).toEqual(cloneRenderFeaturePlanSignatureSnapshot(plan));
  expect(count).toMatchObject({ remembered: 1, hits: 15, serializedCharacters: code.length });
  // The table dies at the invocation boundary; no cross-frame/cross-Host authority.
  const next = metrics();
  cloneOwnedRenderFeaturePlanSignatureSnapshot(plan, undefined, next);
  expect(next).toEqual(count);
});

it('preserves cold/all-unique serialization and invalidates changed WGSL and reflection', () => {
  const plan = {
    resources: Array.from({ length: 16 }, (_, index) => program(`p-${index}`, code + index)),
    passes: [],
  };
  const count = metrics();
  const previous = cloneOwnedRenderFeaturePlanSignatureSnapshot(plan, undefined, count);
  expect(count).toMatchObject({ remembered: 16, hits: 0 });
  expect(previous).toEqual(cloneRenderFeaturePlanSignatureSnapshot(plan));
  const changed = {
    resources: plan.resources.map((resource, index) =>
      index === 0 ? program(resource.name, `${code}new`) : resource,
    ),
    passes: [],
  };
  changed.resources[1]?.program.entryPoints.push('changed');
  expect(renderFeaturePlanSignatureSnapshotEquals(changed, previous)).toBe(false);
  expect(cloneOwnedRenderFeaturePlanSignatureSnapshot(changed, previous)).toEqual(
    cloneRenderFeaturePlanSignatureSnapshot(changed, previous),
  );
});

it('does no token indexing for empty, short-string or upload-only plans', () => {
  const buffer = {
    kind: 'buffer' as const,
    name: 'data',
    size: 4,
    usage: ['storage'] as const,
    data: Uint32Array.of(1),
  };
  const plan: RenderFeatureWorkPlan = { resources: [buffer], passes: [] };
  const previous = cloneOwnedRenderFeaturePlanSignatureSnapshot(plan);
  const count = metrics();
  expect(
    cloneOwnedRenderFeaturePlanSignatureSnapshot({ resources: [], passes: [] }, undefined, count),
  ).toEqual(cloneRenderFeaturePlanSignatureSnapshot({ resources: [], passes: [] }));
  expect(
    cloneOwnedRenderFeaturePlanSignatureSnapshot(
      { resources: [{ ...buffer, data: Uint32Array.of(2) }], passes: [] },
      previous,
      count,
    ),
  ).toBe(previous);
  expect(count).toEqual(metrics());
});

it('bounds call-local references and delegates budget misses without rejecting work', () => {
  const plan = {
    resources: Array.from({ length: 66 }, (_, index) => program(`p-${index}`, code + index)),
    passes: [],
  };
  const count = metrics();
  expect(cloneOwnedRenderFeaturePlanSignatureSnapshot(plan, undefined, count)).toEqual(
    cloneRenderFeaturePlanSignatureSnapshot(plan),
  );
  expect(count).toMatchObject({ remembered: 64, budgetFallbacks: 2, hits: 0 });
  const huge = { resources: [program('large', '\0'.repeat(700_000))], passes: [] };
  const bytes = metrics();
  expect(cloneOwnedRenderFeaturePlanSignatureSnapshot(huge, undefined, bytes)).toEqual(
    cloneRenderFeaturePlanSignatureSnapshot(huge),
  );
  expect(bytes).toMatchObject({ remembered: 0, budgetFallbacks: 1 });
});

function observedPlan(trace: string[], fail?: string): RenderFeatureWorkPlan {
  const resources = ['first', 'second'].map(
    (name) =>
      new Proxy(
        {
          kind: 'compute-program' as const,
          name,
          program: new Proxy(
            { wgsl: code, entryPoints: ['main'] },
            {
              get(target, key, receiver) {
                trace.push(`${name}.program.${String(key)}`);
                if (`${name}.${String(key)}` === fail) throw new Error(fail);
                return Reflect.get(target, key, receiver);
              },
              ownKeys(target) {
                trace.push(`${name}.program.keys`);
                return Reflect.ownKeys(target);
              },
              getOwnPropertyDescriptor(target, key) {
                trace.push(`${name}.program.own.${String(key)}`);
                return Reflect.getOwnPropertyDescriptor(target, key);
              },
            },
          ),
        },
        {
          get(target, key, receiver) {
            trace.push(`${name}.${String(key)}`);
            if (`${name}.${String(key)}` === fail) throw new Error(fail);
            return Reflect.get(target, key, receiver);
          },
          ownKeys(target) {
            trace.push(`${name}.keys`);
            return Reflect.ownKeys(target);
          },
          getOwnPropertyDescriptor(target, key) {
            trace.push(`${name}.own.${String(key)}`);
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        },
      ),
  );
  return { resources, passes: [] };
}

describe('exact author observation and failure order', () => {
  it.each([
    undefined,
    'first.kind',
    'first.name',
    'second.entryPoints',
    'second.wgsl',
  ])('preserves the original getter/Proxy trace and failure: %s', (failure) => {
    const oldTrace: string[] = [],
      newTrace: string[] = [];
    let oldResult: ReturnType<typeof cloneRenderFeaturePlanSignatureSnapshot> | undefined;
    let newResult: ReturnType<typeof cloneRenderFeaturePlanSignatureSnapshot> | undefined;
    let oldFailure: unknown, newFailure: unknown;
    try {
      oldResult = cloneRenderFeaturePlanSignatureSnapshot(observedPlan(oldTrace, failure));
    } catch (error) {
      oldFailure = error;
    }
    try {
      newResult = cloneOwnedRenderFeaturePlanSignatureSnapshot(observedPlan(newTrace, failure));
    } catch (error) {
      newFailure = error;
    }
    expect(newTrace).toEqual(oldTrace);
    expect(newResult).toEqual(oldResult);
    expect(newFailure).toEqual(oldFailure);
  });

  it.each([
    'data',
    'accessor',
  ] as const)('preserves a formatter failure installed by an author getter: %s', (kind) => {
    const original = Object.getOwnPropertyDescriptor(JSON, 'stringify');
    if (original === undefined) throw new Error('Missing platform stringify property');
    const failure = new Error('original formatter failure');
    const run = (owned: boolean) => {
      let getterReads = 0;
      const second = {
        ...program('second'),
        program: {
          entryPoints: ['main'],
          get wgsl() {
            if (kind === 'data')
              Object.defineProperty(JSON, 'stringify', {
                ...original,
                value: () => {
                  throw failure;
                },
              });
            else
              Object.defineProperty(JSON, 'stringify', {
                configurable: true,
                get() {
                  getterReads++;
                  return () => {
                    throw failure;
                  };
                },
              });
            return code;
          },
        },
      };
      let caught: unknown;
      try {
        (owned
          ? cloneOwnedRenderFeaturePlanSignatureSnapshot
          : cloneRenderFeaturePlanSignatureSnapshot)({
          resources: [program('first'), second],
          passes: [],
        });
      } catch (error) {
        caught = error;
      } finally {
        Object.defineProperty(JSON, 'stringify', original);
      }
      return { caught, getterReads };
    };
    expect(run(true)).toEqual(run(false));
    expect(run(true).caught).toBe(failure);
  });
});
