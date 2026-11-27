import { describe, expect, it } from 'vitest';
import {
  retainedFrameGraphPolicy,
  retainedFrameGraphPolicyMatches,
  serializeFrameGraphKey,
} from '../frame-graph-key';

function input() {
  return {
    topology: {
      standardProfile: { renderPath: 'forward' },
      config: { enabled: false },
      shadow: { cascades: [1, 2, 3] },
    },
    observationCaptureDomains: [] as string[],
  };
}

describe('current frame graph key', () => {
  it('serializes current nested facts and preserves previous key bytes', () => {
    const source = input();
    const first = serializeFrameGraphKey(source);
    expect(first).toBe(JSON.stringify(source));
    source.topology.shadow.cascades[1] = 7;
    const next = serializeFrameGraphKey(source);
    expect(next).toBe(JSON.stringify(source));
    expect(next).not.toBe(first);
    expect(JSON.parse(first).topology.shadow.cascades).toEqual([1, 2, 3]);
  });

  it('observes borrowed getters exactly once on every serialization', () => {
    let reads = 0;
    let enabled = false;
    const source = {
      topology: {
        config: {
          get enabled() {
            reads++;
            return enabled;
          },
        },
      },
    };
    const first = serializeFrameGraphKey(source);
    expect(reads).toBe(1);
    expect(serializeFrameGraphKey(source)).toBe(first);
    expect(reads).toBe(2);
    enabled = true;
    expect(serializeFrameGraphKey(source)).not.toBe(first);
    expect(reads).toBe(3);
  });

  it('retains native toJSON, non-finite and cyclic-input semantics', () => {
    let calls = 0;
    const source = {
      topology: {
        standardProfile: Object.freeze({
          toJSON() {
            calls++;
            return { renderPath: 'forward', unsupported: NaN };
          },
        }),
      },
    };
    const first = serializeFrameGraphKey(source);
    expect(JSON.parse(first).topology.standardProfile.unsupported).toBeNull();
    expect(serializeFrameGraphKey(source)).toBe(first);
    expect(calls).toBe(2);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => serializeFrameGraphKey({ topology: { config: cyclic } })).toThrow(TypeError);
  });

  it('observes mutable descendants of shallow-frozen objects and custom nodes', () => {
    const child = { enabled: false };
    const source = { topology: Object.freeze({ child }), extension: new Date('2026-01-01Z') };
    const first = serializeFrameGraphKey(source);
    child.enabled = true;
    const second = serializeFrameGraphKey(source);
    expect(second).not.toBe(first);
    source.extension.setUTCDate(2);
    expect(serializeFrameGraphKey(source)).not.toBe(second);
  });

  it('distinguishes same-count domains and physical capture slots', () => {
    const source = { ...input(), cubeCaptureSlots: [{ depthSlice: 1 }] };
    source.observationCaptureDomains.push('color');
    const first = serializeFrameGraphKey(source);
    source.observationCaptureDomains[0] = 'depth';
    const second = serializeFrameGraphKey(source);
    expect(second).not.toBe(first);
    const slot = source.cubeCaptureSlots[0];
    if (slot === undefined) throw new Error('Expected one capture slot');
    slot.depthSlice = 2;
    expect(serializeFrameGraphKey(source)).not.toBe(second);
  });
});

it('requires an installed receiver policy for capsule, compact GBuffer and Terrain', () => {
  const directional = { mapSize: 1024, cascadeCount: 4 as const };
  expect(retainedFrameGraphPolicyMatches(undefined, directional, false)).toBe(true);
  expect(retainedFrameGraphPolicyMatches(undefined, directional, false, 'standard-gbuffer/4')).toBe(
    false,
  );
  expect(retainedFrameGraphPolicyMatches(undefined, directional, true)).toBe(false);
  expect(
    retainedFrameGraphPolicyMatches(
      undefined,
      {
        ...directional,
        terrainReceivers: [{ entityKey: 1 }],
      },
      false,
    ),
  ).toBe(false);
});

it('owns the installed GBuffer and directional receiver identities through candidate failures', () => {
  const receiver = { entityKey: 1 };
  const directional = { mapSize: 1024, cascadeCount: 4 as const, terrainReceivers: [receiver] };
  const policy = retainedFrameGraphPolicy({
    shadow: { directional, pointCount: 0, pointFaceSize: 0, spotCount: 0, spotMapSize: 0 },
    compactGbuffer: 'standard-gbuffer/4',
  });
  expect(retainedFrameGraphPolicyMatches(policy, directional, false)).toBe(false);
  expect(retainedFrameGraphPolicyMatches(policy, directional, false, 'standard-gbuffer/4')).toBe(
    true,
  );
  receiver.entityKey = 2;
  expect(retainedFrameGraphPolicyMatches(policy, directional, false, 'standard-gbuffer/4')).toBe(
    false,
  );
});

it('requires the current static layer admission before reusing a graph after a rejected candidate', () => {
  const directional = { mapSize: 32, cascadeCount: 1 as const };
  const policy = retainedFrameGraphPolicy({
    shadow: {
      directional,
      pointCount: 2,
      pointFaceSize: 32,
      pointStaticMask: 2,
      spotCount: 1,
      spotMapSize: 32,
      spotStaticMask: 1,
    },
  });
  const current = { directional: true, pointMask: 2, spotMask: 1 };
  const matches = (layers: typeof current) =>
    retainedFrameGraphPolicyMatches(policy, directional, false, undefined, false, layers);
  expect(matches(current)).toBe(true);
  expect(matches({ ...current, pointMask: 0 })).toBe(false);
  expect(matches({ ...current, spotMask: 0 })).toBe(false);
  expect(matches({ ...current, directional: false })).toBe(false);
});
