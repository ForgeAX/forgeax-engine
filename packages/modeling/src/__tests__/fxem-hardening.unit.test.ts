import { describe, expect, it } from 'vitest';
import { decodeSnapshot, encodeSnapshot } from '../fxem';
import { model } from '../model';
import { sel } from '../selectors';

const HEADER = 64;
const ENTRY = 24;

interface Entry {
  kind: number;
  elem: number;
  count: number;
  start: number;
  length: number;
}

function sample(): Uint8Array {
  const m = model();
  m.box({ size: [1, 1, 1], tag: 'body' });
  m.inset(sel.facing('+y'), { thickness: 0.1, region: 'merged', label: 'panel' });
  m.tag(sel.all(), 'second');
  m.assign(sel.createdBy('panel', 'inner'), 'glow');
  m.uv.project({ mode: 'box', scale: 1 });
  return m.snapshot();
}

function entriesOf(bytes: Uint8Array): Entry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(20, true);
  return Array.from({ length: count }, (_, i) => {
    const at = HEADER + i * ENTRY;
    return {
      kind: view.getUint32(at, true),
      elem: view.getUint32(at + 4, true),
      count: view.getUint32(at + 8, true),
      start: view.getUint32(at + 12, true),
      length: view.getUint32(at + 16, true),
    };
  });
}

function entryOf(bytes: Uint8Array, kind: number): Entry {
  const found = entriesOf(bytes).find((e) => e.kind === kind);
  if (found === undefined) throw new Error(`no section ${kind}`);
  return found;
}

/** Replace the strings section by appended bytes; the table entry points at the copy. */
function withStrings(bytes: Uint8Array, edit: (strings: Record<string, unknown>) => void) {
  const s = entryOf(bytes, 13);
  const index = entriesOf(bytes).findIndex((e) => e.kind === 13);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(s.start, s.start + s.length)));
  edit(json);
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const out = new Uint8Array(bytes.length + encoded.length + 16);
  out.set(bytes);
  out.set(encoded, bytes.length);
  const view = new DataView(out.buffer);
  const at = HEADER + index * ENTRY;
  view.setUint32(at + 8, encoded.length, true);
  view.setUint32(at + 12, bytes.length, true);
  view.setUint32(at + 16, encoded.length, true);
  return out;
}

function expectStructured(result: ReturnType<typeof decodeSnapshot>) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe('model-precondition');
  expect(result.error.expected).not.toContain('unexpected');
}

