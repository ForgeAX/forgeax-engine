import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import jiti from 'jiti';

export const VERTEX_COLOR_CASE_IDS = Object.freeze([
  'vertex-color-vec3',
  'vertex-color-vec4',
  'vertex-color-normalized',
  'vertex-color-skinning',
  'vertex-color-mixed-primitives',
  'vertex-color-mask-taa',
  'vertex-color-no-color-baseline',
]);
export const VERTEX_COLOR_BACKENDS = Object.freeze(['browser-webgpu', 'dawn']);
const VERTEX_COLOR_CAPTURE_WIDTH = 128;
const VERTEX_COLOR_CAPTURE_HEIGHT = 128;

export function vertexColorReportStatus(report) {
  if (report?.status === 'complete' && report?.verdict === 'passed') return 'pass';
  if (report?.status === 'failed' || report?.verdict === 'failed') return 'failed';
  return 'not-executed';
}

export function aggregateVertexColorReportStatus(statuses) {
  if (statuses.some((status) => status === 'failed')) return 'failed';
  if (statuses.length > 0 && statuses.every((status) => status === 'pass')) return 'pass';
  return 'not-executed';
}

const PRODUCERS = Object.freeze([
  {
    implementation: 'forgeax',
    version: 'workspace',
    adapterId: 'forgeax-vertex-color-webgpu',
    buildIdentity: 'forgeax-browser-and-dawn-vertex-color',
    testEntry: {
      browser:
        'apps/parity/color-lighting/src/visual/__tests__/vertex-color-forgeax.browser.test.ts',
      dawn: 'apps/parity/color-lighting/src/visual/__tests__/vertex-color-forgeax.dawn.test.ts',
    },
  },
  {
    implementation: 'three',
    version: 'r184',
    adapterId: 'three-r184-vertex-color-webgpu',
    buildIdentity: 'three-webgpu-r184-vertex-color',
    testEntry: {
      browser: 'apps/parity/color-lighting/src/visual/__tests__/vertex-color-three.browser.test.ts',
      dawn: 'apps/parity/color-lighting/src/visual/__tests__/vertex-color-three.dawn.test.ts',
    },
  },
]);

function producerIdentity(producer, sourceSha) {
  return {
    implementation: producer.implementation,
    version: producer.version,
    renderer: 'webgpu',
    adapterId: producer.adapterId,
    pinnedCommit: producer.implementation === 'three' ? 'three-r184-pinned' : sourceSha,
    buildIdentity: producer.buildIdentity,
  };
}

function captureHash(linear, final) {
  return createHash('sha256').update(JSON.stringify({ linear, final })).digest('hex');
}

function readCapture(path, expectedCaseId, expectedBackend, expectedSourceSha) {
  const capture = JSON.parse(readFileSync(path, 'utf8'));
  if (
    capture?.backend !== expectedBackend ||
    capture?.frameCount !== 60 ||
    capture?.sourceSha !== expectedSourceSha ||
    typeof capture?.sourceFixtureHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(capture.sourceFixtureHash) ||
    !Array.isArray(capture?.linear) ||
    !Array.isArray(capture?.final) ||
    capture.linear.length === 0 ||
    capture.final.length !== VERTEX_COLOR_CAPTURE_WIDTH * VERTEX_COLOR_CAPTURE_HEIGHT * 4 ||
    (capture.readback !== 'copyTextureToBuffer' &&
      capture.readback !== 'readRenderTargetPixelsAsync')
  ) {
    throw new Error(`${expectedBackend}/${expectedCaseId}: scheduler capture artifact is invalid`);
  }
  return capture;
}

