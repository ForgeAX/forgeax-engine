// schema-pixel-diff.test.ts (M3 T-012) - ajv schema validation tests for
// the bench.pixelDiff sub-schema landing at T-013 (minor add).
//
// Drives the implementation of `schemas/forgeax-metrics.schema.json` `$defs.bench`
// pixelDiff sub-field extension (T-013, M3) via TDD. Four scenarios exercise
// the JSON Schema 2020-12 contract for the new optional `pixelDiff` object:
//
//   (a) bench entry containing
//       `pixelDiff: { threshold: 100, perPixelThreshold: 0.1 }`
//       => ajv compiles + validates OK (forward-compatible minor add).
//   (b) bench entry without `pixelDiff` (legacy shape) => still valid
//       (backward compatibility zero-modification across 15 declared
//       workspaces — research Finding 7 + plan-strategy §2 D-P2).
//   (c) bench entry with `pixelDiff.threshold: 0.5` (float, NOT integer)
//       => ajv rejects (Layer B aggregate cap requires integer).
//   (d) bench entry with `pixelDiff: { threshold: 100 }` only
//       (perPixelThreshold omitted) => ajv accepts (perPixelThreshold is
//       optional, evaluator + runner fallback to default 0.1; see
//       D-P2 schema default annotation).
//   (e) bench entry with `pixelDiff: { threshold: 100, foo: 1 }` =>
//       ajv rejects (additionalProperties: false on the pixelDiff object
//       prevents unknown keys silently being accepted; charter
//       proposition 4 explicit failure).
//
// References:
//   - plan-strategy §4.2 testing-layers row "schema validation"
//   - plan-strategy §2 D-P2 (two-layer threshold schema)
//   - plan-tasks.json#T-012 (TDD red phase precedes T-013 schema impl)
//   - requirements §7 AC-07 (schemas/forgeax-metrics.schema.json minor add)
//   - research Finding 7 (schema minor add path + 15-workspace zero
//     modification proof + additionalProperties:false explicit failure)

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..', '..');
const schemaPath = resolve(repoRoot, 'schemas/forgeax-metrics.schema.json');

function loadSchema(): Record<string, unknown> {
  const raw = readFileSync(schemaPath, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function makeAjv(): Ajv2020 {
  return new Ajv2020({ strict: false, allErrors: true });
}

// Minimal valid forgeax.metrics instance (5 closed-union members) wrapper.
// All members declare enabled=false + reason so the only varying field is
// the bench body itself (the test under inspection).
function wrapBench(benchBody: Record<string, unknown>): Record<string, unknown> {
  return {
    'bundle-size': { enabled: false, reason: 'fixture skeleton' },
    fps: { enabled: false, reason: 'fixture skeleton' },
    bench: benchBody,
    gate: { enabled: false, reason: 'fixture skeleton' },
    'spike-report': { enabled: false, reason: 'fixture skeleton' },
  };
}

describe('schemas/forgeax-metrics.schema.json $defs.bench.pixelDiff sub-schema (T-012/T-013)', () => {
  it('(a) bench with pixelDiff { threshold:int, perPixelThreshold:float } validates OK', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(loadSchema());
    const instance = wrapBench({
      enabled: true,
      reportPath: 'report/pixel-parity.json',
      pixelDiff: { threshold: 100, perPixelThreshold: 0.1 },
    });
    const ok = validate(instance);
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });

  it('(b) bench without pixelDiff (legacy shape) still validates OK', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(loadSchema());
    const instance = wrapBench({
      enabled: true,
      reportPath: 'report/bench.json',
      suite: 'math',
    });
    const ok = validate(instance);
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });

  it('(c) bench with pixelDiff.threshold as float (0.5) is rejected (integer required)', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(loadSchema());
    const instance = wrapBench({
      enabled: true,
      pixelDiff: { threshold: 0.5 },
    });
    const ok = validate(instance);
    expect(ok).toBe(false);
    expect(validate.errors).not.toBeNull();
    const messages = JSON.stringify(validate.errors);
    expect(messages).toMatch(/integer|threshold/);
  });

  it('(d) bench with pixelDiff { threshold } only (perPixelThreshold omitted) validates OK', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(loadSchema());
    const instance = wrapBench({
      enabled: true,
      pixelDiff: { threshold: 256 },
    });
    const ok = validate(instance);
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });

  it('(e) bench with pixelDiff containing unknown key (foo) is rejected (additionalProperties:false)', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(loadSchema());
    const instance = wrapBench({
      enabled: true,
      pixelDiff: { threshold: 100, foo: 1 },
    });
    const ok = validate(instance);
    expect(ok).toBe(false);
    expect(validate.errors).not.toBeNull();
    const messages = JSON.stringify(validate.errors);
    expect(messages).toMatch(/additionalProperties|foo/);
  });
});