describe('FXEM decoder hardening', () => {
  it('derives tagWords from the tag count instead of trusting the strings section', () => {
    const bytes = withStrings(sample(), (s) => {
      s.tagWords = 1_000_000_000;
    });
    const started = performance.now();
    expectStructured(decodeSnapshot(bytes));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('returns a Result for malformed strings JSON', () => {
    const bytes = sample();
    const s = entryOf(bytes, 13);
    const broken = bytes.slice();
    broken[s.start] = 0x7c;
    expectStructured(decodeSnapshot(broken));
  });

  it('returns a Result for a position section that is not a whole number of doubles', () => {
    const bytes = sample();
    const index = entriesOf(bytes).findIndex((e) => e.kind === 1);
    const broken = bytes.slice();
    const view = new DataView(broken.buffer);
    const at = HEADER + index * ENTRY;
    view.setUint32(at + 16, view.getUint32(at + 16, true) - 3, true);
    expectStructured(decodeSnapshot(broken));
  });

  it('does not spread a huge name table into a call', () => {
    const bytes = withStrings(sample(), (s) => {
      s.labels = Array.from({ length: 300_000 }, (_, i) => `l${i}`);
    });
    const decoded = decodeSnapshot(bytes);
    expect(decoded.ok && decoded.value.labelNames).toHaveLength(300_000);
  });

  it('rejects an inflated face length without replaying it', () => {
    const bytes = sample();
    const broken = bytes.slice();
    new DataView(broken.buffer).setInt32(entryOf(bytes, 7).start, 2_000_000, true);
    expectStructured(decodeSnapshot(broken));
  });

  it('range-checks label, role and material indices', () => {
    const bytes = sample();
    for (const kind of [8, 9, 10]) {
      const broken = bytes.slice();
      new DataView(broken.buffer).setInt32(entryOf(bytes, kind).start, 999, true);
      expectStructured(decodeSnapshot(broken));
      const negative = bytes.slice();
      new DataView(negative.buffer).setInt32(entryOf(bytes, kind).start, -1, true);
      expectStructured(decodeSnapshot(negative));
    }
  });

  it('rejects non-finite positions', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const bytes = sample();
      const broken = bytes.slice();
      new DataView(broken.buffer).setFloat64(entryOf(bytes, 1).start, value, true);
      expectStructured(decodeSnapshot(broken));
    }
  });

  it('rejects tag bits beyond the tag table', () => {
    const bytes = sample();
    const broken = bytes.slice();
    new DataView(broken.buffer).setUint32(entryOf(bytes, 12).start, 0xffffffff, true);
    expectStructured(decodeSnapshot(broken));
  });

  it('rejects out-of-range half-edge links', () => {
    const bytes = sample();
    const broken = bytes.slice();
    new DataView(broken.buffer).setInt32(entryOf(bytes, 3).start, 1 << 30, true);
    expectStructured(decodeSnapshot(broken));
  });

  it('rejects a duplicate section kind and a section length that disagrees with its count', () => {
    const bytes = sample();
    const dup = bytes.slice();
    const view = new DataView(dup.buffer);
    view.setUint32(HEADER + ENTRY, 1, true);
    expectStructured(decodeSnapshot(dup));
    const index = entriesOf(bytes).findIndex((e) => e.kind === 4);
    const lie = bytes.slice();
    new DataView(lie.buffer).setUint32(HEADER + index * ENTRY + 8, 5, true);
    expectStructured(decodeSnapshot(lie));
  });

  it('rejects a section table that claims more entries than the bytes hold', () => {
    const bytes = sample().slice();
    new DataView(bytes.buffer).setUint32(20, 0xffffffff, true);
    expectStructured(decodeSnapshot(bytes));
  });

  it('survives seeded mutation fuzzing: no throw, bounded time, valid mesh or structured error', () => {
    const seeds = [sample(), boxBytes()];
    let state = 0x9e3779b9;
    const next = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const below = (n: number) => Math.floor(next() * n);
    let accepted = 0;
    let rejected = 0;
    const cases = 2400;
    const before = process.memoryUsage().arrayBuffers;
    for (let i = 0; i < cases; i++) {
      let bytes = (seeds[i % seeds.length] as Uint8Array).slice();
      const edits = 1 + below(4);
      for (let e = 0; e < edits; e++) {
        const kind = below(5);
        if (kind === 0) {
          bytes[below(bytes.length)] = below(256);
        } else if (kind === 1) {
          bytes[below(HEADER + ENTRY * 16)] = below(256);
        } else if (kind === 2) {
          bytes = bytes.slice(0, below(bytes.length));
        } else if (kind === 3) {
          const extended = new Uint8Array(bytes.length + 1 + below(64));
          extended.set(bytes);
          for (let k = bytes.length; k < extended.length; k++) extended[k] = below(256);
          bytes = extended;
        } else {
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          const at = below(Math.max(1, bytes.length - 3)) & ~3;
          if (at + 4 <= bytes.length) {
            const big = [0, 1, 0x7fffffff, 0x80000000, 0xffffffff, 1 << 20][below(6)] as number;
            view.setUint32(at, big, true);
          }
        }
        if (bytes.length === 0) break;
      }
      const started = performance.now();
      const result = decodeSnapshot(bytes);
      expect(performance.now() - started).toBeLessThan(1000);
      if (result.ok) {
        accepted++;
        const again = encodeSnapshot(result.value);
        expect(again.byteLength).toBeGreaterThan(0);
        expect(decodeSnapshot(again).ok).toBe(true);
      } else {
        rejected++;
        expect(result.error.code).toBe('model-precondition');
        expect(result.error.expected).not.toContain('unexpected');
      }
    }
    expect(accepted + rejected).toBe(cases);
    expect(rejected).toBeGreaterThan(cases / 4);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(256 * 2 ** 20);
  });
});

function boxBytes(): Uint8Array {
  const m = model();
  m.box({ size: [1, 2, 3] });
  return m.snapshot();
}
