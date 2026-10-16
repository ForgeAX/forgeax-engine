// bench-report-schema.test.mjs (M3 T-020) - report/pixel-parity.json
// Schema-as-Contract enforcement (D-P12 + AI-user review F-3 P2).
//
// Drives the implementation of `$defs.benchReportPixelParity` inside
// `schemas/forgeax-metrics.schema.json` AND the runner-side fail-fast validator
// hook in `scripts/bench/pixel-parity.mjs` (M3 T-020 same-task scope).
//
// Six scenarios exercise the JSON Schema 2020-12 contract for the runner
// output (verdict ∈ pass / fail):
//
//   (a) pass-verdict report with full field set =>
//       ajv compiles + validates OK.
//   (b) fail-verdict report with code + expected + hint + detail =>
//       ajv validates OK (error envelope is part of the contract).
//   (c) missing required field (diffPixelCount) =>
//       ajv rejects (fail-fast contract: dispatcher must know the
//       diff count, charter proposition 4 explicit failure).
//   (d) wrong type (diffPixelCount as string instead of integer) =>
//       ajv rejects.
//   (e) unknown additional top-level key =>
//       ajv rejects (additionalProperties: false on the report
//       envelope; AI users grepping the schema know the SSOT field
//       set exhaustively).
//   (f) runner-side: invoking `validateReport(payload)` exported from
//       scripts/bench/pixel-parity.mjs on a malformed payload returns
//       false (fail-fast input/output gate at runner entry/exit;
//       Schema as Contract architecture principle #3 + Fail Fast #5).
//
// References:
//   - plan-decisions.md D-PD2 F-3 → D-P12 (report/pixel-parity.json
//     schema-as-contract)
//   - plan-tasks.json#T-020 (test → schema → runner integration)
//   - architecture-principles #3 (Schema as Contract) + #5 (Fail Fast)
//   - charter proposition 1 (progressive disclosure) + 4 (explicit
//     failure)

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { METRIC_KINDS } from '../run-all.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const schemaPath = resolve(repoRoot, 'schemas/forgeax-metrics.schema.json');

function loadSchema() {
  return JSON.parse(readFileSync(schemaPath, 'utf8'));
}

function makeAjv() {
  return new Ajv2020({ strict: false, allErrors: true });
}

function compileReportValidator() {
  const ajv = makeAjv();
  const schema = loadSchema();
  const reportSchema = schema?.$defs?.benchReportPixelParity;
  if (!reportSchema) {
    throw new Error(
      'schemas/forgeax-metrics.schema.json $defs.benchReportPixelParity not defined (T-020 schema add missing)',
    );
  }
  return ajv.compile(reportSchema);
}

function validPassPayload() {
  return {
    leftCapture: { bytes: 1048576 },
    rightCapture: { bytes: 1048576 },
    diffPixelCount: 12,
    diffPercent: 0.0000457,
    maxChannelDelta: 4,
    threshold: 256,
    perPixelThreshold: 0.1,
    verdict: 'pass',
  };
}

function validFailPayload() {
  return {
    diffPixelCount: 1024,
    diffPercent: 0.00390625,
    maxChannelDelta: 32,
    threshold: 256,
    perPixelThreshold: 0.1,
    verdict: 'fail',
    code: 'pixel-parity-threshold-exceeded',
    expected: 'diffPixelCount <= threshold',
    hint: 'inspect git diff for shader / material / camera regressions',
    detail: {
      diffPixelCount: 1024,
      diffPercent: 0.00390625,
      maxChannelDelta: 32,
      threshold: 256,
      perPixelThreshold: 0.1,
    },
  };
}

describe('report/pixel-parity.json schema-as-contract (T-020 / D-P12)', () => {
  it('keeps the MetricKind registry closed to the five declared members', () => {
    expect(METRIC_KINDS).toEqual(['bundle-size', 'fps', 'bench', 'gate', 'spike-report']);
  });

  it('(a) pass-verdict full report validates OK', () => {
    const validate = compileReportValidator();
    const ok = validate(validPassPayload());
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });

  it('(b) fail-verdict report with error envelope validates OK', () => {
    const validate = compileReportValidator();
    const ok = validate(validFailPayload());
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });

  it('(c) missing required diffPixelCount field is rejected', () => {
    const validate = compileReportValidator();
    const payload = validPassPayload();
    delete payload.diffPixelCount;
    const ok = validate(payload);
    expect(ok).toBe(false);
    expect(validate.errors).not.toBeNull();
    const messages = JSON.stringify(validate.errors);
    expect(messages).toMatch(/diffPixelCount|required/);
  });

  it('(d) wrong type (diffPixelCount as string) is rejected', () => {
    const validate = compileReportValidator();
    const payload = validPassPayload();
    payload.diffPixelCount = 'twelve';
    const ok = validate(payload);
    expect(ok).toBe(false);
    expect(validate.errors).not.toBeNull();
    const messages = JSON.stringify(validate.errors);
    expect(messages).toMatch(/integer|type/);
  });

  it('(e) unknown additional top-level key is rejected', () => {
    const validate = compileReportValidator();
    const payload = validPassPayload();
    payload.unknownField = 'noise';
    const ok = validate(payload);
    expect(ok).toBe(false);
    expect(validate.errors).not.toBeNull();
    const messages = JSON.stringify(validate.errors);
    expect(messages).toMatch(/additionalProperties|unknownField/);
  });

  it('(f) runner-side validateReport rejects malformed payload', async () => {
    const mod = await import('../../bench/pixel-parity.mjs');
    expect(typeof mod.validateReport).toBe('function');
    const goodResult = mod.validateReport(validPassPayload());
    expect(goodResult.ok).toBe(true);
    const badResult = mod.validateReport({ verdict: 'pass' });
    expect(badResult.ok).toBe(false);
    expect(Array.isArray(badResult.errors)).toBe(true);
    expect(badResult.errors.length).toBeGreaterThan(0);
  });
});
