import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FORMAT_STAGE_NAMES, run } from '../collect-ssr-dependency-report.mjs';

test('real command publishes one signed joint dependency report', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forgeax-ssr-joint-report-'));
  const output = join(directory, 'ssr-dependency-report.json');
  try {
    const first = await run(['--root', process.cwd(), '--output', output]);
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(first.exitCode, 0);
    assert.equal(report.producer, 'collect-ssr-dependency-report');
    assert.equal(typeof report.reportDigest, 'string');
    assert.equal(report.admission.status, 'fallback-only');
    assert.deepEqual(report.admission.zeroWork, {
      attachmentCount: 0,
      passCount: 0,
      bindingCount: 0,
      resourceCount: 0,
      historyCount: 0,
      temporalDemand: 0,
    });
    assert.equal(FORMAT_STAGE_NAMES.length, 8);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects a manually modified existing report instead of overwriting it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forgeax-ssr-report-integrity-'));
  const output = join(directory, 'ssr-dependency-report.json');
  try {
    await run(['--root', process.cwd(), '--output', output]);
    const report = JSON.parse(await readFile(output, 'utf8'));
    await writeFile(output, JSON.stringify({ ...report, status: 'admitted' }));
    await assert.rejects(
      () => run(['--root', process.cwd(), '--output', output]),
      (error) => error?.code === 'report-integrity-invalid',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