export function readVertexColorVisualEvidenceInputs({ reportRoot, sourceSha, invocationId }) {
  return VERTEX_COLOR_CASE_IDS.map((caseId) => {
    const reportPath = resolve(reportRoot, 'browser-webgpu', `${caseId}.json`);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    if (
      report?.kind !== 'vertex-color' ||
      report?.caseId !== caseId ||
      report?.backend !== 'browser-webgpu' ||
      report?.sourceSha !== sourceSha ||
      report?.status !== 'complete' ||
      report?.verdict !== 'passed' ||
      report?.falsifier?.verdict !== 'passed'
    ) {
      throw new Error(`${caseId}: browser scheduler report is not complete/passed`);
    }
    const forgeax = readCapture(
      resolve(reportRoot, 'browser-webgpu', `${caseId}.forgeax.capture.json`),
      caseId,
      'browser-webgpu',
      sourceSha,
    );
    const three = readCapture(
      resolve(reportRoot, 'browser-webgpu', `${caseId}.three.capture.json`),
      caseId,
      'browser-webgpu',
      sourceSha,
    );
    if (
      forgeax.sourceFixtureHash !== three.sourceFixtureHash ||
      forgeax.colorDomain !== three.colorDomain
    ) {
      throw new Error(`${caseId}: scheduler captures disagree on source fixture or color domain`);
    }
    if (report.sourceFixtureHash !== forgeax.sourceFixtureHash) {
      throw new Error(`${caseId}: scheduler report and captures disagree on source fixture`);
    }
    let analyticMax = 0;
    let differingBytes = 0;
    for (let index = 0; index < forgeax.final.length; index += 1) {
      const delta = Math.abs((forgeax.final[index] ?? 0) - (three.final[index] ?? 0));
      analyticMax = Math.max(analyticMax, delta);
      if (forgeax.final[index] !== three.final[index]) differingBytes += 1;
    }
    return {
      evidenceKind: 'vertex-color',
      caseId,
      width: VERTEX_COLOR_CAPTURE_WIDTH,
      height: VERTEX_COLOR_CAPTURE_HEIGHT,
      background: [0, 0, 0, 1],
      framing: 'orthographic-center',
      colorDomain: forgeax.colorDomain,
      frameCount: 60,
      epsilon: { rgb: 0.05, alpha: 0.05 },
      sourceFixtureHash: report.sourceFixtureHash,
      invocationId,
      sourceSha,
      provenance: report.producers,
      captures: {
        forgeax: {
          linear: forgeax.linear,
          final: forgeax.final,
          hash: captureHash(forgeax.linear, forgeax.final),
        },
        three: {
          linear: three.linear,
          final: three.final,
          hash: captureHash(three.linear, three.final),
        },
      },
      metrics: { analyticMax, roiMax: analyticMax, differingBytes },
      verdict: report.verdict,
      status: report.status,
      frameId: 59,
    };
  });
}

function blockedReport({
  caseId,
  backend,
  invocationId,
  sourceSha,
  sourceFixtureHash,
  fixture,
  reason,
}) {
  const falsifierKind =
    caseId === 'vertex-color-no-color-baseline' ? 'no-color-baseline' : 'white-color';
  const artifacts = [
    `artifact://color-lighting-parity/${invocationId}/${backend}/${caseId}/forgeax-blocked`,
    `artifact://color-lighting-parity/${invocationId}/${backend}/${caseId}/three-blocked`,
  ];
  return {
    schemaVersion: 3,
    kind: 'vertex-color',
    caseId,
    required: true,
    invocationId,
    backend,
    sourceSha,
    sourceFixtureHash,
    colorDomain: fixture.colorDomain,
    frameCount: 60,
    epsilon: { rgb: 0.05, alpha: 0.05 },
    producers: {
      forgeax: producerIdentity(PRODUCERS[0], sourceSha),
      three: producerIdentity(PRODUCERS[1], sourceSha),
    },
    samples: fixture.samplePoints.map((sample) => ({
      id: sample.id,
      coordinate: sample.coordinate,
      expected: [0, 0, 0, 0],
      observed: { forgeax: [0, 0, 0, 0], three: [0, 0, 0, 0] },
      rgbMaxDelta: 0,
      alphaDelta: 0,
      verdict: 'failed',
      confidence: 'low',
    })),
    falsifier: { kind: falsifierKind, verdict: 'failed', observed: `blocked: ${reason}` },
    artifacts,
    verdict: 'failed',
    status: 'blocked',
  };
}

