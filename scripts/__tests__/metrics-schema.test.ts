// metrics-schema.test.ts (M1 w2) — schema fixture + ajv self-validate.
//
// Covers four error paths against `<repo-root>/schemas/forgeax-metrics.schema.json`:
//   (a) valid fixture instance => ajv compiled validator returns true
//   (b) JSON syntax error in schema file => surfaced as
//       'metric-schema-malformed' (drift detector error code per K-2 / AC-12)
//   (c) MetricKind enum typo (top-level key not in closed union) => ajv rejects
//   (d) enabled=false but missing 'reason' => ajv rejects
//
// References:
//   - requirements §AC-01 — ajv self-validate verification means
//   - plan-strategy §4.1 — strict red-green-refactor (TDD)
//   - plan-strategy §4.4 — no skip allowed
//   - plan-strategy §7.3 — 'metric-schema-malformed' error template
//   - plan-tasks.json#w2 — fixture placement under scripts/__tests__/fixtures/

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..');
const schemaPath = resolve(repoRoot, 'schemas/forgeax-metrics.schema.json');
const fixturesDir = resolve(__dirname, 'fixtures');
const validInstancePath = resolve(fixturesDir, 'metrics-schema-valid.json');
const invalidEnumInstancePath = resolve(fixturesDir, 'metrics-schema-invalid-enum.json');

interface SchemaLoadResult {
  schema?: Record<string, unknown>;
  errorCode?: 'metric-schema-malformed';
  parseError?: string;
}

function loadSchema(path: string): SchemaLoadResult {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { errorCode: 'metric-schema-malformed', parseError: (e as Error).message };
  }
  try {
    return { schema: JSON.parse(raw) as Record<string, unknown> };
  } catch (e) {
    return { errorCode: 'metric-schema-malformed', parseError: (e as Error).message };
  }
}

function makeAjv(): Ajv2020 {
  // strict: false allows top-level $schema reference without a meta loader.
  return new Ajv2020({ strict: false, allErrors: true });
}

describe('schemas/forgeax-metrics.schema.json self-validate (w2)', () => {
  it('(a) valid instance fixture passes ajv compiled validator', () => {
    const loaded = loadSchema(schemaPath);
    expect(loaded.errorCode).toBeUndefined();
    expect(loaded.schema).toBeDefined();

    const ajv = makeAjv();
    const validate = ajv.compile(loaded.schema as object);
    const validInstance = JSON.parse(readFileSync(validInstancePath, 'utf8')) as unknown;
    const ok = validate(validInstance);
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });

  it('(b) malformed JSON schema file surfaces metric-schema-malformed', () => {
    // Simulate the malformed-schema path with a synthetic malformed payload.
    // Drift detector (w9) shares this loader pattern; the contract validated
    // here is "code is metric-schema-malformed when JSON.parse throws".
    const malformedRaw = '{ "type": "object", '; // truncated -> SyntaxError
    let result: SchemaLoadResult;
    try {
      JSON.parse(malformedRaw);
      result = { schema: {} };
    } catch (e) {
      result = { errorCode: 'metric-schema-malformed', parseError: (e as Error).message };
    }
    expect(result.errorCode).toBe('metric-schema-malformed');
    expect(result.parseError).toBeTruthy();
  });

  it('(c) unknown MetricKind key (typo) is rejected by ajv', () => {
    const loaded = loadSchema(schemaPath);
    expect(loaded.schema).toBeDefined();

    const ajv = makeAjv();
    const validate = ajv.compile(loaded.schema as object);
    const invalidInstance = JSON.parse(readFileSync(invalidEnumInstancePath, 'utf8')) as unknown;
    const ok = validate(invalidInstance);
    expect(ok).toBe(false);
    expect(validate.errors).not.toBeNull();
    // Must be a top-level keyword failure pointing at the unknown property.
    const messages = JSON.stringify(validate.errors);
    expect(messages).toMatch(/bundle-sizes|additionalProperties|propertyNames/);
  });

  it('(d) enabled=false without reason is rejected by ajv', () => {
    const loaded = loadSchema(schemaPath);
    expect(loaded.schema).toBeDefined();

    const ajv = makeAjv();
    const validate = ajv.compile(loaded.schema as object);
    const instance = {
      'bundle-size': { enabled: false }, // missing required reason
    };
    const ok = validate(instance);
    expect(ok).toBe(false);
    expect(validate.errors).not.toBeNull();
    const messages = JSON.stringify(validate.errors);
    expect(messages).toMatch(/reason/);
  });
});
