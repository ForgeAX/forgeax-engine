#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  canonical,
  digest,
  emitJson,
  loadJson,
  pointer,
  requireFact,
  runCli,
  statistics,
} from './lib.mjs';

function differences(a, b, path = '') {
  if (canonical(a) === canonical(b)) return [];
  if (
    a !== null &&
    b !== null &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    Array.isArray(a) === Array.isArray(b)
  ) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .sort()
      .flatMap((key) =>
        Object.hasOwn(a, key) && Object.hasOwn(b, key)
          ? differences(a[key], b[key], `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`)
          : [`${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`],
      );
  }
  return [path];
}

export function compareSamples(baseline, candidate, options) {
  requireFact(['lower', 'higher'].includes(options.direction), 'direction must be lower or higher');
  requireFact(
    typeof options.unit === 'string' && options.unit.trim().length > 0,
    'Declare the sample unit',
  );
  requireFact(typeof options.identityPointer === 'string', 'Declare the workload identity pointer');
  const identity = (document) => {
    const value = pointer(document, options.identityPointer);
    requireFact(
      value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length > 0,
      'Workload identity must be a nonempty object',
    );
    return value;
  };
  const a = identity(baseline);
  const b = identity(candidate);
  const mismatch = differences(a, b);
  const before = statistics(pointer(baseline, options.samplesPointer));
  const after = statistics(pointer(candidate, options.samplesPointer));
  const comparable = mismatch.length === 0;
  const change = (field) =>
    before[field] === 0 ? null : ((after[field] - before[field]) * 100) / before[field];
  return {
    kind: 'selected-identity-sample-comparison',
    comparable,
    identityDifferences: mismatch,
    baselineIdentitySha256: digest(canonical(a)),
    candidateIdentitySha256: digest(canonical(b)),
    unit: options.unit,
    direction: options.direction,
    samplesPointer: options.samplesPointer,
    identityPointer: options.identityPointer,
    baseline: before,
    candidate: after,
    changePercent: comparable
      ? { mean: change('mean'), p50: change('p50'), p95: change('p95'), p99: change('p99') }
      : null,
    meanImprovementPercent:
      comparable && before.mean !== 0
        ? change('mean') * (options.direction === 'lower' ? -1 : 1)
        : null,
    interpretation:
      'Only the selected identity is checked. Unit is caller-declared. Producer completeness, correctness, instrumentation, contention and source provenance need separate verification. Descriptive samples do not establish statistical significance or whole-frame speedup.',
  };
}

runCli(import.meta.url, async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      'samples-pointer': { type: 'string', default: '/samples' },
      'identity-pointer': { type: 'string' },
      unit: { type: 'string' },
      direction: { type: 'string', default: 'lower' },
      output: { type: 'string' },
    },
  });
  if (values.help) {
    console.log(
      'node compare_samples.mjs BASELINE CANDIDATE --identity-pointer /workload --unit ms [--samples-pointer /samples] [--direction lower|higher] [--output FILE]',
    );
    return;
  }
  requireFact(positionals.length === 2, 'Require baseline and candidate JSON files');
  const [baseline, candidate] = await Promise.all(positionals.map(loadJson));
  const report = compareSamples(baseline.value, candidate.value, {
    samplesPointer: values['samples-pointer'],
    identityPointer: values['identity-pointer'],
    unit: values.unit,
    direction: values.direction,
  });
  await emitJson(
    { baselineSha256: baseline.sha256, candidateSha256: candidate.sha256, ...report },
    values.output,
    positionals,
  );
  if (!report.comparable) process.exitCode = 2;
});