function commandFor(
  producer,
  backend,
  caseIds,
  outputPaths,
  sourceSha,
  outputUrls,
  falsifierOutputPaths,
  falsifierOutputUrls,
  { outputPathsByProducer, producerEnv = producer.implementation, testEntries } = {},
) {
  const testEntryKey = backend === 'browser-webgpu' ? 'browser' : 'dawn';
  return {
    command: 'pnpm',
    args: [
      'exec',
      'vitest',
      'run',
      `--project=${backend === 'dawn' ? 'dawn' : 'browser'}`,
      ...(testEntries ?? [producer.testEntry[testEntryKey]]),
      '--maxWorkers=1',
    ],
    env: {
      FORGEAX_VERTEX_COLOR_PRODUCER: producerEnv,
      FORGEAX_VERTEX_COLOR_BACKEND: backend,
      FORGEAX_VERTEX_COLOR_CASE_IDS: JSON.stringify(caseIds),
      FORGEAX_VERTEX_COLOR_SOURCE_SHA: sourceSha,
      FORGEAX_VERTEX_COLOR_OUTPUTS: JSON.stringify(outputPaths),
      ...(outputPathsByProducer === undefined
        ? {}
        : { FORGEAX_VERTEX_COLOR_OUTPUTS_BY_PRODUCER: JSON.stringify(outputPathsByProducer) }),
      VITE_FORGEAX_VERTEX_COLOR_CASE_IDS: JSON.stringify(caseIds),
      VITE_FORGEAX_VERTEX_COLOR_PRODUCER: producerEnv,
      VITE_FORGEAX_VERTEX_COLOR_BACKEND: backend,
      VITE_FORGEAX_VERTEX_COLOR_SOURCE_SHA: sourceSha,
      VITE_FORGEAX_VERTEX_COLOR_OUTPUTS: JSON.stringify(outputPaths),
      ...(outputPathsByProducer === undefined
        ? {}
        : { VITE_FORGEAX_VERTEX_COLOR_OUTPUTS_BY_PRODUCER: JSON.stringify(outputPathsByProducer) }),
      VITE_FORGEAX_VERTEX_COLOR_SCHEDULED: '1',
      FORGEAX_VERTEX_COLOR_BATCH: '1',
      ...(Object.keys(falsifierOutputPaths).length === 0
        ? {}
        : {
            FORGEAX_VERTEX_COLOR_FALSIFIER_OUTPUTS: JSON.stringify(falsifierOutputPaths),
            VITE_FORGEAX_VERTEX_COLOR_FALSIFIER_OUTPUTS: JSON.stringify(falsifierOutputPaths),
          }),
      ...(Object.keys(outputUrls).length === 0
        ? {}
        : { VITE_FORGEAX_VERTEX_COLOR_OUTPUT_URLS: JSON.stringify(outputUrls) }),
      ...(Object.keys(falsifierOutputUrls).length === 0
        ? {}
        : { VITE_FORGEAX_VERTEX_COLOR_FALSIFIER_OUTPUT_URLS: JSON.stringify(falsifierOutputUrls) }),
    },
  };
}

export function browserOutputReceiverCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
  };
}

function writeBrowserReceiverResponse(response, status, body = '') {
  response.writeHead(status, browserOutputReceiverCorsHeaders()).end(body);
}

async function createBrowserOutputReceiver() {
  const server = createServer((request, response) => {
    if (request.method === 'OPTIONS') {
      writeBrowserReceiverResponse(response, 204);
      return;
    }
    if (request.method !== 'POST') {
      writeBrowserReceiverResponse(response, 404);
      return;
    }
    const target = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('path');
    if (target === null || target.length === 0) {
      writeBrowserReceiverResponse(response, 400, 'missing output path');
      return;
    }
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        JSON.parse(body);
        writeFileSync(target, `${JSON.stringify(JSON.parse(body), null, 2)}\n`);
        writeBrowserReceiverResponse(response, 204);
      } catch (error) {
        writeBrowserReceiverResponse(response, 400, String(error));
      }
    });
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('browser producer receiver did not bind');
  return {
    urlFor(outputPath) {
      return `http://127.0.0.1:${address.port}/vertex-color-output?path=${encodeURIComponent(outputPath)}`;
    },
    close() {
      return new Promise((resolvePromise) => server.close(resolvePromise));
    },
  };
}

function executeCommand({ command, args, env, cwd }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    child.once('error', (error) => resolvePromise({ ok: false, reason: error.message }));
    child.once('exit', (code, signal) => {
      resolvePromise(
        code === 0
          ? { ok: true }
          : { ok: false, reason: `${command} exited with ${signal ?? `status ${code}`}` },
      );
    });
  });
}

function readFixture(fixtureRoot, caseId) {
  return JSON.parse(readFileSync(resolve(fixtureRoot, `${caseId}.json`), 'utf8'));
}

