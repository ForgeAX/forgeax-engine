// feat-20260621 M-C w27 (verify round 1 V2 / AC-A4): the write surface of a
// `'buffer'` / `'buffer<N>'` field must accept any AllowSharedBufferSource view
// (Float32Array / ArrayBuffer / Uint8Array), not Uint8Array alone. The read
// side stays Uint8Array. HUMAN DECISION = widen (strict superset): any view is
// normalized to Uint8Array at the single ECS buffer-write ingestion point, so
// existing Uint8Array callers are unaffected.
//
// RED before w28: `world.set(e, C, { data: Float32Array.of(...) })` and
// `{ data: new ArrayBuffer(16) }` fail to type-check (FieldInputType<'buffer'>
// = Uint8Array). GREEN after w28: all three view types compile and round-trip
// to the correct bytes through the read side.

import { describe, expect, it } from 'vitest';
import { type Component, defineComponent } from '../component';
import { World } from '../world';

describe('M-C w27: buffer-field write accepts AllowSharedBufferSource (AC-A4)', () => {
  it("variable 'buffer' field accepts Float32Array on world.set + round-trips bytes", () => {
    const Params = defineComponent('W27VarBuffer', { data: { type: 'buffer' } });
    const w = new World();
    const e = w.spawn({ component: Params, data: { data: new Uint8Array(16) } }).unwrap();

    const src = Float32Array.of(1.5, 0, 0, 0);
    // Typed write surface accepts Float32Array (widened input type).
    w.set(e, Params, { data: src }).unwrap();

    const out = w.get(e, Params).unwrap();
    // Read side is Uint8Array; bytes match the Float32Array little-endian layout.
    expect(out.data).toBeInstanceOf(Uint8Array);
    expect(out.data.byteLength).toBe(16);
    expect(new Float32Array(out.data.buffer, out.data.byteOffset, 4)[0]).toBeCloseTo(1.5);
  });

  it("variable 'buffer' field accepts ArrayBuffer on world.set + round-trips bytes", () => {
    const Params = defineComponent('W27VarBufferAB', { data: { type: 'buffer' } });
    const w = new World();
    const e = w.spawn({ component: Params, data: { data: new Uint8Array(8) } }).unwrap();

    const ab = new ArrayBuffer(8);
    new DataView(ab).setUint32(0, 0xdeadbeef, true);
    // Typed write surface accepts a raw ArrayBuffer.
    w.set(e, Params, { data: ab }).unwrap();

    const out = w.get(e, Params).unwrap();
    expect(out.data).toBeInstanceOf(Uint8Array);
    expect(out.data.byteLength).toBe(8);
    expect(new DataView(out.data.buffer, out.data.byteOffset).getUint32(0, true)).toBe(0xdeadbeef);
  });

  it("variable 'buffer' field still accepts Uint8Array (zero-regression control)", () => {
    const Params = defineComponent('W27VarBufferU8', { data: { type: 'buffer' } });
    const w = new World();
    const e = w.spawn({ component: Params, data: { data: new Uint8Array(4) } }).unwrap();

    const u8 = Uint8Array.of(10, 20, 30, 40);
    w.set(e, Params, { data: u8 }).unwrap();

    const out = w.get(e, Params).unwrap();
    expect(Array.from(out.data)).toEqual([10, 20, 30, 40]);
  });

  it("fixed 'buffer<N>' field accepts Float32Array of matching byteLength + round-trips", () => {
    const Params = defineComponent('W27FixedBuffer', { data: { type: 'buffer<16>' } });
    const w = new World();
    const e = w.spawn({ component: Params, data: { data: new Uint8Array(16) } }).unwrap();

    const src = Float32Array.of(2, 3, 4, 5);
    w.set(e, Params, { data: src }).unwrap();

    const out = w.get(e, Params).unwrap();
    expect(out.data).toBeInstanceOf(Uint8Array);
    expect(out.data.byteLength).toBe(16);
    const view = new Float32Array(out.data.buffer, out.data.byteOffset, 4);
    expect(Array.from(view)).toEqual([2, 3, 4, 5]);
  });

  it("spawn data accepts AllowSharedBufferSource on a 'buffer' field", () => {
    const Params = defineComponent('W27SpawnBuffer', { data: { type: 'buffer' } });
    const w = new World();
    // Float32Array passed directly to spawn data (widened input type).
    const e = w.spawn({ component: Params, data: { data: Float32Array.of(9, 0, 0, 0) } }).unwrap();

    const out = w.get(e, Params).unwrap();
    expect(out.data.byteLength).toBe(16);
    expect(new Float32Array(out.data.buffer, out.data.byteOffset, 4)[0]).toBeCloseTo(9);
  });

  // Type-level: FieldInputType<'buffer'> must be assignable from all three views.
  it('FieldInputType<buffer> accepts the three AllowSharedBufferSource subtypes (compile-time)', () => {
    const Params = defineComponent('W27TypeProbe', { data: { type: 'buffer' } });
    const w = new World();
    const e = w.spawn({ component: Params, data: { data: new Uint8Array(16) } }).unwrap();
    void (Params as Component);
    // These three lines are the AC-A4 compile gate: red before widen, green after.
    w.set(e, Params, { data: Float32Array.of(1, 2, 3, 4) });
    w.set(e, Params, { data: new ArrayBuffer(16) });
    w.set(e, Params, { data: new Uint8Array(16) });
  });
});
