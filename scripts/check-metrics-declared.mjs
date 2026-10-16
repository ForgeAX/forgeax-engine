#!/usr/bin/env node
// check-metrics-declared.mjs (M3 w9) - drift detector for forgeax.metrics SSOT.
// Walks getEquivalentWorkspaces() and asserts each member declares forgeax.metrics
// per schemas/forgeax-metrics.schema.json. Fires 3 of 6 MetricErrorCode union members
// ('metric-status-not-ok' is M5 generic-runner territory; the 2 parity members
// 'pixel-parity-threshold-exceeded' / 'pixel-parity-capture-failed' are
// scripts/bench/pixel-parity.mjs territory — feat-20260512 M2 T-009).
// Architecture principle #2 (Derive, Don't Duplicate): workspace set comes
// from the equivalence helper - no glob re-parsing here. stderr is 3-section
// structured: [reason] / [rerun] / [hint] (plan-strategy §7.3).
// Usage: node scripts/check-metrics-declared.mjs [--root <dir>] [--schema <path>]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

// MetricErrorCode mirror — string literals match `packages/types/src/index.ts`
// `export type MetricErrorCode` SSOT (M1 T-001 elevation + T-002 6-member
// extension). The .mjs producer side cannot statically import the TS alias,
// so this frozen array is the AI-grep anchor that lets the bench / metrics
// CI gate spot drift: a literal in `failStructured(code, ...)` below that
// is not also present in this array fails the grep-equivalence audit
// (research Finding 9 §6 g9 checklist item 5). Adding a new member here
// without also extending the TS alias is the inverse drift — caught by
// AGENTS.md Error model table review.
/** @type {Readonly<('metric-not-declared' | 'metric-kind-unknown' | 'metric-status-not-ok' | 'metric-schema-malformed' | 'pixel-parity-threshold-exceeded' | 'pixel-parity-capture-failed')[]>} */
const KNOWN_METRIC_ERROR_CODES = Object.freeze([
  'metric-not-declared',
  'metric-kind-unknown',
  'metric-status-not-ok',
  'metric-schema-malformed',
  'pixel-parity-threshold-exceeded',
  'pixel-parity-capture-failed',
]);
// Reference the constant so it is not tree-shaken out of the producer file
// and remains visible to grep gates + `node --experimental-vm-modules` smoke.
void KNOWN_METRIC_ERROR_CODES;

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--root' && argv[i + 1]) args.root = argv[++i];
  else if (argv[i] === '--schema' && argv[i + 1]) args.schema = argv[++i];
}
function fail(code, expected, hint) {
  process.stderr.write(
    `[reason] ${code}: ${expected}\n[rerun]  pnpm metrics:check\n[hint]   ${hint}\n`,
  );
  process.exit(1);
}
const root = resolve(args.root ?? process.cwd());
const schemaPath = resolve(args.schema ?? `${root}/schemas/forgeax-metrics.schema.json`);
process.chdir(root);
const SCHEMA_EXP = 'schemas/forgeax-metrics.schema.json is well-formed JSON Schema 2020-12';
const schemaHint = (e, kind) =>
  `validate with: python -m json.tool schemas/forgeax-metrics.schema.json; ${kind}Error: ${e.message}`;
let schemaJson;
try {
  schemaJson = JSON.parse(readFileSync(schemaPath, 'utf8'));
} catch (e) {
  fail('metric-schema-malformed', SCHEMA_EXP, schemaHint(e, 'parse'));
}
const { default: Ajv2020 } = await import('ajv/dist/2020.js');
let validate;
try {
  validate = new Ajv2020({ strict: false, allErrors: true }).compile(schemaJson);
} catch (e) {
  fail('metric-schema-malformed', SCHEMA_EXP, schemaHint(e, 'compile'));
}
const { getEquivalentWorkspaces } = await import('./check-workspaces-equivalence.mjs');
const KIND_EXP =
  'forgeax.metrics keys are subset of MetricKind: bundle-size / fps / bench / gate / spike-report';
for (const member of getEquivalentWorkspaces()) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(`${root}/${member}/package.json`, 'utf8'));
  } catch (e) {
    fail(
      'metric-not-declared',
      `${member} declares forgeax.metrics in package.json`,
      `see forgeax.metrics example in @forgeax/engine-math/package.json (read failed: ${e.message})`,
    );
  }
  const metrics = pkg?.forgeax?.metrics;
  if (!metrics || typeof metrics !== 'object') {
    fail(
      'metric-not-declared',
      `${member} declares forgeax.metrics in package.json`,
      'see forgeax.metrics example in @forgeax/engine-math/package.json',
    );
  }
  if (!validate(metrics)) {
    const extra = (validate.errors ?? []).find((e) => e.keyword === 'additionalProperties');
    const bad = extra?.params?.additionalProperty;
    fail(
      'metric-kind-unknown',
      KIND_EXP,
      bad
        ? `check typo at ${member}.forgeax.metrics.${bad}; valid kinds listed in schemas/forgeax-metrics.schema.json`
        : `at ${member}: ${JSON.stringify(validate.errors)}`,
    );
  }
}
process.stdout.write('[ok] forgeax.metrics declared on every workspace member\n');