function semanticExpectedSamples(fixture) {
  const vertices =
    Array.isArray(fixture.vertices) && fixture.vertices.length >= 3
      ? fixture.vertices.map((vertex) => [
          Number(vertex[0] ?? 1),
          Number(vertex[1] ?? 1),
          Number(vertex[2] ?? 1),
          Number(vertex[3] ?? 1),
        ])
      : fixture.caseId === 'vertex-color-normalized'
        ? [
            [0, 0, 0, 1],
            [0.5, 0.5, 0.5, 1],
            [1, 1, 1, 1],
          ]
        : fixture.caseId === 'vertex-color-mask-taa'
          ? [
              [1, 0.1, 0.1, 0.35],
              [1, 0.1, 0.1, 0.65],
              [1, 0.1, 0.1, 0.35],
            ]
          : fixture.caseId === 'vertex-color-mixed-primitives'
            ? [
                [1, 0, 0, 1],
                [0, 1, 0, 1],
                [0, 0, 1, 1],
              ]
            : [
                [1, 1, 1, 1],
                [1, 1, 1, 1],
                [1, 1, 1, 1],
              ];
  const average = (selected) =>
    selected.reduce(
      (sum, vertex) => sum.map((value, index) => value + vertex[index] / selected.length),
      [0, 0, 0, 0],
    );
  return fixture.samplePoints.map((sample) => {
    const id = String(sample.id);
    let rgba;
    if (id === 'plain-primitive' || id === 'baseline-centroid' || id === 'background') {
      rgba = [1, 1, 1, 1];
    } else if (id === 'cutout-edge') {
      rgba = vertices[0];
    } else if (id === 'history-interior') {
      rgba = vertices[1];
    } else if (id === 'vertex-a' || id === 'normalized-endpoint' || id === 'colored-primitive') {
      rgba = vertices[0];
    } else if (id === 'normalized-midpoint') {
      rgba = vertices[1];
    } else if (id === 'edge-midpoint') {
      rgba = average(vertices.slice(0, 2));
    } else {
      rgba = average(vertices);
    }
    return { id, coordinate: sample.coordinate, rgba };
  });
}

