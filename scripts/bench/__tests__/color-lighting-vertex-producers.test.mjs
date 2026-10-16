import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import jiti from 'jiti';
import {
  aggregateVertexColorReportStatus,
  browserOutputReceiverCorsHeaders,
  readVertexColorVisualEvidenceInputs,
  runVertexColorProducerSchedule,
  VERTEX_COLOR_BACKENDS,
  VERTEX_COLOR_CASE_IDS,
  vertexColorReportStatus,
} from '../color-lighting-vertex-producers.mjs';

test('browser output receiver exposes the cross-origin POST contract', () => {
  assert.deepEqual(browserOutputReceiverCorsHeaders(), {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
  });
});

test('dispatches both independent producers for every required case/backend', async () => {
  const root = process.cwd();
  const reportRoot = await mkdtemp(join(tmpdir(), 'forgeax-vertex-color-dispatch-'));
  const calls = [];
  try {
    const result = await runVertexColorProducerSchedule({
      root,
      reportRoot,
      invocationId: 'dispatch-test',
      sourceSha: 'a'.repeat(40),
      execute: async ({ env, command, args }) => {
        const caseIds = JSON.parse(env.FORGEAX_VERTEX_COLOR_CASE_IDS);
        calls.push({
          producer: env.FORGEAX_VERTEX_COLOR_PRODUCER,
          backend: env.FORGEAX_VERTEX_COLOR_BACKEND,
          caseIds,
          falsifierOutputs: env.FORGEAX_VERTEX_COLOR_FALSIFIER_OUTPUTS,
          command,
          args,
        });
        return { ok: false, reason: 'test producer unavailable' };
      },
    });
    assert.equal(calls.length, 3);
    assert.equal(
      calls.reduce((count, call) => count + call.caseIds.length, 0),
      21,
    );
    assert.equal(new Set(calls.flatMap((call) => call.caseIds)).size, 7);
    assert.deepEqual(
      new Set(calls.map((call) => call.producer)),
      new Set(['combined', 'forgeax', 'three']),
    );
    for (const call of calls) {
      const testEntry = call.args.find((arg) => arg.endsWith('.test.ts'));
      assert.notEqual(testEntry, undefined);
      assert.equal(
        testEntry.endsWith(`.${call.backend === 'browser-webgpu' ? 'browser' : 'dawn'}.test.ts`),
        true,
      );
      if (call.producer === 'forgeax' || call.producer === 'combined') {
        assert.notEqual(call.falsifierOutputs, undefined);
      } else {
        assert.equal(call.falsifierOutputs, undefined);
      }
    }
    assert.equal(result.blocked.length, 14);
    assert.equal(result.ok, false);
    const receipt = JSON.parse(await readFile(join(reportRoot, 'dispatch-receipt.json'), 'utf8'));
    assert.equal(receipt.combinations, 14);
    assert.equal(receipt.logicalCells, 28);
    assert.equal(receipt.physicalBatchCount, 3);
    assert.equal(receipt.physicalBatches.length, 3);
    assert.deepEqual(
      new Set(receipt.physicalBatches.map((batch) => `${batch.backend}/${batch.producer}`)),
      new Set(['browser-webgpu/combined', 'dawn/forgeax', 'dawn/three']),
    );
    assert.equal(
      receipt.physicalBatches.every((batch) => batch.caseIds.length === 7),
      true,
    );
    assert.equal(receipt.blocked.length, 14);
    assert.equal(receipt.sourceSha, 'a'.repeat(40));
    const schema = JSON.parse(
      await readFile(
        join(root, 'apps/parity/color-lighting/schemas/case-report.schema.json'),
        'utf8',
      ),
    );
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
    const blockedReport = JSON.parse(
      await readFile(join(reportRoot, 'browser-webgpu', 'vertex-color-vec3.json'), 'utf8'),
    );
    assert.equal(validate(blockedReport), true);
    assert.equal(blockedReport.status, 'blocked');
  } finally {
    await rm(reportRoot, { recursive: true, force: true });
  }
});

