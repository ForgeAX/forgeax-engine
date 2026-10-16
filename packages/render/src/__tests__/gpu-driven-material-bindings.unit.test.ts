import { describe, expect, it } from 'vitest';
import {
  materialBindingKey,
  materialBindingSignature,
  projectMaterialBindingClasses,
} from '../gpu-driven/material-bindings';
import type { ValidatedRenderable } from '../record/frame-snapshot';
import { buildReflectionProbeTable } from '../reflection/gpu-table';
import { defaultMaterialSnapshot } from '../render-system-extract';

describe('binding signature compatibility observations', () => {
  it('leaves ordinary primitive string Maps in the consumed-binding domain', () => {
    expect(materialBindingSignature(undefined)).toBeNull();
    expect(materialBindingSignature(new Map())).toBeNull();
    expect(materialBindingSignature(new Map([['unused', 'value']]))).toBeUndefined();
  });

  it('certifies emptiness without observing a replaced Map size getter', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Map.prototype, 'size');
    if (descriptor === undefined) throw Error('expected native Map size descriptor');
    let reads = 0;
    let empty: string | null | undefined;
    let populated: string | null | undefined;
    try {
      Object.defineProperty(Map.prototype, 'size', {
        configurable: true,
        get() {
          reads++;
          throw Error('borrowed size must not be observed');
        },
      });
      empty = materialBindingSignature(new Map());
      populated = materialBindingSignature(new Map([['receiver', 'forward']]));
    } finally {
      Object.defineProperty(Map.prototype, 'size', descriptor);
    }
    expect(reads).toBe(0);
    expect(empty).toBeNull();
    expect(populated).toBeUndefined();
  });

  it('preserves full serialization for subclasses and nonprimitive values', () => {
    class BindingMap extends Map<string, string> {}
    expect(materialBindingSignature(new BindingMap([['unused', 'value']]))).toBe(
      '[["unused","value"]]',
    );
    const trace: string[] = [];
    const value = {
      toJSON() {
        trace.push('toJSON');
        return 'observed';
      },
    };
    const map = new Map([['unused', value]]) as unknown as ReadonlyMap<string, string>;
    expect(materialBindingSignature(map)).toBe('[["unused","observed"]]');
    expect(materialBindingSignature(map)).toBe('[["unused","observed"]]');
    expect(trace).toEqual(['toJSON', 'toJSON']);
  });

  it('does not add caller traps before unknown iteration and preserves its error identity', () => {
    const trace: PropertyKey[] = [];
    const failure = new Error('original iterator');
    const map = new Proxy(new Map<string, string>(), {
      get(_target, key) {
        trace.push(key);
        throw failure;
      },
      getPrototypeOf() {
        throw new Error('new prototype observation');
      },
      ownKeys() {
        throw new Error('new property observation');
      },
    });
    let caught: unknown;
    try {
      materialBindingSignature(map);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(trace).toEqual([Symbol.iterator]);
  });

  it('uses legacy serialization when intrinsic iteration or JSON formatting is replaced', () => {
    const map = new Map([['unconsumed', 'value']]);
    const iterator = Map.prototype[Symbol.iterator];
    let iterations = 0;
    let result: string | null | undefined;
    try {
      Map.prototype[Symbol.iterator] = function () {
        iterations++;
        return iterator.call(this);
      };
      result = materialBindingSignature(map);
    } finally {
      Map.prototype[Symbol.iterator] = iterator;
    }
    expect(result).toBe('[["unconsumed","value"]]');
    expect(iterations).toBe(1);
    const original = JSON.stringify;
    let captured: unknown;
    try {
      JSON.stringify = ((value: unknown) => {
        captured = value;
        return original(value);
      }) as typeof JSON.stringify;
      result = materialBindingSignature(map);
    } finally {
      JSON.stringify = original;
    }
    expect(result).toBe('[["unconsumed","value"]]');
    expect(captured).toEqual([['unconsumed', 'value']]);
  });

  it('retains the legacy string coercion when array serialization returns undefined', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
    let result: string | null | undefined;
    try {
      Object.defineProperty(Array.prototype, 'toJSON', {
        configurable: true,
        value: () => undefined,
      });
      result = materialBindingSignature(new Map([['unconsumed', 'value']]));
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(Array.prototype, 'toJSON');
      else Object.defineProperty(Array.prototype, 'toJSON', descriptor);
    }
    expect(result).toBe('undefined');
  });
});

function row(
  entityKey: number,
  deferredPass: boolean,
): Pick<ValidatedRenderable, 'source' | 'renderableIndex'> {
  const material = { ...defaultMaterialSnapshot(7), deferredPass };
  return {
    renderableIndex: entityKey,
    source: {
      worldId: 0,
      entityKey,
      assetHandle: 1,
      transform: { world: new Float32Array(16) },
      material,
      materials: [material],
      materialBindingSources: ['engine-default'],
    },
  };
}

describe('GPU material binding classes', () => {
  it.each([
    true,
    false,
  ])('retains probe bindings and observes real probe replacement (Deferred=%s)', (deferred) => {
    const receiver = row(1, deferred);
    const probes = (index: number) => ({
      selections: new Map([
        ['0:1', { kind: 'probe' as const, worldId: 0, entityKey: 7, normalizedDistance: 0 }],
      ]),
      table: buildReflectionProbeTable([
        {
          primitiveKey: '0:7',
          index,
          worldId: 0,
          entityKey: 7,
          center: [0, 0, 0],
          halfExtents: [1, 1, 1],
          intensity: 1,
          generation: 1,
        },
      ]),
    });
    const visible = projectMaterialBindingClasses([receiver], probes(2));
    const reindexed = { ...receiver, renderableIndex: 0 };
    expect([...projectMaterialBindingClasses([reindexed], probes(2))]).toEqual([...visible]);
    expect([...visible]).toEqual([
      [materialBindingKey(receiver.source, 7), `${deferred ? '' : 'forward'}|probe:2`],
    ]);
    expect([...projectMaterialBindingClasses([receiver], probes(3))]).not.toEqual([...visible]);
  });

  it('keeps authored Deferred membership independent of the camera index domain', () => {
    const receiver = row(1, true);
    const visible = projectMaterialBindingClasses([receiver]);
    const reindexed = { ...receiver, renderableIndex: 0 };
    const hidden = projectMaterialBindingClasses([reindexed]);
    expect([...hidden]).toEqual([...visible]);
    expect(hidden.size).toBe(0);
  });

  it('keeps Forward receivers classified without a camera dispatch', () => {
    const receiver = row(1, false);
    expect([...projectMaterialBindingClasses([receiver])]).toEqual([
      [materialBindingKey(receiver.source, 7), 'forward|probe:'],
    ]);
  });

  it('takes mixed submesh pass membership from each authored material', () => {
    const receiver = row(1, true);
    const mixed = {
      ...receiver,
      source: {
        ...receiver.source,
        materials: [
          receiver.source.material,
          { ...defaultMaterialSnapshot(8), deferredPass: false },
        ],
      },
    };
    expect([...projectMaterialBindingClasses([mixed])]).toEqual([
      [materialBindingKey(receiver.source, 8), 'forward|probe:'],
    ]);
  });
});
