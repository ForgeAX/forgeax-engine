import { describe, expect, it } from 'vitest';
import { serializeFrameGraphKey } from '../frame-graph-key';

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
