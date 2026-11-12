import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeSnapshot, encodeSnapshot } from '../fxem';
import { model } from '../model';
import { sel } from '../selectors';

const HEADER = 64;
const ENTRY = 24;
const BIG = [0, 1, 0x7fffffff, 0x80000000, 0xffffffff, 1 << 20];

function seeds(): Uint8Array[] {
  const a = model();
  a.box({ size: [1, 1, 1], tag: 'body' });
  a.inset(sel.facing('+y'), { thickness: 0.1, region: 'merged', label: 'panel' });
  a.uv.project({ mode: 'box', scale: 1 });
  const b = model();
  b.box({ size: [1, 2, 3] });
  return [a.snapshot(), b.snapshot()];
}

const edit = fc.oneof(
  fc.record({ k: fc.constant('byte'), at: fc.nat(), v: fc.nat(255) }),
  fc.record({ k: fc.constant('table'), at: fc.nat(HEADER + ENTRY * 16), v: fc.nat(255) }),
  fc.record({ k: fc.constant('cut'), at: fc.nat(), v: fc.constant(0) }),
  fc.record({ k: fc.constant('grow'), at: fc.nat(64), v: fc.nat(255) }),
  fc.record({ k: fc.constant('word'), at: fc.nat(), v: fc.nat(BIG.length - 1) }),
);

function apply(seed: Uint8Array, edits: { k: string; at: number; v: number }[]): Uint8Array {
  let bytes = seed.slice();
  for (const { k, at, v } of edits) {
    if (bytes.length === 0) break;
    if (k === 'byte') bytes[at % bytes.length] = v;
    else if (k === 'table') bytes[Math.min(at, bytes.length - 1)] = v;
    else if (k === 'cut') bytes = bytes.slice(0, at % bytes.length);
    else if (k === 'grow') {
      const out = new Uint8Array(bytes.length + 1 + at);
      out.set(bytes);
      out.fill(v, bytes.length);
      bytes = out;
    } else if (bytes.length >= 4) {
      new DataView(bytes.buffer).setUint32((at % (bytes.length - 3)) & ~3, BIG[v] as number, true);
    }
  }
  return bytes;
}

describe('FXEM decoder fuzz (fast-check)', () => {
  it('10k mutated snapshots: never throws, bounded time and memory, valid mesh or structured error', () => {
    const pool = seeds();
    const before = process.memoryUsage().arrayBuffers;
    let rejected = 0;
    fc.assert(
      fc.property(
        fc.nat(pool.length - 1),
        fc.array(edit, { minLength: 1, maxLength: 6 }),
        (s, edits) => {
          const bytes = apply(pool[s] as Uint8Array, edits);
          const started = performance.now();
          const result = decodeSnapshot(bytes);
          expect(performance.now() - started).toBeLessThan(1000);
          if (result.ok) {
            expect(decodeSnapshot(encodeSnapshot(result.value)).ok).toBe(true);
          } else {
            rejected++;
            expect(result.error.code).toBe('model-precondition');
            expect(result.error.expected).not.toContain('unexpected');
          }
        },
      ),
      { numRuns: 10000, seed: 0x5eed },
    );
    expect(rejected).toBeGreaterThan(2500);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(256 * 2 ** 20);
  });

  it('arbitrary bytes never throw', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        expect(decodeSnapshot(bytes).ok).toBe(false);
      }),
      { numRuns: 2000, seed: 0x5eed },
    );
  });
});