export async function runVertexColorProducerSchedule({
  root,
  fixtureRoot = resolve(root, 'apps/parity/color-lighting/cases/vertex-color'),
  reportRoot = resolve(root, 'report/color-lighting-parity/vertex-color'),
  invocationId,
  sourceSha,
  execute = executeCommand,
}) {
  const loadTypeScript = jiti(import.meta.url);
  const { VERTEX_COLOR_REQUIRED_CASES } = await loadTypeScript.import(
    resolve(root, 'apps/parity/color-lighting/src/coverage/required-cases.ts'),
  );
  const { createVertexColorNamedCapture } = await loadTypeScript.import(
    resolve(root, 'apps/parity/color-lighting/src/capture/named-capture.ts'),
  );
  const { evaluateVertexColorCase } = await loadTypeScript.import(
    resolve(root, 'apps/parity/color-lighting/src/evaluator/evaluate-case.ts'),
  );
  const attempts = [];
  const physicalBatches = [];
  const blocked = [];
  const failures = [];
  const receiver = execute === executeCommand ? await createBrowserOutputReceiver() : undefined;
  const cells = new Map();
  const producerReasons = new Map();
  for (const backend of VERTEX_COLOR_BACKENDS) {
    for (const caseId of VERTEX_COLOR_CASE_IDS) {
      const fixture = readFixture(fixtureRoot, caseId);
      const sourceFixtureHash = VERTEX_COLOR_REQUIRED_CASES.find(
        (entry) => entry.caseId === caseId,
      )?.sourceFixtureHash;
      if (sourceFixtureHash === undefined)
        throw new Error(`missing required vertex-color fixture hash for ${caseId}`);
      const reportPath = resolve(reportRoot, backend, `${caseId}.json`);
      mkdirSync(resolve(reportRoot, backend), { recursive: true });
      rmSync(reportPath, { force: true });
      const outputPaths = {};
      const falsifierOutputPaths = {};
      for (const producer of PRODUCERS) {
        const outputPath = resolve(
          reportRoot,
          backend,
          `${caseId}.${producer.implementation}.capture.json`,
        );
        outputPaths[producer.implementation] = outputPath;
        rmSync(outputPath, { force: true });
        const falsifierOutputPath =
          producer.implementation === 'forgeax'
            ? resolve(reportRoot, backend, `${caseId}.forgeax.falsifier.capture.json`)
            : undefined;
        if (falsifierOutputPath !== undefined) {
          falsifierOutputPaths[producer.implementation] = falsifierOutputPath;
          rmSync(falsifierOutputPath, { force: true });
        }
      }
      cells.set(`${backend}/${caseId}`, {
        backend,
        caseId,
        fixture,
        reportPath,
        outputPaths,
        falsifierOutputPaths,
        sourceFixtureHash,
      });
    }
  }
  const batchPlans = [
    {
      backend: 'browser-webgpu',
      batchId: 'browser-webgpu/combined',
      producerEnv: 'combined',
      producers: PRODUCERS,
      testEntries: PRODUCERS.map((producer) => producer.testEntry.browser),
    },
    {
      backend: 'dawn',
      batchId: 'dawn/forgeax',
      producerEnv: 'forgeax',
      producers: [PRODUCERS[0]],
      testEntries: [PRODUCERS[0].testEntry.dawn],
    },
    {
      backend: 'dawn',
      batchId: 'dawn/three',
      producerEnv: 'three',
      producers: [PRODUCERS[1]],
      testEntries: [PRODUCERS[1].testEntry.dawn],
    },
  ];
  for (const plan of batchPlans) {
    const batchCells = VERTEX_COLOR_CASE_IDS.map((caseId) =>
      cells.get(`${plan.backend}/${caseId}`),
    );
    const outputPathsByProducer = Object.fromEntries(
      plan.producers.map((producer) => [
        producer.implementation,
        Object.fromEntries(
          batchCells.map((cell) => [cell.caseId, cell.outputPaths[producer.implementation]]),
        ),
      ]),
    );
    const defaultProducer = plan.producers[0];
    const outputPaths = outputPathsByProducer[defaultProducer.implementation];
    const falsifierOutputPaths = plan.producers.some(
      (producer) => producer.implementation === 'forgeax',
    )
      ? Object.fromEntries(
          batchCells.map((cell) => [cell.caseId, cell.falsifierOutputPaths.forgeax]),
        )
      : {};
    const allOutputPaths = Object.values(outputPathsByProducer).flatMap((paths) =>
      Object.values(paths),
    );
    const outputUrls =
      plan.backend === 'browser-webgpu' && receiver !== undefined
        ? Object.fromEntries(
            allOutputPaths.map((outputPath) => [outputPath, receiver.urlFor(outputPath)]),
          )
        : {};
    const falsifierOutputUrls =
      plan.backend === 'browser-webgpu' && receiver !== undefined
        ? Object.fromEntries(
            Object.values(falsifierOutputPaths).map((outputPath) => [
              outputPath,
              receiver.urlFor(outputPath),
            ]),
          )
        : {};
    const command = commandFor(
      defaultProducer,
      plan.backend,
      VERTEX_COLOR_CASE_IDS,
      outputPaths,
      sourceSha,
      outputUrls,
      falsifierOutputPaths,
      falsifierOutputUrls,
      {
        outputPathsByProducer: plan.producers.length === 1 ? undefined : outputPathsByProducer,
        producerEnv: plan.producerEnv,
        testEntries: plan.testEntries,
      },
    );
    const result = await execute({ ...command, cwd: root });
    physicalBatches.push({
      batchId: plan.batchId,
      backend: plan.backend,
      producer: plan.producerEnv,
      producers: plan.producers.map((producer) => producer.implementation),
      caseIds: [...VERTEX_COLOR_CASE_IDS],
      command: [command.command, ...command.args],
      exit: result.ok ? 0 : 1,
      ...(result.ok ? {} : { reason: result.reason }),
    });
    for (const producer of plan.producers) {
      for (const cell of batchCells) {
        const outputPath = cell.outputPaths[producer.implementation];
        const falsifierOutputPath = cell.falsifierOutputPaths[producer.implementation];
        let reason;
        if (!result.ok) {
          reason = `${producer.implementation}: producer-entry-missing or runtime failure (${result.reason})`;
        } else if (!readFileExists(outputPath)) {
          reason = `${producer.implementation}: producer-entry-missing: producer did not publish a capture`;
        } else if (falsifierOutputPath !== undefined && !readFileExists(falsifierOutputPath)) {
          reason = `${producer.implementation}: bounded falsifier sidecar did not publish a capture`;
        }
        if (reason !== undefined)
          producerReasons.set(`${cell.backend}/${cell.caseId}/${producer.implementation}`, reason);
        attempts.push({
          caseId: cell.caseId,
          backend: cell.backend,
          producer: producer.implementation,
          batchId: plan.batchId,
          command: [command.command, ...command.args],
          exit: result.ok ? 0 : 1,
        });
      }
    }
  }
  for (const cell of cells.values()) {
    let reason =
      producerReasons.get(`${cell.backend}/${cell.caseId}/forgeax`) ??
      producerReasons.get(`${cell.backend}/${cell.caseId}/three`);
    if (reason === undefined) {
      try {
        const forgeaxOutput = JSON.parse(readFileSync(cell.outputPaths.forgeax, 'utf8'));
        const threeOutput = JSON.parse(readFileSync(cell.outputPaths.three, 'utf8'));
        const forgeaxCapture = await createVertexColorNamedCapture(
          cell.fixture,
          producerIdentity(PRODUCERS[0], sourceSha),
          forgeaxOutput,
        );
        const threeCapture = await createVertexColorNamedCapture(
          cell.fixture,
          producerIdentity(PRODUCERS[1], sourceSha),
          threeOutput,
        );
        const forgeaxFalsifierOutput = JSON.parse(
          readFileSync(cell.falsifierOutputPaths.forgeax, 'utf8'),
        );
        const falsifier =
          cell.caseId === 'vertex-color-no-color-baseline'
            ? {
                kind: 'no-color-baseline',
                baselineFinal: forgeaxOutput.final,
                observedFinal: forgeaxFalsifierOutput.final,
                colorStreamBytes: 0,
              }
            : { kind: 'white-color', samples: forgeaxFalsifierOutput.samples };
        const evaluated = evaluateVertexColorCase({
          caseId: cell.caseId,
          fixture: cell.fixture,
          invocationId,
          backend: cell.backend,
          sourceSha,
          expectedSamples: semanticExpectedSamples(cell.fixture),
          forgeax: forgeaxCapture,
          three: threeCapture,
          falsifier,
          artifacts: [
            `artifact://color-lighting-parity/${invocationId}/${cell.backend}/${cell.caseId}/forgeax`,
            `artifact://color-lighting-parity/${invocationId}/${cell.backend}/${cell.caseId}/three`,
          ],
        });
        if (!evaluated.ok) {
          if (evaluated.value !== undefined) {
            // An evaluator verdict is a real comparison result, not a missing
            // producer. Preserve its samples, falsifier, and budget detail in
            // the case report so the scheduler does not relabel a regression
            // as an unavailable/blocked capture.
            writeFileSync(cell.reportPath, `${JSON.stringify(evaluated.value, null, 2)}\n`);
            failures.push({
              caseId: cell.caseId,
              backend: cell.backend,
              reportPath: cell.reportPath,
              code: evaluated.error.code,
              detail: evaluated.error.detail,
            });
          } else {
            reason = `${cell.caseId}: vertex-color evaluator rejected scheduler captures (${evaluated.error.code})`;
          }
        } else writeFileSync(cell.reportPath, `${JSON.stringify(evaluated.value, null, 2)}\n`);
      } catch (error) {
        reason = `${cell.caseId}: vertex-color report construction failed (${error instanceof Error ? error.message : String(error)})`;
      }
    }
    if (reason !== undefined) {
      const report = blockedReport({
        caseId: cell.caseId,
        backend: cell.backend,
        invocationId,
        sourceSha,
        sourceFixtureHash: cell.sourceFixtureHash,
        fixture: cell.fixture,
        reason,
      });
      writeFileSync(cell.reportPath, `${JSON.stringify(report, null, 2)}\n`);
      blocked.push({
        caseId: cell.caseId,
        backend: cell.backend,
        reason,
        reportPath: cell.reportPath,
      });
    }
  }
  await receiver?.close();
  const receipt = {
    schemaVersion: 1,
    invocationId,
    sourceSha,
    attempts,
    physicalBatches,
    blocked,
    failures,
    combinations: VERTEX_COLOR_CASE_IDS.length * VERTEX_COLOR_BACKENDS.length,
    logicalCells: VERTEX_COLOR_CASE_IDS.length * VERTEX_COLOR_BACKENDS.length * PRODUCERS.length,
    physicalBatchCount: physicalBatches.length,
  };
  mkdirSync(reportRoot, { recursive: true });
  writeFileSync(
    resolve(reportRoot, 'dispatch-receipt.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  return {
    ok: blocked.length === 0 && failures.length === 0,
    attempts,
    blocked,
    failures,
    receipt,
  };
}

function readFileExists(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