test('preserves evaluator failures as failed reports instead of blocked captures', async () => {
  const root = process.cwd();
  const reportRoot = await mkdtemp(join(tmpdir(), 'forgeax-vertex-color-evaluation-'));
  const sourceSha = 'b'.repeat(40);
  const pixels = Array.from({ length: 128 * 128 * 4 }, () => 0.25);
  const loadTypeScript = jiti(import.meta.url);
  const { VERTEX_COLOR_REQUIRED_CASES } = await loadTypeScript.import(
    join(root, 'apps/parity/color-lighting/src/coverage/required-cases.ts'),
  );
  try {
    const result = await runVertexColorProducerSchedule({
      root,
      reportRoot,
      invocationId: 'evaluation-failure-test',
      sourceSha,
      execute: async ({ env }) => {
        const caseIds = JSON.parse(env.FORGEAX_VERTEX_COLOR_CASE_IDS);
        const outputPaths = JSON.parse(env.FORGEAX_VERTEX_COLOR_OUTPUTS);
        const outputPathsByProducer =
          env.FORGEAX_VERTEX_COLOR_OUTPUTS_BY_PRODUCER === undefined
            ? { [env.FORGEAX_VERTEX_COLOR_PRODUCER]: outputPaths }
            : JSON.parse(env.FORGEAX_VERTEX_COLOR_OUTPUTS_BY_PRODUCER);
        const falsifierOutputPaths =
          env.FORGEAX_VERTEX_COLOR_FALSIFIER_OUTPUTS === undefined
            ? {}
            : JSON.parse(env.FORGEAX_VERTEX_COLOR_FALSIFIER_OUTPUTS);
        for (const producer of Object.keys(outputPathsByProducer)) {
          const producerOutputPaths = outputPathsByProducer[producer];
          for (const caseId of caseIds) {
            const fixture = JSON.parse(
              await readFile(
                join(root, 'apps/parity/color-lighting/cases/vertex-color', `${caseId}.json`),
                'utf8',
              ),
            );
            const sourceFixtureHash = VERTEX_COLOR_REQUIRED_CASES.find(
              (entry) => entry.caseId === caseId,
            ).sourceFixtureHash;
            const samples = fixture.samplePoints.map((sample) => ({
              id: sample.id,
              coordinate: sample.coordinate,
              rgba:
                caseId === 'vertex-color-no-color-baseline'
                  ? [0.2, 0.4, 0.8, 1]
                  : producer === 'three'
                    ? [0.9, 0.4, 0.8, 1]
                    : [0.2, 0.4, 0.8, 1],
            }));
            const output = {
              backend: env.FORGEAX_VERTEX_COLOR_BACKEND,
              frameCount: 300,
              sourceSha,
              sourceFixtureHash,
              colorDomain: fixture.colorDomain,
              samples,
              linear: pixels,
              final: pixels,
              readback:
                producer === 'three' ? 'readRenderTargetPixelsAsync' : 'copyTextureToBuffer',
            };
            await import('node:fs/promises').then(({ writeFile }) =>
              writeFile(producerOutputPaths[caseId], JSON.stringify(output)),
            );
            const falsifierPath = producer === 'forgeax' ? falsifierOutputPaths[caseId] : undefined;
            if (falsifierPath !== undefined) {
              await import('node:fs/promises').then(({ writeFile }) =>
                writeFile(
                  falsifierPath,
                  JSON.stringify({
                    ...output,
                    samples: samples.map((sample) => ({ ...sample, rgba: [1, 1, 1, 1] })),
                    ...(caseId === 'vertex-color-no-color-baseline' ? { final: pixels } : {}),
                  }),
                ),
              );
            }
          }
        }
        return { ok: true };
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.blocked.length, 0);
    assert.equal(result.failures.length, 12);
    const receipt = JSON.parse(await readFile(join(reportRoot, 'dispatch-receipt.json'), 'utf8'));
    assert.equal(receipt.blocked.length, 0);
    assert.equal(receipt.failures.length, 12);
    const failedReport = JSON.parse(
      await readFile(join(reportRoot, 'browser-webgpu', 'vertex-color-vec3.json'), 'utf8'),
    );
    assert.equal(failedReport.status, 'failed');
    assert.equal(failedReport.verdict, 'failed');
    assert.equal(failedReport.samples[0].observed.forgeax[0], 0.2);
    assert.equal(failedReport.samples[0].observed.three[0], 0.9);
    const baselineReport = JSON.parse(
      await readFile(
        join(reportRoot, 'browser-webgpu', 'vertex-color-no-color-baseline.json'),
        'utf8',
      ),
    );
    assert.equal(baselineReport.status, 'complete');
    assert.equal(baselineReport.verdict, 'passed');
  } finally {
    await rm(reportRoot, { recursive: true, force: true });
  }
});

test('schedule roster remains the seven by two required matrix', () => {
  assert.equal(VERTEX_COLOR_CASE_IDS.length, 7);
  assert.deepEqual(VERTEX_COLOR_BACKENDS, ['browser-webgpu', 'dawn']);
});

test('projects vertex report outcomes without treating blocked reports as passes', () => {
  assert.equal(vertexColorReportStatus({ status: 'complete', verdict: 'passed' }), 'pass');
  assert.equal(vertexColorReportStatus({ status: 'failed', verdict: 'failed' }), 'failed');
  assert.equal(vertexColorReportStatus({ status: 'blocked', verdict: 'failed' }), 'failed');
  assert.equal(vertexColorReportStatus({ status: 'complete', verdict: 'notRun' }), 'not-executed');
  assert.equal(vertexColorReportStatus(undefined), 'not-executed');
  assert.equal(aggregateVertexColorReportStatus(['pass', 'pass']), 'pass');
  assert.equal(aggregateVertexColorReportStatus(['pass', 'not-executed']), 'not-executed');
  assert.equal(aggregateVertexColorReportStatus(['pass', 'failed']), 'failed');
});

test('maps scheduler capture artifacts into independent visual evidence inputs', async () => {
  const root = process.cwd();
  const reportRoot = await mkdtemp(join(tmpdir(), 'forgeax-vertex-color-visual-'));
  const sourceSha = 'a'.repeat(40);
  const pixels = Array.from({ length: 128 * 128 * 4 }, (_, index) => (index % 4) / 3);
  const loadTypeScript = jiti(import.meta.url);
  const { VERTEX_COLOR_REQUIRED_CASES } = await loadTypeScript.import(
    join(root, 'apps/parity/color-lighting/src/coverage/required-cases.ts'),
  );
  try {
    await runVertexColorProducerSchedule({
      root,
      reportRoot,
      invocationId: 'visual-input-test',
      sourceSha,
      execute: async ({ env }) => {
        const caseIds = JSON.parse(env.FORGEAX_VERTEX_COLOR_CASE_IDS);
        const outputPaths = JSON.parse(env.FORGEAX_VERTEX_COLOR_OUTPUTS);
        const outputPathsByProducer =
          env.FORGEAX_VERTEX_COLOR_OUTPUTS_BY_PRODUCER === undefined
            ? { [env.FORGEAX_VERTEX_COLOR_PRODUCER]: outputPaths }
            : JSON.parse(env.FORGEAX_VERTEX_COLOR_OUTPUTS_BY_PRODUCER);
        const falsifierOutputPaths =
          env.FORGEAX_VERTEX_COLOR_FALSIFIER_OUTPUTS === undefined
            ? {}
            : JSON.parse(env.FORGEAX_VERTEX_COLOR_FALSIFIER_OUTPUTS);
        await import('node:fs/promises').then(async ({ writeFile }) => {
          for (const producer of Object.keys(outputPathsByProducer)) {
            const producerOutputPaths = outputPathsByProducer[producer];
            for (const caseId of caseIds) {
              const fixture = JSON.parse(
                await readFile(
                  join(root, 'apps/parity/color-lighting/cases/vertex-color', `${caseId}.json`),
                  'utf8',
                ),
              );
              const sourceFixtureHash = VERTEX_COLOR_REQUIRED_CASES.find(
                (entry) => entry.caseId === caseId,
              ).sourceFixtureHash;
              const samples = fixture.samplePoints.map((sample) => ({
                id: sample.id,
                coordinate: sample.coordinate,
                rgba: [0.2, 0.4, 0.8, 1],
              }));
              const output = {
                backend: env.FORGEAX_VERTEX_COLOR_BACKEND,
                frameCount: 300,
                sourceSha,
                sourceFixtureHash,
                colorDomain: fixture.colorDomain,
                samples,
                linear: pixels,
                final: pixels,
                readback:
                  producer === 'three' ? 'readRenderTargetPixelsAsync' : 'copyTextureToBuffer',
              };
              await writeFile(producerOutputPaths[caseId], JSON.stringify(output));
              if (producer === 'forgeax' && falsifierOutputPaths[caseId] !== undefined) {
                await writeFile(
                  falsifierOutputPaths[caseId],
                  JSON.stringify({
                    ...output,
                    samples: samples.map((sample) => ({ ...sample, rgba: [1, 1, 1, 1] })),
                  }),
                );
              }
            }
          }
        });
        return { ok: true };
      },
    });
    const schema = JSON.parse(
      await readFile(
        join(root, 'apps/parity/color-lighting/schemas/case-report.schema.json'),
        'utf8',
      ),
    );
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
    for (const backend of VERTEX_COLOR_BACKENDS) {
      for (const caseId of VERTEX_COLOR_CASE_IDS) {
        const report = JSON.parse(
          await readFile(join(reportRoot, backend, `${caseId}.json`), 'utf8'),
        );
        assert.equal(validate(report), true);
        assert.equal(report.status, 'complete');
        assert.equal(report.verdict, 'passed');
        assert.equal(report.falsifier.verdict, 'passed');
      }
    }
    const inputs = readVertexColorVisualEvidenceInputs({
      reportRoot,
      sourceSha,
      invocationId: 'visual-input-test',
    });
    assert.equal(inputs.length, 7);
    assert.deepEqual(new Set(inputs.map((input) => input.evidenceKind)), new Set(['vertex-color']));
    for (const input of inputs) {
      assert.equal(input.width, 128);
      assert.equal(input.height, 128);
      assert.equal(input.status, 'complete');
      assert.equal(input.provenance.forgeax.implementation, 'forgeax');
      assert.equal(input.provenance.three.implementation, 'three');
      assert.equal('producers' in input, false);
      assert.equal(input.captures.forgeax.final.length, 128 * 128 * 4);
      assert.equal(input.captures.three.final.length, 128 * 128 * 4);
    }
  } finally {
    await rm(reportRoot, { recursive: true, force: true });
  }
});
