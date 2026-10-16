#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const packageRoot = resolve(import.meta.dirname, '..');
const statuses = ['pass', 'fail', 'unsupported', 'not-run'];

export function verifyConformanceReport(reportPath) {
  const absolute = resolve(reportPath);
  const report = JSON.parse(readFileSync(absolute, 'utf8'));
  const schema = JSON.parse(
    readFileSync(resolve(packageRoot, 'conformance-report.schema.json'), 'utf8'),
  );
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  if (!validate(report)) throw new Error(validate.errorsText(validate.errors, { separator: '\n' }));

  const lines = readFileSync(resolve(dirname(absolute), 'cases.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
  const cases = lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`cases.jsonl line ${index + 1} is invalid JSON: ${error}`);
    }
  });
  if (cases.length !== report.caseCount) {
    throw new Error(`case count ${cases.length} does not equal report.caseCount ${report.caseCount}`);
  }
  const ids = cases.map(({ id }) => id);
  if (ids.some((id) => typeof id !== 'string' || id.length === 0) || new Set(ids).size !== ids.length) {
    throw new Error('every case must have one unique non-empty id');
  }
  const actualCounts = {};
  for (const item of cases) {
    if (!statuses.includes(item.status)) throw new Error(`case ${item.id} has invalid status`);
    if (typeof item.profile !== 'string' || report.countsByProfile[item.profile] === undefined) {
      throw new Error(`case ${item.id} has unreported profile ${item.profile}`);
    }
    const counts = actualCounts[item.profile] ??= { pass: 0, fail: 0, unsupported: 0, notRun: 0 };
    counts[item.status === 'not-run' ? 'notRun' : item.status] += 1;
  }
  if (JSON.stringify(actualCounts) !== JSON.stringify(report.countsByProfile)) {
    throw new Error('countsByProfile does not match cases.jsonl terminal states');
  }
  const firstFailure = cases.find(({ status }) => status === 'fail');
  if ((firstFailure?.id ?? null) !== (report.firstFailure?.caseId ?? null)) {
    throw new Error('firstFailure does not identify the first failed registry case');
  }
  return { report, cases };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reportPath = process.argv[2];
  if (!reportPath) throw new Error('usage: verify-conformance-report.mjs REPORT_JSON');
  const { report } = verifyConformanceReport(reportPath);
  process.stdout.write(`${JSON.stringify({ runId: report.runId, caseCount: report.caseCount })}\n`);
}
